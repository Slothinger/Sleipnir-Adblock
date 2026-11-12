// Filter list parser/compiler (ABP / EasyList syntax, subset).
// Output feeds the extension: generic cosmetic selectors, host hash sets and per-domain rules.

import { domainToASCII } from 'node:url';

export const FLAG_GENERICHIDE = 1; // @@||site^$generichide  -> no generic cosmetic rules on site
export const FLAG_ELEMHIDE = 2; //    @@||site^$elemhide     -> no cosmetic rules at all on site
export const FLAG_DOCUMENT = 4; //    @@||site^$document     -> extension fully off on site
export const FLAG_SPECIFICHIDE = 8; // @@||site^$specifichide -> no site-specific cosmetic rules

// Procedural / extended selectors that are not plain CSS (ABP, uBO, AdGuard).
const UNSUPPORTED_SELECTOR =
    /:-abp-(?!has\()|:has-text\(|:contains\(|:matches-(?:css|attr|path|prop|media)|:min-text-length\(|:others\(|:upward\(|:xpath\(|:nth-ancestor\(|:remove(?:-attr|-class)?\(|:style\(|:watch-attr\(|:if(?:-not)?\(|:shadow\(|:spath\(|:-ext-|:matches-css|\[-ext-/;

const NET_TYPES = new Set([
    'script', 'image', 'stylesheet', 'css', 'object', 'xmlhttprequest', 'xhr', 'subdocument', 'frame', 'ping',
    'media', 'font', 'other', 'websocket', 'webrtc', 'beacon', 'object-subrequest', 'all',
]);
const NET_NOOP_OPTIONS = new Set(['third-party', '3p', 'important', 'match-case', 'strict3p']);

function emptySite() {
    return { h: new Set(), x: new Set(), c: new Set(), b: new Set(), a: new Set(), f: 0 };
}

export class FilterCompiler {
    constructor() {
        this.genericHide = new Set();
        this.genericCookieHide = new Set();
        this.globalUnhide = new Set();
        this.netBlock = new Set();
        this.netAllow = new Set();
        this.popupBlock = new Set();
        this.sites = new Map();
        this.firstPartyTrackers = new Set(); // CNAME-cloaked tracker subdomains: same-site, delivered via the site's shard
        this.section = '';
        this.globalPathExceptions = new Set(); // hosts with an "@@||host/path" exception valid everywhere
        this.stats = { cosmetic: 0, network: 0, skipped: 0 };
    }

    site(key) {
        let s = this.sites.get(key);
        if (!s) {
            s = emptySite();
            this.sites.set(key, s);
        }
        return s;
    }

    /**
     * @param kind 'ads' | 'cookies'
     * @param opts.specificOnly only domain-bound hide rules (big lists whose generic part would bloat every page)
     * @param opts.skipSections regex: ignore list sections whose header ("! name.txt" / "! *** name ***") matches
     */
    addList(text, kind, { specificOnly = false, skipSections = null } = {}) {
        this.section = '';
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (line.startsWith('! *** ') || /^! [\w-]+\.txt$/.test(line)) this.section = line;
            if (!line || line[0] === '!' || line[0] === '[') continue;
            if (skipSections && skipSections.test(this.section)) continue;
            if (specificOnly) {
                this.addSpecificHide(line);
                continue;
            }
            if (this.addCosmetic(line, kind)) continue;
            if (kind === 'cookies') continue; // cookie lists: only hide rules; never block CMP scripts we need to talk to
            if (this.addNetwork(line)) this.stats.network++;
            else this.stats.skipped++;
        }
    }

    /** "a.com,~b.a.com##sel" only; everything else is ignored. */
    addSpecificHide(line) {
        const m = /^([^#]+?)##(.+)$/.exec(line);
        const selector = m && normalizeSelector(m[2]);
        const domains = selector && parseDomains(m[1], ',');
        if (!domains || !domains.pos.length) return;
        this.stats.cosmetic++;
        for (const d of domains.pos) this.site(d).h.add(selector);
        for (const d of domains.neg) this.site(d).x.add(selector);
    }

    /** @returns true if the line was a cosmetic rule (supported or not). */
    addCosmetic(line, kind) {
        const m = /^([^#]*?)#(@?)([?$%]?)#(.+)$/.exec(line);
        if (!m) return false;
        const [, domainPart, at, ext, body] = m;
        if (ext === '$' || ext === '%') return this.skip();
        if (body[0] === '^' || body.startsWith('+js(')) return this.skip();
        const selector = normalizeSelector(body);
        if (!selector) return this.skip();
        const domains = parseDomains(domainPart, ',');
        if (!domains) return this.skip();
        const exception = at === '@';
        this.stats.cosmetic++;
        if (exception) {
            if (domains.pos.length === 0 && domains.neg.length === 0) this.globalUnhide.add(selector);
            for (const d of domains.pos) this.site(d).x.add(selector);
            return true;
        }
        if (domains.pos.length === 0) {
            (kind === 'cookies' ? this.genericCookieHide : this.genericHide).add(selector);
            for (const d of domains.neg) this.site(d).x.add(selector);
            return true;
        }
        for (const d of domains.pos) (kind === 'cookies' ? this.site(d).c : this.site(d).h).add(selector);
        for (const d of domains.neg) this.site(d).x.add(selector);
        return true;
    }

    skip() {
        this.stats.skipped++;
        return true;
    }

    /** @returns true if the rule was used. */
    addNetwork(line) {
        let rule = line;
        const exception = rule.startsWith('@@');
        if (exception) rule = rule.slice(2);
        if (rule[0] === '/' && rule.endsWith('/')) return false; // regex rule
        let opts = '';
        const dollar = rule.lastIndexOf('$');
        if (dollar > 0) {
            opts = rule.slice(dollar + 1);
            rule = rule.slice(0, dollar);
        }
        const m = /^\|\|([a-z0-9.-]+)\^\|?$/i.exec(rule);
        if (!m) {
            // "@@||host/path$domain=site": we only block whole hosts, so allow the whole host on that site
            const pm = exception && /^\|\|([a-z0-9.-]+)[/^:?*|]/i.exec(rule);
            const host = pm && toAsciiHost(pm[1]);
            if (!host) return false;
            const dm = /(?:^|,)(?:domain|from)=([^,]+)/i.exec(opts);
            const d = dm ? parseDomains(dm[1], '|') : null;
            if (!d || !d.pos.length) {
                this.globalPathExceptions.add(host);
                return true;
            }
            for (const site of d.pos) this.site(site).a.add(host);
            return true;
        }
        const host = toAsciiHost(m[1]);
        if (!host || !host.includes('.')) return false;

        let pos = [];
        let neg = [];
        let flags = 0;
        let firstPartyOnly = false;
        let types = 0;
        let popup = false;
        for (const opt of opts ? opts.split(',') : []) {
            const o = opt.trim().toLowerCase();
            if (!o) continue;
            const eq = o.indexOf('=');
            const name = eq === -1 ? o : o.slice(0, eq);
            if (name === 'domain' || name === 'from') {
                const d = parseDomains(o.slice(eq + 1), '|');
                if (!d) return false;
                pos = d.pos;
                neg = d.neg;
            } else if (NET_NOOP_OPTIONS.has(o)) {
                // fine
            } else if (o === '~third-party' || o === '1p' || o === 'first-party' || o === '~3p') {
                firstPartyOnly = true;
            } else if (o === 'popup') {
                popup = true;
            } else if (o === 'document' || o === 'doc') {
                if (exception) flags |= FLAG_DOCUMENT;
                else types++;
            } else if (o === 'generichide' || o === 'ghide') {
                flags |= FLAG_GENERICHIDE;
            } else if (o === 'elemhide' || o === 'ehide') {
                flags |= FLAG_ELEMHIDE;
            } else if (o === 'specifichide' || o === 'shide') {
                flags |= FLAG_SPECIFICHIDE;
            } else if (NET_TYPES.has(o.replace(/^~/, ''))) {
                types++;
            } else {
                return false; // csp, redirect, removeparam, rewrite, badfilter, header, ... are not plain blocking
            }
        }
        if (flags) {
            if (!exception) return false;
            this.site(host).f |= flags;
            return true;
        }
        if (firstPartyOnly) return false;
        if (exception) {
            if (pos.length) for (const d of pos) this.site(d).a.add(host);
            else this.netAllow.add(host);
            return true;
        }
        if (popup && types === 0) {
            if (pos.length) return false;
            this.popupBlock.add(host);
            return true;
        }
        if (pos.length) {
            for (const d of pos) this.site(d).b.add(host);
            for (const d of neg) this.site(d).a.add(host);
        } else if (/_cname_/.test(this.section)) {
            this.firstPartyTrackers.add(host);
        } else {
            this.netBlock.add(host);
            for (const d of neg) this.site(d).a.add(host);
        }
        return true;
    }

    /** Applies global #@# exceptions and resolves block/allow overlap. */
    finish() {
        for (const s of this.globalUnhide) {
            this.genericHide.delete(s);
            this.genericCookieHide.delete(s);
        }
        // EasyList allows specific paths on these blocked hosts everywhere (video SDKs, payment, anti-DDoS):
        // we can only block whole hosts, so breaking those paths is worse than letting the host through.
        for (const h of this.globalPathExceptions) {
            let blocked = false;
            for (let s = h; s; s = s.includes('.') ? s.slice(s.indexOf('.') + 1) : '') if (this.netBlock.has(s)) blocked = true;
            if (blocked) this.netAllow.add(h);
        }
        for (const h of this.netAllow) this.netBlock.delete(h);
    }
}

/** Plain CSS selector or null. */
export function normalizeSelector(body) {
    let s = body.trim();
    if (!s || s.length > 2000) return null;
    if (/[{}]/.test(s)) return null; // would break out of the CSS rule
    if (s.includes(':-abp-has(')) s = s.replaceAll(':-abp-has(', ':has(');
    if (UNSUPPORTED_SELECTOR.test(s)) return null;
    if (!balanced(s)) return null;
    return s;
}

function balanced(s) {
    const stack = [];
    let quote = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\') {
            i++;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(' || ch === '[') stack.push(ch);
        else if (ch === ')' && stack.pop() !== '(') return false;
        else if (ch === ']' && stack.pop() !== '[') return false;
    }
    return !quote && stack.length === 0;
}

/** "a.com,~b.a.com,example.*" -> {pos, neg}; null if a domain is a regex or invalid. */
export function parseDomains(part, sep) {
    const pos = [];
    const neg = [];
    if (!part) return { pos, neg };
    for (const raw of part.split(sep)) {
        let d = raw.trim().toLowerCase();
        if (!d) continue;
        let negated = false;
        if (d[0] === '~') {
            negated = true;
            d = d.slice(1);
        }
        if (d[0] === '/') return null;
        let host;
        if (d.endsWith('.*')) {
            const base = toAsciiHost(d.slice(0, -2));
            if (!base) return null;
            host = base + '.*';
        } else {
            host = toAsciiHost(d);
            if (!host) return null;
        }
        (negated ? neg : pos).push(host);
    }
    return { pos, neg };
}

export function toAsciiHost(h) {
    const lower = h.toLowerCase().replace(/\.$/, '');
    if (/^[a-z0-9.-]+$/.test(lower)) return lower;
    const ascii = domainToASCII(lower);
    return ascii || null;
}
