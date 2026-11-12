// Cookie banners: reject via DuckDuckGo autoconsent (CMP rules + heuristics), then hide what is left.

import AutoConsent, { decodeRules } from '@duckduckgo/autoconsent';
import { findOverlay } from './overlay.js';

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

const CONSENT_ATTR = /consent|cookie|\bcmp|gdpr|privacy|sp_message|didomi|usercentrics|onetrust|cookiebot|truste/i;
const STRONG_CONSENT = /cookie|consent|einwillig|zustimm/i;

function attrs(el) {
    return (el.id || '') + ' ' + (el.getAttribute('class') || '');
}

/**
 * A visible fixed/sticky overlay that looks like a consent prompt. `strong` = sure enough to hide the
 * element itself (not just to load the cookie hiding list).
 */
export function findConsentOverlay(strong = false) {
    return findOverlay((el, text) => {
        if (text.length > 20 && (strong ? STRONG_CONSENT : CONSENT_TEXT).test(text)) return true;
        // cross-origin CMP iframes (Sourcepoint, TrustArc): no readable text, but telling ids and URLs
        if (CONSENT_ATTR.test(attrs(el))) return true;
        return [...el.querySelectorAll('iframe')].some((f) => CONSENT_ATTR.test(attrs(f) + ' ' + (f.getAttribute('src') || '') + ' ' + (f.title || '')));
    });
}
