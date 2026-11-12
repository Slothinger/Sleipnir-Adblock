// Extract example hostnames from an autoconsent runContext.urlPattern regex, so specific rules can be
// sharded by host. Unexpandable parts become "x" (they only ever cover subdomain labels in practice);
// every result is verified against the original regex, so a wrong guess only costs sharding, never matching.

const MAX_EXPANSIONS = 64;

export function hostsFromUrlPattern(pattern) {
    const m = /^\^?https\??:(?:\/\/|\\\/\\\/)/.exec(pattern) || /^\^?http:(?:\/\/|\\\/\\\/)/.exec(pattern);
    if (!m) return null;
    const parser = { src: pattern, i: m[0].length };
    let alts;
    try {
        alts = parseSeq(parser, true);
    } catch {
        return null;
    }
    if (!alts || alts.length > MAX_EXPANSIONS) return null;
    let re;
    try {
        re = new RegExp(pattern);
    } catch {
        return null;
    }
    const hosts = [];
    for (const raw of alts) {
        const host = raw.replace(/^\.+/, '');
        if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return null;
        if (!re.test('https://' + host + '/') && !re.test('http://' + host + '/')) return null;
        hosts.push(host);
    }
    return hosts.length ? [...new Set(hosts)] : null;
}

// Returns list of string alternatives for the host region, stopping at the path.
function parseSeq(p, top) {
    let acc = [''];
    while (p.i < p.src.length) {
        const ch = p.src[p.i];
        if (top && (ch === '/' || ch === '$' || ch === '?' || ch === ':')) break;
        if (top && ch === '\\' && p.src[p.i + 1] === '/') break;
        if (!top && (ch === '|' || ch === ')')) break;
        let piece;
        if (ch === '(') {
            const start = p.i;
            p.i++;
            if (p.src.startsWith('?:', p.i)) p.i += 2;
            const groupAlts = [];
            for (;;) {
                const alt = parseSeq(p, false);
                if (alt === null) return null;
                groupAlts.push(...alt);
                if (p.src[p.i] === '|') {
                    p.i++;
                    continue;
                }
                if (p.src[p.i] === ')') {
                    p.i++;
                    break;
                }
                return null;
            }
            const inner = p.src.slice(start, p.i);
            if (top && /\/|\$/.test(inner)) {
                // a group like (\/|$) ends the host
                p.i = start;
                break;
            }
            piece = groupAlts;
        } else if (ch === '\\') {
            const next = p.src[p.i + 1];
            p.i += 2;
            if (next === '.' || next === '-') piece = [next];
            else if (next === 'w' || next === 'd') piece = ['x'];
            else return null;
        } else if (ch === '[') {
            const end = p.src.indexOf(']', p.i);
            if (end === -1) return null;
            p.i = end + 1;
            piece = ['x'];
        } else if (ch === '.') {
            p.i++;
            piece = ['.'];
        } else if (/[a-z0-9-]/i.test(ch)) {
            p.i++;
            piece = [ch.toLowerCase()];
        } else if (ch === '^') {
            p.i++;
            continue;
        } else {
            return null;
        }
        // quantifiers
        const q = p.src[p.i];
        if (q === '?') {
            p.i++;
            piece = [''];
        } else if (q === '*') {
            p.i++;
            piece = [''];
        } else if (q === '+') {
            p.i++;
        } else if (q === '{') {
            const end = p.src.indexOf('}', p.i);
            if (end === -1) return null;
            p.i = end + 1;
        }
        const next = [];
        for (const a of acc) for (const b of piece) next.push(a + b);
        if (next.length > MAX_EXPANSIONS) return null;
        acc = next;
    }
    return acc;
}
