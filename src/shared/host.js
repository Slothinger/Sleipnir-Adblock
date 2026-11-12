// Shared between the filter compiler (Node) and the extension (browser).
// Keep this file dependency-free.

// Second-level labels that usually belong to the public suffix (co.uk, com.au, ...).
const SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'gouv', 'nic', 'mil', 'sch', 'nhs', 'ltd', 'plc']);

/**
 * Shard label of a host or filter domain key ("www.bbc.co.uk" -> "bbc", "spiegel.*" -> "spiegel").
 * The compiler stores every domain key under shardLabel(key); the client fetches shardLabels(host).
 */
export function shardLabel(host) {
    const labels = host.split('.');
    if (labels.length < 2) return labels[0];
    labels.pop();
    if (labels.length >= 2 && SLD.has(labels[labels.length - 1])) labels.pop();
    return labels[labels.length - 1];
}

/**
 * Every shard label that can hold rules for `host`. Two labels only when the label left of the
 * TLD looks like a second-level suffix: "www.go.com" -> ["www", "go"] (keys "go.com" live under "go").
 */
export function shardLabels(host) {
    const labels = host.split('.');
    const primary = shardLabel(host);
    if (labels.length >= 3 && SLD.has(labels[labels.length - 2])) {
        const secondary = labels[labels.length - 2];
        if (secondary !== primary) return [primary, secondary];
    }
    return [primary];
}

/** All filter domain keys that apply to `host`: its suffixes plus entity forms ("example.*"). */
export function domainKeys(host) {
    const labels = host.split('.');
    const keys = [];
    for (let i = 0; i < labels.length; i++) {
        const suffix = labels.slice(i);
        keys.push(suffix.join('.'));
        for (let k = suffix.length - 1; k >= 1; k--) keys.push(suffix.slice(0, k).join('.') + '.*');
    }
    return keys;
}

/** Host suffixes, most specific first: "a.b.c" -> ["a.b.c", "b.c", "c"]. */
export function hostSuffixes(host) {
    const out = [host];
    let i = host.indexOf('.');
    while (i !== -1) {
        out.push(host.slice(i + 1));
        i = host.indexOf('.', i + 1);
    }
    return out;
}

/** FNV-1a, 32 bit, over UTF-16 code units (hosts are ASCII/punycode). */
export function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function shardIndex(label, shardCount) {
    return fnv1a(label) % shardCount;
}

/** Same-site check without a public suffix list: equal shard labels count as the same site. */
export function sameSite(hostA, hostB) {
    if (hostA === hostB) return true;
    return shardLabel(hostA) === shardLabel(hostB);
}

// Sorted Uint32 hash sets: Golomb-Rice coded deltas, base64 transport. ~17.5 bits per entry.
export function encodeHashSet(hashes) {
    const sorted = Uint32Array.from(new Set(hashes)).sort();
    const n = sorted.length;
    const k = n ? Math.max(0, Math.round(Math.log2((4294967296 / n) * Math.LN2))) : 0;
    const bytes = [];
    let cur = 0;
    let bits = 0;
    const put = (bit) => {
        cur = (cur << 1) | bit;
        if (++bits === 8) {
            bytes.push(cur);
            cur = 0;
            bits = 0;
        }
    };
    const div = 2 ** k;
    let prev = 0;
    for (const h of sorted) {
        const d = h - prev;
        prev = h;
        const q = Math.floor(d / div);
        const r = d - q * div;
        for (let i = 0; i < q; i++) put(1);
        put(0);
        for (let i = k - 1; i >= 0; i--) put(Math.floor(r / 2 ** i) & 1);
    }
    if (bits) bytes.push(cur << (8 - bits));
    return { n, k, d: bytesToBase64(bytes) };
}

export function decodeHashSet(set) {
    const bytes = base64ToBytes(set.d);
    const out = new Uint32Array(set.n);
    const div = 2 ** set.k;
    let pos = 0;
    const bit = () => {
        const b = (bytes[pos >> 3] >> (7 - (pos & 7))) & 1;
        pos++;
        return b;
    };
    let prev = 0;
    for (let i = 0; i < set.n; i++) {
        let q = 0;
        while (bit()) q++;
        let r = 0;
        for (let j = 0; j < set.k; j++) r = r * 2 + bit();
        prev += q * div + r;
        out[i] = prev;
    }
    return out;
}

export function hashSetHas(set, h) {
    let lo = 0;
    let hi = set.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const v = set[mid];
        if (v === h) return true;
        if (v < h) lo = mid + 1;
        else hi = mid - 1;
    }
    return false;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
        out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
        out += i + 2 < bytes.length ? B64[c & 63] : '=';
    }
    return out;
}

function base64ToBytes(str) {
    const clean = str.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const n0 = B64.indexOf(clean[i]);
        const n1 = B64.indexOf(clean[i + 1]);
        const n2 = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0;
        const n3 = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0;
        out[o++] = (n0 << 2) | (n1 >> 4);
        if (i + 2 < clean.length) out[o++] = ((n1 & 15) << 4) | (n2 >> 2);
        if (i + 3 < clean.length) out[o++] = ((n2 & 3) << 6) | n3;
    }
    return out;
}
