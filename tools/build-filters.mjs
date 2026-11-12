#!/usr/bin/env node
// Downloads the configured filter lists and autoconsent rules and compiles them into the sharded
// JSON files the extension fetches (public/f/...).
//
//   node tools/build-filters.mjs [--offline <dir>]
//
// --offline <dir>: read lists from <dir>/<id>.txt instead of downloading (tests, CI caching).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeHashSet, fnv1a, shardIndex, shardLabel } from '../src/shared/host.js';
import { FilterCompiler, toAsciiHost } from './lib/filters.mjs';
import { hostsFromUrlPattern } from './lib/urlpattern.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'f');
export const SHARD_COUNT = 512;
export const FORMAT_VERSION = 1;

const require = createRequire(import.meta.url);

function sha(data) {
    return createHash('sha256').update(data).digest('hex').slice(0, 12);
}

async function download(url) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'sleipnir-shield-builder' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            if (text.length < 1000) throw new Error('suspiciously short list');
            return text;
        } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
    }
    throw new Error(`download failed: ${url}: ${lastErr.message}`);
}

/** config/allowlist.txt -> { "host": bits } with 1 = ads, 2 = cookies */
export function parseAllowlist(text) {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) continue;
        const [domain, ...features] = line.split(/\s+/);
        const host = toAsciiHost(domain.replace(/^\*\./, ''));
        if (!host) throw new Error(`allowlist: invalid domain "${domain}"`);
        let bits = 0;
        for (const f of features.length ? features : ['ads', 'cookies']) {
            if (f === 'ads') bits |= 1;
            else if (f === 'cookies') bits |= 2;
            else throw new Error(`allowlist: unknown feature "${f}" (use ads or cookies)`);
        }
        out[host] = (out[host] || 0) | bits;
    }
    return out;
}

function sorted(set) {
    return [...set].sort();
}

function siteToJson(s) {
    const o = {};
    if (s.h.size) o.h = sorted(s.h);
    if (s.x.size) o.x = sorted(s.x);
    if (s.c.size) o.c = sorted(s.c);
    if (s.b.size) o.b = sorted(s.b);
    if (s.a.size) o.a = sorted(s.a);
    if (s.f) o.f = s.f;
    return o;
}

export function splitAutoconsent(rules, encodeRules) {
    const generic = [];
    const byLabel = new Map();
    for (const rule of rules) {
        const pattern = rule.runContext && rule.runContext.urlPattern;
        if (rule.runContext && rule.runContext.main === false) continue; // frame-only rules: Sleipnir injects into the top frame only
        if (!pattern) {
            generic.push(rule);
            continue;
        }
        const hosts = hostsFromUrlPattern(pattern);
        if (!hosts) {
            generic.push(rule);
            continue;
        }
        for (const label of new Set(hosts.map(shardLabel))) {
            if (!byLabel.has(label)) byLabel.set(label, []);
            byLabel.get(label).push(rule);
        }
    }
    return { generic: encodeRules(generic, null), byLabel };
}

