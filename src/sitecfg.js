// Per-site exceptions, stored in the site's own localStorage (the only storage Sleipnir extensions get).
// Shape: { ads?: false, cookies?: false, hide?: string[], unhide?: string[] }

const KEY = 'slx-shield';

export function readSiteConfig() {
    try {
        const raw = localStorage.getItem(KEY);
        const cfg = raw ? JSON.parse(raw) : {};
        return {
            ads: cfg.ads !== false,
            cookies: cfg.cookies !== false,
            hide: Array.isArray(cfg.hide) ? cfg.hide.filter((s) => typeof s === 'string') : [],
            unhide: Array.isArray(cfg.unhide) ? cfg.unhide.filter((s) => typeof s === 'string') : [],
        };
    } catch {
        return { ads: true, cookies: true, hide: [], unhide: [] };
    }
}

export function writeSiteConfig(cfg) {
    const out = {};
    if (!cfg.ads) out.ads = false;
    if (!cfg.cookies) out.cookies = false;
    if (cfg.hide.length) out.hide = cfg.hide;
    if (cfg.unhide.length) out.unhide = cfg.unhide;
    try {
        if (Object.keys(out).length) localStorage.setItem(KEY, JSON.stringify(out));
        else localStorage.removeItem(KEY);
        return true;
    } catch {
        return false;
    }
}
