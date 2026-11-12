import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from '../tools/build-filters.mjs';
import { escapePercentSequences } from '../tools/build-ext.mjs';
import { hostsFromUrlPattern } from '../tools/lib/urlpattern.mjs';
import { decodeHashSet, encodeHashSet, hashSetHas, shardIndex, shardLabels } from '../src/shared/host.js';
import { adSelectors, allowBits, siteRules, FLAG_GENERICHIDE } from '../src/rules.js';
import { NetMatcher } from '../src/network.js';

const EASYLIST = `[Adblock Plus 2.0]
! *** easylist:easylist/easylist_general_hide.txt ***
##.ad-banner
##.sponsor-box
##div:-abp-has(> .ad-label)
##.text-ad:-abp-contains(Anzeige)
example.com#@#.sponsor-box
spiegel.de##.spiegel-ad
~m.spiegel.de,spiegel.de##.desktop-only-ad
example.*##.entity-ad
bbc.co.uk##.bbc-ad
go.com##.go-ad
spiegel.de#$#abort-on-property-read foo
broken.com##div[class="x
! *** easylist:easylist/easylist_adservers.txt ***
||adserver.example^
||tracker.example^$third-party
||cdn-ads.example^$script,image
||popunder.example^$popup
||onlyon.example^$domain=news.de|~sport.news.de
||weird.example^$csp=script-src 'none'
||firstparty.example^$~third-party
@@||adserver.example^$domain=partner.de
@@||good.adserver2.example^
||adserver2.example^
@@||nogeneric.de^$generichide
@@||trusted.de^$document
@@||adserver.example/player.js$script,domain=video.de
||pubhost.example^
@@||sdk.pubhost.example/ima3.js$script
`;
const EASYPRIVACY = `! *** easylist:easyprivacy/easyprivacy_specific_cname_adobe.txt ***
||smetrics.shop.de^
`;

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), 'shield-'));
    const lists = path.join(dir, 'lists');
    await mkdir(lists);
    await writeFile(path.join(lists, 'easylist.txt'), EASYLIST);
    await writeFile(path.join(lists, 'easylistgermany.txt'), 'deutschland.de##.werbung\n');
    await writeFile(path.join(lists, 'easyprivacy.txt'), EASYPRIVACY);
    await writeFile(path.join(lists, 'cookies.txt'), '##.cookie-banner\nexample.com##.cookie-wall\n');
    const out = path.join(dir, 'f');
    const { manifest } = await build({ offlineDir: lists, outDir: out });
    const read = async (name) => JSON.parse(await readFile(path.join(out, name), 'utf8'));
    const generic = await read(manifest.g);
    const net = await read(manifest.n);
    const sets = { block: decodeHashSet(net.block), allow: decodeHashSet(net.allow), popup: decodeHashSet(net.popup) };
    // the same shard selection the extension does (src/data.js loadSiteData)
    const siteFor = async (host) => {
        const merged = { k: {}, t: [], ac: [] };
        for (const i of new Set(shardLabels(host).map((l) => shardIndex(l, manifest.sc)))) {
            const s = await read(`${manifest.s}/${i}.json`);
            Object.assign(merged.k, s.k);
            if (s.t) merged.t.push(...s.t);
            if (s.ac) merged.ac.push(s.ac);
        }
        return merged;
    };
    const cookies = await read(manifest.c);
    return { manifest, generic, sets, siteFor, cookies };
}

const fx = fixture();
const noCfg = { ads: true, cookies: true, hide: [], unhide: [] };

async function selectorsFor(host, cfg = noCfg) {
    const { generic, siteFor } = await fx;
    const site = await siteFor(host);
    return adSelectors(generic.css, siteRules(site, generic.tk, host), cfg);
}

async function matcherFor(pageHost) {
    const { generic, sets, siteFor } = await fx;
    const site = await siteFor(pageHost);
    globalThis.location = { href: `https://${pageHost}/` };
    return new NetMatcher(sets, siteRules(site, generic.tk, pageHost), site.t, pageHost);
}