export async function build({ offlineDir = null, outDir = OUT } = {}) {
    const lists = JSON.parse(await readFile(path.join(ROOT, 'config', 'lists.json'), 'utf8'));
    const settings = JSON.parse(await readFile(path.join(ROOT, 'config', 'settings.json'), 'utf8'));
    const allow = parseAllowlist(await readFile(path.join(ROOT, 'config', 'allowlist.txt'), 'utf8'));
    const userFilters = await readFile(path.join(ROOT, 'config', 'userfilters.txt'), 'utf8');

    const compiler = new FilterCompiler();
    const listInfo = [];
    for (const list of lists.filter((l) => l.enabled)) {
        const text = offlineDir ? await readFile(path.join(offlineDir, `${list.id}.txt`), 'utf8') : await download(list.url);
        const version = (/^!\s*Version:\s*(.+)$/m.exec(text) || [])[1] || null;
        compiler.addList(text, list.kind, {
            specificOnly: !!list.specificOnly,
            skipSections: list.skipSections ? new RegExp(list.skipSections) : null,
        });
        listInfo.push({ id: list.id, title: list.title, version });
    }
    compiler.addList(userFilters, 'ads');
    compiler.finish();

    const ac = require('@duckduckgo/autoconsent');
    const acRules = require('@duckduckgo/autoconsent/rules/rules.json').autoconsent;
    const acVersion = JSON.parse(await readFile(path.join(ROOT, 'node_modules/@duckduckgo/autoconsent/package.json'), 'utf8')).version;
    const acSplit = splitAutoconsent(acRules, ac.encodeRules);

    // Shards: per-domain cosmetic/network rules, same-site tracker hosts, site-specific autoconsent rules.
    const shards = Array.from({ length: SHARD_COUNT }, () => ({ k: {}, t: [], acRules: [] }));
    const tldKeys = {};
    for (const [key, site] of compiler.sites) {
        const json = siteToJson(site);
        if (!Object.keys(json).length) continue;
        if (!key.includes('.')) {
            tldKeys[key] = json;
            continue;
        }
        shards[shardIndex(shardLabel(key), SHARD_COUNT)].k[key] = json;
    }
    // CNAME lists also contain vendor subdomains (x.actonservice.com) that are third-party everywhere:
    // a label with that many entries is a vendor, not a site, so those go into the generic set.
    const perLabel = new Map();
    for (const host of compiler.firstPartyTrackers) {
        const label = shardLabel(host);
        if (!perLabel.has(label)) perLabel.set(label, []);
        perLabel.get(label).push(host);
    }
    for (const [label, hosts] of perLabel) {
        if (hosts.length >= 500) for (const h of hosts) !compiler.netAllow.has(h) && compiler.netBlock.add(h);
        else shards[shardIndex(label, SHARD_COUNT)].t.push(...hosts);
    }
    for (const [label, rules] of acSplit.byLabel) shards[shardIndex(label, SHARD_COUNT)].acRules.push(...rules);

    const shardFiles = shards.map((s) => {
        const keys = Object.keys(s.k).sort();
        const out = { k: Object.fromEntries(keys.map((k) => [k, s.k[k]])) };
        if (s.t.length) out.t = s.t.sort();
        if (s.acRules.length) out.ac = ac.encodeRules([...new Set(s.acRules)], null);
        return JSON.stringify(out);
    });
    const shardDir = 's-' + sha(shardFiles.join('\n'));

    // Generic files are content-addressed: clients keep a cached copy until the name changes
    // (and, for the big ones, until their copy is a few days old).
    const files = {};
    const addFile = (prefix, data) => {
        const json = JSON.stringify(data);
        const name = `${prefix}-${sha(json)}.json`;
        files[name] = json;
        return name;
    };
    const manifest = {
        v: FORMAT_VERSION,
        built: new Date().toISOString(),
        sc: SHARD_COUNT,
        g: addFile('g', { css: sorted(compiler.genericHide), tk: tldKeys }),
        n: addFile('n', {
            block: encodeHashSet([...compiler.netBlock].map(fnv1a)),
            allow: encodeHashSet([...compiler.netAllow].map(fnv1a)),
            popup: encodeHashSet([...compiler.popupBlock].map(fnv1a)),
        }),
        c: addFile('c', { css: sorted(compiler.genericCookieHide) }),
        a: addFile('a', acSplit.generic),
        s: shardDir,
        allow,
        settings,
        lists: listInfo,
        autoconsent: acVersion,
    };

    await rm(outDir, { recursive: true, force: true });
    await mkdir(path.join(outDir, shardDir), { recursive: true });
    for (const [name, json] of Object.entries(files)) await writeFile(path.join(outDir, name), json);
    await Promise.all(shardFiles.map((s, i) => writeFile(path.join(outDir, shardDir, `${i}.json`), s)));
    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));

    const stats = {
        genericSelectors: compiler.genericHide.size,
        cookieSelectors: compiler.genericCookieHide.size,
        blockedHosts: compiler.netBlock.size,
        allowedHosts: compiler.netAllow.size,
        popupHosts: compiler.popupBlock.size,
        firstPartyTrackers: compiler.firstPartyTrackers.size,
        siteKeys: compiler.sites.size,
        autoconsentGeneric: acSplit.generic.r.length,
        autoconsentShardedLabels: acSplit.byLabel.size,
        fileBytes: Object.fromEntries(Object.entries(files).map(([n, j]) => [n[0], j.length])),
        largestShardBytes: Math.max(...shardFiles.map((s) => s.length)),
        ...compiler.stats,
    };
    return { manifest, stats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf('--offline');
    const offlineDir = i !== -1 ? path.resolve(process.argv[i + 1]) : null;
    const { manifest, stats } = await build({ offlineDir });
    console.log(JSON.stringify({ manifest: { ...manifest, allow: Object.keys(manifest.allow).length }, stats }, null, 2));
}
