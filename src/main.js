// Shield for Sleipnir Mobile: ad/tracker blocking, automatic cookie-banner rejection, per-site exceptions.

import { loadAll, loadGeneric } from './data.js';
import { readSiteConfig, writeSiteConfig } from './sitecfg.js';
import { adSelectors, allowBits, cookieSelectors, FLAG_DOCUMENT, siteRules } from './rules.js';
import { addHideSheet, matchingSelectors } from './cosmetic.js';
import { installNetworkHooks, NetMatcher } from './network.js';
import { CookieHandler, findConsentOverlay, hideBackdrops, unlockScroll } from './cookies.js';
import { mountUi } from './ui.js';
import { VERSION } from './env.js';

const DEFAULT_SETTINGS = { ads: true, network: true, cookies: true, button: true };
const STRONG_CONSENT = /cookie|consent|einwillig|zustimm/i;

function main() {
    if (window.top !== window || !/^https?:$/.test(location.protocol) || !location.hostname) return;
    const marker = Symbol.for('slx-shield');
    if (window[marker]) return;
    Object.defineProperty(window, marker, { value: true });

    const host = location.hostname.replace(/\.$/, '');
    const siteCfg = readSiteConfig();
    const cookie = new CookieHandler();
    const state = {
        loaded: false,
        error: null,
        manifest: null,
        settings: DEFAULT_SETTINGS,
        globalAllow: { ads: false, cookies: false },
        adsOn: siteCfg.ads,
        cookiesOn: siteCfg.cookies,
        adSelectors: [],
        cookieSelectorsApplied: [],
        matcher: null,
    };
    let ui = null;
    let uiTimer = 0;
    const updateUi = () => {
        if (!ui || uiTimer) return;
        uiTimer = setTimeout(() => {
            uiTimer = 0;
            ui.update();
        }, 400);
    };
    cookie.listeners.add(updateUi);

    const status = () => ({
        loaded: state.loaded,
        error: state.error,
        adsOn: state.adsOn,
        cookiesOn: state.cookiesOn,
        blocked: state.matcher ? state.matcher.blockedCount : 0,
        selectors: state.adSelectors.length,
        cookie: { status: cookie.status, cmp: cookie.cmp, leftoverHidden: !!cookie.leftoverHidden },
        filters: state.manifest && { built: state.manifest.built, lists: state.manifest.lists || [] },
        version: VERSION,
    });

    const showUi = () => {
        if (ui || !state.settings.button) return;
        ui = mountUi({
            host,
            siteCfg,
            globalAllow: state.globalAllow,
            status,
            save: (cfg) => writeSiteConfig(cfg),
            hidePreview: (sel) => addHideSheet([sel]),
            activeHideSelectors: () => matchingSelectors([...state.adSelectors, ...state.cookieSelectorsApplied]),
            refresh: async () => {
                const { manifest } = await loadAll(host, { force: true });
                await Promise.all(['g', 'n', 'a', 'c'].map((slot) => loadGeneric(manifest, slot, true)));
            },
        });
    };

    const EMPTY_SITE = { k: {}, t: [], ac: [] };
    let cookiesStarted = false;
    const runCookies = (manifest, site, rules) => {
        if (cookiesStarted || !state.cookiesOn) return undefined;
        cookiesStarted = true;
        return startCookies(manifest, site, rules);
    };

    loadAll(host)
        .then(({ manifest, site }) => {
            state.manifest = manifest;
            state.settings = { ...DEFAULT_SETTINGS, ...(manifest.settings || {}) };
            const bits = allowBits(manifest.allow || {}, host);
            state.globalAllow.ads = !!(bits & 1);
            state.globalAllow.cookies = !!(bits & 2);
            const baseRules = siteRules(site, null, host);
            state.adsOn = state.settings.ads && !state.globalAllow.ads && siteCfg.ads && !(baseRules.flags & FLAG_DOCUMENT);
            state.cookiesOn = state.settings.cookies && !state.globalAllow.cookies && siteCfg.cookies;
            showUi();
            return Promise.all([runCookies(manifest, site, baseRules), state.adsOn && startAds(manifest, site)]);
        })
        .catch((e) => {
            state.error = String((e && e.message) || e);
            // offline or filter host unreachable: built-in CMP rules and heuristics still work
            runCookies(null, EMPTY_SITE, siteRules(EMPTY_SITE, null, host));
            showUi();
        })
        .finally(() => {
            state.loaded = true;
            updateUi();
        });

    async function startAds(manifest, site) {
        const generic = await loadGeneric(manifest, 'g');
        const rules = siteRules(site, generic.tk, host);
        state.adSelectors = adSelectors(generic.css, rules, siteCfg);
        addHideSheet(state.adSelectors);
        if (state.settings.network) {
            const sets = await loadGeneric(manifest, 'n');
            const matcher = new NetMatcher(sets, rules, site.t, host);
            matcher.onBlock = updateUi;
            state.matcher = matcher;
            installNetworkHooks(matcher);
        }
        updateUi();
    }

    async function startCookies(manifest, site, rules) {
        const generic = await loadGeneric(manifest, 'a').catch(() => null);
        cookie.start([generic, ...site.ac].filter(Boolean), async () => {
            const specific = cookieSelectors(rules.cookieHide, rules, siteCfg);
            if (specific.length) {
                addHideSheet(specific);
                state.cookieSelectorsApplied.push(...specific);
            }
            let listApplied = false;
            let unlocked = false;
            const unlock = () => {
                if (!unlocked) unlockScroll();
                unlocked = true;
            };
            if (cookie.status === 'hidden') unlock();
            // Leftovers: CMPs no rule could reject, and "pay or okay" walls that only appear after a reject.
            const hideLeftovers = async () => {
                if (!findConsentOverlay()) return;
                if (!listApplied) {
                    listApplied = true;
                    const list = await loadGeneric(manifest, 'c').catch(() => null);
                    if (list) {
                        const generic = cookieSelectors(list.css, rules, siteCfg);
                        addHideSheet(generic);
                        state.cookieSelectorsApplied.push(...generic);
                    }
                }
                const left = findConsentOverlay();
                if (left && STRONG_CONSENT.test(left.innerText || '')) left.style.setProperty('display', 'none', 'important');
                hideBackdrops();
                unlock();
                if (cookie.status === 'rejected') cookie.leftoverHidden = true;
                else if (cookie.status !== 'failed') cookie.set('hidden');
                updateUi();
            };
            for (const delay of [0, 1500, 2500, 4000]) {
                await new Promise((r) => setTimeout(r, delay));
                await hideLeftovers();
            }
            updateUi();
        });
    }
}

try {
    main();
} catch {
    // never break the page
}