test('generic hiding applies everywhere, procedural and broken selectors are dropped', async () => {
    const sels = await selectorsFor('random-site.org');
    assert.ok(sels.includes('.ad-banner'));
    assert.ok(sels.includes('div:has(> .ad-label)'), ':-abp-has is converted to native :has');
    assert.ok(!sels.some((s) => s.includes('contains')));
    assert.ok(!sels.some((s) => s.includes('class="x')));
});

test('site-specific rules reach subdomains, entity and SLD hosts', async () => {
    assert.ok((await selectorsFor('www.spiegel.de')).includes('.spiegel-ad'));
    assert.ok((await selectorsFor('www.spiegel.de')).includes('.desktop-only-ad'));
    assert.ok(!(await selectorsFor('m.spiegel.de')).includes('.desktop-only-ad'), '~m.spiegel.de negation');
    assert.ok((await selectorsFor('shop.example.co.uk')).includes('.entity-ad'), 'example.* entity');
    assert.ok((await selectorsFor('www.bbc.co.uk')).includes('.bbc-ad'));
    assert.ok((await selectorsFor('www.go.com')).includes('.go-ad'), 'key under SLD-looking label');
    assert.ok((await selectorsFor('www.deutschland.de')).includes('.werbung'));
    assert.ok(!(await selectorsFor('www.zeit.de')).includes('.spiegel-ad'));
});

test('exceptions: #@#, $generichide, per-site unhide and user hides', async () => {
    assert.ok(!(await selectorsFor('www.example.com')).includes('.sponsor-box'));
    const ng = await selectorsFor('www.nogeneric.de');
    assert.ok(!ng.includes('.ad-banner'));
    const cfg = { ...noCfg, hide: ['#my-annoyance'], unhide: ['.ad-banner'] };
    const sels = await selectorsFor('random-site.org', cfg);
    assert.ok(sels.includes('#my-annoyance'));
    assert.ok(!sels.includes('.ad-banner'));
});

test('$document exception is reported as a site flag', async () => {
    const { generic, siteFor } = await fx;
    const rules = siteRules(await siteFor('www.trusted.de'), generic.tk, 'www.trusted.de');
    assert.equal(rules.flags & 4, 4);
    const ng = siteRules(await siteFor('nogeneric.de'), generic.tk, 'nogeneric.de');
    assert.equal(ng.flags & FLAG_GENERICHIDE, FLAG_GENERICHIDE);
});

test('network blocking: generic hosts, exceptions, same-site and site-specific rules', async () => {
    const m = await matcherFor('www.news.de');
    assert.equal(m.blocks('https://adserver.example/x.js'), true);
    assert.equal(m.blocks('https://sub.adserver.example/x.js'), true, 'subdomains of blocked hosts');
    assert.equal(m.blocks('https://tracker.example/p'), true);
    assert.equal(m.blocks('https://cdn-ads.example/p'), true);
    assert.equal(m.blocks('https://good.adserver2.example/'), false, '@@ exception beats parent block');
    assert.equal(m.blocks('https://x.adserver2.example/'), true);
    assert.equal(m.blocks('https://weird.example/'), false, '$csp rules are not blocking rules');
    assert.equal(m.blocks('https://firstparty.example/'), false);
    assert.equal(m.blocks('https://onlyon.example/'), true, '$domain=news.de');
    assert.equal(m.blocks('https://unrelated.example/'), false);
    assert.equal(m.blocks('/relative/ad.js'), false);
    assert.equal(m.blocks('https://popunder.example/'), false, 'popup-only rule does not block requests');
    assert.equal(m.blocks('https://popunder.example/', true), true, 'but blocks window.open');

    assert.equal((await matcherFor('sport.news.de')).blocks('https://onlyon.example/'), false, '~sport.news.de');
    assert.equal((await matcherFor('www.partner.de')).blocks('https://adserver.example/'), false, '@@$domain=partner.de');
    assert.equal((await matcherFor('ads.adserver.example')).blocks('https://adserver.example/'), false, 'first-party');
});

