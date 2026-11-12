// Cookie banners: reject via DuckDuckGo autoconsent (CMP rules + heuristics), then hide what is left.

import AutoConsent, { decodeRules } from '@duckduckgo/autoconsent';
import { addHideSheet } from './cosmetic.js';

const TERMINAL = new Set(['nothingDetected', 'done', 'optOutSucceeded', 'optOutFailed']);
const CONSENT_TEXT =
    /cookie|consent|datenschutz|einwillig|zustimm|privacy|tracking|personalisiert|partner|dsgvo|gdpr|rgpd|privacidad|confidentialit/i;

export class CookieHandler {
    constructor() {
        this.status = 'idle'; // idle | running | rejected | hidden | none | failed
        this.cmp = null;
        this.clicks = 0;
        this.listeners = new Set();
    }

    set(status) {
        this.status = status;
        this.listeners.forEach((fn) => fn(this));
    }

    /**
     * @param compactRulesets autoconsent compact rulesets (generic + site shard)
     * @param afterConsent called once autoconsent is finished, to apply cookie hiding
     */
    start(compactRulesets, afterConsent) {
        const rules = [];
        for (const set of compactRulesets) {
            try {
                rules.push(...decodeRules(set));
            } catch {
                // incompatible rule format from a newer build: keep the built-in CMP code rules
            }
        }
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            afterConsent(this);
        };
        const onMessage = async (msg) => {
            if (!msg) return;
            if (msg.type === 'cmpDetected' || msg.type === 'popupFound') {
                this.cmp = msg.cmp;
                if (this.status === 'idle') this.set('running');
            } else if (msg.type === 'autoconsentDone') {
                this.cmp = msg.cmp;
                this.clicks = msg.totalClicks || 0;
                this.set(msg.isCosmetic ? 'hidden' : 'rejected');
                finish();
            } else if (msg.type === 'optOutResult' && !msg.result) {
                this.cmp = msg.cmp;
                this.set('failed');
            } else if (msg.type === 'report' && msg.state && TERMINAL.has(msg.state.lifecycle)) {
                if (msg.state.lifecycle === 'nothingDetected' && this.status === 'idle') this.set('none');
                if (msg.state.lifecycle === 'optOutSucceeded' && this.status !== 'rejected') this.set('rejected');
                finish();
            }
        };
        this.set('idle');
        try {
            // initialize() separately: passing the config to the constructor runs prehide before
            // the instance has its DOM helpers (autoconsent 18 constructor order)
            const consent = new AutoConsent(onMessage);
            consent.initialize(
                {
                    enabled: true,
                    autoAction: 'optOut',
                    isMainWorld: true,
                    enablePrehide: true,
                    prehideTimeout: 2500,
                    enableCosmeticRules: true,
                    enableGeneratedRules: true,
                    enableHeuristicDetection: true,
                    enablePopupMutationObserver: true,
                    // tier1: "reject" or "OK/understood" on notice-only banners; never "accept"
                    heuristicMode: 'tier1',
                    detectRetries: 20,
                    logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
                },
                { autoconsent: rules },
            );
        } catch {
            this.set('failed');
            finish();
        }
        // safety net if autoconsent never reports a terminal state
        setTimeout(() => {
            if (finished) return;
            if (this.status === 'idle') this.set('none');
            else if (this.status === 'running') this.set('failed');
            finish();
        }, 15000);
    }
}

/** A visible fixed/sticky overlay that looks like a consent prompt, found by hit-testing the viewport. */
export function findConsentOverlay() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const points = [
        [w / 2, h / 2],
        [w / 2, h - 30],
        [w / 2, h * 0.8],
        [w / 2, 40],
        [w * 0.25, h * 0.65],
    ];
    const seen = new Set();
    for (const [x, y] of points) {
        for (let el = document.elementFromPoint(x, y); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
            if (seen.has(el)) break;
            seen.add(el);
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
            const r = el.getBoundingClientRect();
            if (r.width * r.height < 0.08 * w * h) break; // floating "cookie settings" buttons, chat bubbles
            const text = (el.innerText || '').slice(0, 3000);
            if (text.length > 20 && CONSENT_TEXT.test(text)) return el;
            break;
        }
    }
    return null;
}

/** Empty full-screen dimming layers left behind once the consent box itself is hidden. */
export function hideBackdrops() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const [x, y] of [[w / 2, h / 2], [w / 4, h / 4], [w * 0.75, h * 0.75]]) {
        for (let el = document.elementFromPoint(x, y); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
            if (getComputedStyle(el).position !== 'fixed') continue;
            const r = el.getBoundingClientRect();
            if (r.width * r.height >= 0.9 * w * h && !(el.innerText || '').trim()) el.style.setProperty('display', 'none', 'important');
            break;
        }
    }
}

/** Undo scroll locks left behind by a consent overlay we hid. */
export function unlockScroll() {
    const html = document.documentElement;
    const body = document.body;
    if (!body) return;
    const locked = [html, body].some((el) => {
        const cs = getComputedStyle(el);
        return cs.overflow === 'hidden' || cs.overflowY === 'hidden' || cs.position === 'fixed';
    });
    if (!locked) return;
    const bodyFixed = getComputedStyle(body).position === 'fixed';
    const top = bodyFixed ? -parseInt(body.style.top || '0', 10) || 0 : 0;
    let css = 'html,body{overflow:auto!important;overflow-y:auto!important}';
    if (bodyFixed) css += 'body{position:static!important;top:auto!important}';
    addHideSheet([], css);
    if (top) window.scrollTo(0, top);
}
