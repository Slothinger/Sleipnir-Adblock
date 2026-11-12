// Filter data loading: manifest -> content-addressed generic files + per-site shards.

import { decodeHashSet, shardIndex, shardLabels } from './shared/host.js';
import { cacheGet, cacheSet, cacheClear } from './cache.js';
import { FILTER_BASE, FORMAT_VERSION, httpGetText, now } from './env.js';

const HOUR = 3600e3;
const MANIFEST_TTL = 6 * HOUR;
// Big generic files are re-downloaded only when renamed AND the cached copy is this old; their content
// changes daily but is nearly identical, and every site keeps its own copy.
const GENERIC_MAX_AGE = { g: 3 * 24 * HOUR, n: 3 * 24 * HOUR, c: 3 * 24 * HOUR, a: 2 * 24 * HOUR };

async function getJson(path, opts) {
    return JSON.parse(await httpGetText(FILTER_BASE + path, opts));
}

export async function loadManifest(force = false) {
    const cached = await cacheGet('manifest');
    if (!force && cached && now() - cached.t < MANIFEST_TTL) return cached.data;
    try {
        const data = await getJson('f/manifest.json', { revalidate: true });
        if (data.v !== FORMAT_VERSION) throw new Error('unsupported filter format ' + data.v);
        await cacheSet('manifest', { data, t: now() });
        return data;
    } catch (e) {
        if (cached) return cached.data;
        throw e;
    }
}

const decoders = {
    n: (d) => ({ block: decodeHashSet(d.block), allow: decodeHashSet(d.allow), popup: decodeHashSet(d.popup) }),
};

/** @param slot 'g' | 'n' | 'c' | 'a' */
export async function loadGeneric(manifest, slot, force = false) {
    const name = manifest[slot];
    const key = 'file:' + slot;
    const cached = await cacheGet(key);
    if (!force && cached && (cached.name === name || now() - cached.t < GENERIC_MAX_AGE[slot])) return cached.data;
    try {
        const raw = await getJson('f/' + name);
        const data = decoders[slot] ? decoders[slot](raw) : raw;
        await cacheSet(key, { name, t: now(), data });
        return data;
    } catch (e) {
        if (cached) return cached.data;
        throw e;
    }
}

async function loadShard(manifest, index) {
    const key = 'shard:' + index;
    const cached = await cacheGet(key);
    if (cached && cached.dir === manifest.s) return cached.data;
    const data = await getJson('f/' + manifest.s + '/' + index + '.json');
    await cacheSet(key, { dir: manifest.s, data });
    return data;
}

/** Merged shard data for `host`: { k: {domainKey: rules}, t: [hosts], ac: [compact rulesets] } */
export async function loadSiteData(manifest, host) {
    const indexes = [...new Set(shardLabels(host).map((l) => shardIndex(l, manifest.sc)))];
    const shards = await Promise.all(indexes.map((i) => loadShard(manifest, i)));
    const merged = { k: {}, t: [], ac: [] };
    for (const s of shards) {
        Object.assign(merged.k, s.k);
        if (s.t) merged.t.push(...s.t);
        if (s.ac) merged.ac.push(s.ac);
    }
    return merged;
}

/**
 * Everything the page needs. Shard 404s mean our manifest is older than the deployed files:
 * refresh the manifest once and retry.
 */
export async function loadAll(host, { force = false } = {}) {
    if (force) await cacheClear();
    let manifest = await loadManifest(force);
    let site;
    try {
        site = await loadSiteData(manifest, host);
    } catch {
        manifest = await loadManifest(true);
        site = await loadSiteData(manifest, host).catch(() => ({ k: {}, t: [], ac: [] }));
    }
    return { manifest, site };
}