test('path exceptions allow the whole host where EasyList needs a path', async () => {
    assert.equal((await matcherFor('www.video.de')).blocks('https://adserver.example/player.js'), false);
    const m = await matcherFor('www.other.de');
    assert.equal(m.blocks('https://adserver.example/player.js'), true);
    assert.equal(m.blocks('https://sdk.pubhost.example/ima3.js'), false, 'global path exception');
    assert.equal(m.blocks('https://pubhost.example/ads.js'), true);
});

test('CNAME tracker subdomains are blocked on their own site', async () => {
    assert.equal((await matcherFor('www.shop.de')).blocks('https://smetrics.shop.de/b/ss'), true);
    assert.equal((await matcherFor('www.shop.de')).blocks('https://www.shop.de/api'), false);
});

test('cookie list goes to its own file and site rules, never to network blocking', async () => {
    const { cookies, siteFor, generic } = await fx;
    assert.deepEqual(cookies.css, ['.cookie-banner']);
    const rules = siteRules(await siteFor('www.example.com'), generic.tk, 'www.example.com');
    assert.deepEqual(rules.cookieHide, ['.cookie-wall']);
    assert.ok(!(await selectorsFor('random.org')).includes('.cookie-banner'), 'cookie hiding waits for the reject attempt');
});

test('global allowlist bits match subdomains', () => {
    const allow = { 'bank.de': 3, 'shop.example': 2 };
    assert.equal(allowBits(allow, 'online.bank.de'), 3);
    assert.equal(allowBits(allow, 'shop.example'), 2);
    assert.equal(allowBits(allow, 'notbank.de'), 0);
});

test('autoconsent rules are sharded so a site gets its specific rules', async () => {
    const { siteFor } = await fx;
    const site = await siteFor('www.abc.net.au');
    const names = site.ac.flatMap((set) => set.r.map((r) => r[1]));
    assert.ok(names.includes('abc'), `abc rule present, got ${names.join(',')}`);
});

test('hash sets round-trip', () => {
    const values = [0, 1, 4294967295, 123456789, 99, 100];
    for (let i = 0; i < 5000; i++) values.push(Math.floor(Math.random() * 4294967296));
    const set = decodeHashSet(encodeHashSet(values));
    for (const v of values) assert.ok(hashSetHas(set, v));
    assert.ok(!hashSetHas(set, 2) || values.includes(2));
    assert.equal(decodeHashSet(encodeHashSet([])).length, 0);
});

test('urlPattern host extraction', () => {
    assert.deepEqual(hostsFromUrlPattern('^https?://(www\\.)?(envoyair|psaairlines)\\.com/'), ['envoyair.com', 'psaairlines.com']);
    assert.deepEqual(hostsFromUrlPattern('^https://([a-z0-9-]+\\.)?abc\\.net\\.au/'), ['abc.net.au']);
    assert.deepEqual(hostsFromUrlPattern('^https://(accurx\\.nhs\\.uk|patient\\.accurx\\.com)/'), ['accurx.nhs.uk', 'patient.accurx.com']);
    assert.deepEqual(hostsFromUrlPattern('^https://(www\\.)?activobank\\.pt'), ['activobank.pt']);
    assert.equal(hostsFromUrlPattern('^https://.*/consent'), null);
});

test('percent sequences are escaped for javascript: URLs', () => {
    const src = 'var a = "x%3Dy", b = /%20/, c = 5 % 2;';
    const out = escapePercentSequences(src);
    assert.ok(!/%[0-9A-Fa-f]{2}/.test(out));
    const fn = new Function(out + 'return [a, b.source, c];');
    const [a, b, c] = fn();
    assert.equal(a, 'x%3Dy');
    assert.ok(new RegExp(b).test('%20'));
    assert.equal(c, 1);
});
