// Resolves which rules apply to the current host.

import { domainKeys, hostSuffixes } from './shared/host.js';

export const FLAG_GENERICHIDE = 1;
export const FLAG_ELEMHIDE = 2;
export const FLAG_DOCUMENT = 4;
export const FLAG_SPECIFICHIDE = 8;

/** Global allowlist bits for host: 1 = ads off, 2 = cookies off. */
export function allowBits(allow, host) {
    let bits = 0;
    for (const s of hostSuffixes(host)) bits |= allow[s] || 0;
    return bits;
}

/**
 * Collects domain-specific rules for host from shard keys and TLD keys.
 * @returns {{hide: string[], cookieHide: string[], except: Set<string>, block: string[], allow: string[], flags: number}}
 */
export function siteRules(site, tldKeys, host) {
    const out = { hide: [], cookieHide: [], except: new Set(), block: [], allow: [], flags: 0 };
    for (const key of domainKeys(host)) {
        const r = site.k[key] || (tldKeys && tldKeys[key]);
        if (!r) continue;
        if (r.h) out.hide.push(...r.h);
        if (r.c) out.cookieHide.push(...r.c);
        if (r.x) for (const s of r.x) out.except.add(s);
        if (r.b) out.block.push(...r.b);
        if (r.a) out.allow.push(...r.a);
        if (r.f) out.flags |= r.f;
    }
    return out;
}

/** Final ad hiding selector list for the page. */
export function adSelectors(genericCss, rules, siteCfg) {
    if (rules.flags & FLAG_ELEMHIDE) return siteCfg.hide.slice();
    const except = new Set(rules.except);
    for (const s of siteCfg.unhide) except.add(s);
    const out = [];
    const seen = new Set();
    const add = (s) => {
        if (!except.has(s) && !seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    };
    if (!(rules.flags & FLAG_GENERICHIDE)) genericCss.forEach(add);
    if (!(rules.flags & FLAG_SPECIFICHIDE)) rules.hide.forEach(add);
    siteCfg.hide.forEach(add);
    return out;
}

export function cookieSelectors(list, rules, siteCfg) {
    const out = [];
    for (const s of list) if (!rules.except.has(s) && !siteCfg.unhide.includes(s)) out.push(s);
    return out;
}
