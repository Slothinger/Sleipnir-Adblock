// Request blocking inside the page. Sleipnir runs extensions after window.onload, so this covers what
// loads later: lazy ad slots, ad refreshes, tracking beacons, pop-ups, SPA navigations.

import { fnv1a, hashSetHas, hostSuffixes, sameSite } from './shared/host.js';

export class NetMatcher {
    /**
     * @param sets decoded generic sets {block, allow, popup} (Uint32Array)
     * @param rules site rules {block: string[], allow: string[]}
     * @param trackers same-site tracker hosts from the shard
     */
    constructor(sets, rules, trackers, pageHost) {
        this.sets = sets;
        this.siteBlock = new Set(rules.block);
        this.siteAllow = new Set(rules.allow);
        this.trackers = new Set(trackers);
        this.pageHost = pageHost;
        this.memo = new Map();
        this.blockedCount = 0;
        this.blockedHosts = new Map();
    }

    hostOf(url) {
        try {
            const u = new URL(url, location.href);
            if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
            return u.hostname;
        } catch {
            return null;
        }
    }

    isBlockedHost(host, popup = false) {
        const memoKey = popup ? '!' + host : host;
        const memo = this.memo.get(memoKey);
        if (memo !== undefined) return memo;
        const result = this.decide(host, popup);
        if (this.memo.size > 2000) this.memo.clear();
        this.memo.set(memoKey, result);
        return result;
    }

    decide(host, popup) {
        const suffixes = hostSuffixes(host);
        for (const s of suffixes) if (this.siteAllow.has(s)) return false;
        for (const s of suffixes) if (this.trackers.has(s)) return true;
        if (sameSite(host, this.pageHost)) return false;
        for (const s of suffixes) if (this.siteBlock.has(s)) return true;
        for (const s of suffixes) {
            const h = fnv1a(s);
            if (hashSetHas(this.sets.allow, h)) return false;
            if (hashSetHas(this.sets.block, h)) return true;
            if (popup && hashSetHas(this.sets.popup, h)) return true;
        }
        return false;
    }

    /** Checks a URL and counts the hit. */
    blocks(url, popup = false) {
        const host = this.hostOf(String(url));
        if (!host || !this.isBlockedHost(host, popup)) return false;
        this.blockedCount++;
        this.blockedHosts.set(host, (this.blockedHosts.get(host) || 0) + 1);
        if (this.onBlock) this.onBlock();
        return true;
    }
}

// Proxies keep Function.prototype.toString() returning "[native code]" (anti-adblock checks).
function wrapMethod(obj, name, makeApply) {
    const original = obj && obj[name];
    if (typeof original !== 'function') return;
    obj[name] = new Proxy(original, { apply: makeApply(original) });
}

function wrapSetter(proto, prop, intercept) {
    const desc = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    const set = desc.set;
    Object.defineProperty(proto, prop, {
        ...desc,
        set: new Proxy(set, {
            apply(target, self, args) {
                if (intercept(self, args[0])) return undefined;
                return Reflect.apply(target, self, args);
            },
        }),
    });
}

function fireError(el) {
    setTimeout(() => {
        try {
            el.dispatchEvent(new Event('error'));
        } catch {
            // ignore
        }
    }, 0);
}

function neutralizeFrame(frame) {
    frame.style.setProperty('display', 'none', 'important');
    try {
        if (frame.getAttribute('src') !== 'about:blank') frame.setAttribute('src', 'about:blank');
    } catch {
        // ignore
    }
}

const SRC_TAGS = { SCRIPT: 1, IFRAME: 1, IMG: 1, FRAME: 1, EMBED: 1, SOURCE: 1 };
const ADBLOCK_ATTR = 'data-slx-blocked';

/** Element whose src is about to be set to a blocked URL: neutralize instead. Returns true if handled. */
function interceptSrc(matcher, el, value) {
    if (!el || !SRC_TAGS[el.tagName] || value == null || !matcher.blocks(value)) return false;
    el.setAttribute(ADBLOCK_ATTR, '');
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') neutralizeFrame(el);
    else fireError(el);
    return true;
}

export function installNetworkHooks(matcher) {
    const XHR = window.XMLHttpRequest && XMLHttpRequest.prototype;
    const blockedXhr = new WeakSet();

    wrapMethod(window, 'fetch', (original) => (target, self, args) => {
        const input = args[0];
        const url = input && typeof input === 'object' && 'url' in input ? input.url : input;
        if (url != null && matcher.blocks(url)) return Promise.reject(new TypeError('Failed to fetch'));
        return Reflect.apply(target, self, args);
    });

    wrapMethod(XHR, 'open', () => (target, self, args) => {
        if (args[1] != null && matcher.blocks(args[1])) blockedXhr.add(self);
        else blockedXhr.delete(self);
        return Reflect.apply(target, self, args);
    });

    wrapMethod(XHR, 'send', () => (target, self, args) => {
        if (!blockedXhr.has(self)) return Reflect.apply(target, self, args);
        setTimeout(() => {
            self.dispatchEvent(new ProgressEvent('error'));
            self.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
        return undefined;
    });

    wrapMethod(navigator, 'sendBeacon', () => (target, self, args) => {
        if (args[0] != null && matcher.blocks(args[0])) return true;
        return Reflect.apply(target, self, args);
    });

    wrapMethod(window, 'open', () => (target, self, args) => {
        if (args[0] != null && String(args[0]) && matcher.blocks(args[0], true)) return null;
        return Reflect.apply(target, self, args);
    });

    if (typeof window.WebSocket === 'function') {
        const WS = window.WebSocket;
        window.WebSocket = new Proxy(WS, {
            construct(target, args, newTarget) {
                if (args[0] != null && matcher.blocks(args[0])) throw new DOMException('blocked', 'SecurityError');
                return Reflect.construct(target, args, newTarget);
            },
        });
    }

    const intercept = (el, value) => interceptSrc(matcher, el, value);
    wrapSetter(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src', intercept);
    wrapSetter(window.HTMLIFrameElement && HTMLIFrameElement.prototype, 'src', intercept);
    wrapSetter(window.HTMLImageElement && HTMLImageElement.prototype, 'src', intercept);
    wrapSetter(window.HTMLEmbedElement && HTMLEmbedElement.prototype, 'src', intercept);

    wrapMethod(Element.prototype, 'setAttribute', () => (target, self, args) => {
        const name = args[0];
        if (typeof name === 'string' && name.toLowerCase() === 'src' && intercept(self, args[1])) return undefined;
        return Reflect.apply(target, self, args);
    });

    // Elements created from HTML strings (innerHTML, insertAdjacentHTML, document.write) bypass the setters.
    const sweep = (root) => {
        const list = root.querySelectorAll ? root.querySelectorAll('iframe[src],frame[src],img[src],embed[src]') : [];
        const check = (el) => {
            if (el.hasAttribute(ADBLOCK_ATTR)) return;
            const src = el.getAttribute('src');
            if (!src || !matcher.blocks(src)) return;
            el.setAttribute(ADBLOCK_ATTR, '');
            if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') neutralizeFrame(el);
            else el.style.setProperty('display', 'none', 'important');
        };
        if (root.nodeType === 1 && SRC_TAGS[root.tagName] && root.tagName !== 'SCRIPT') check(root);
        list.forEach(check);
    };
    sweep(document);
    new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) sweep(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
}
