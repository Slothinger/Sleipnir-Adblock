// Full-screen overlays (consent walls, anti-adblock notices): find them, remove them and what they leave behind.

import { addHideSheet } from './cosmetic.js';

/**
 * A visible fixed/sticky element covering at least 8 % of the viewport for which matches(el, innerText)
 * is true. Hit-tests a few points through all stacked layers, so a dimming backdrop on top does not hide
 * the dialog below it.
 */
export function findOverlay(matches) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const points = [
        [w / 2, h / 2],
        [w / 2, h * 0.35],
        [w / 2, h - 30],
        [w / 2, h * 0.8],
        [w / 2, 40],
        [w * 0.25, h * 0.65],
    ];
    const seen = new Set();
    for (const [x, y] of points) {
        for (const hit of document.elementsFromPoint(x, y).slice(0, 12)) {
            let el = hit;
            while (el && el !== document.body && el !== document.documentElement) {
                const pos = getComputedStyle(el).position;
                if (pos === 'fixed' || pos === 'sticky') break;
                el = el.parentElement;
            }
            if (!el || el === document.body || el === document.documentElement || seen.has(el)) continue;
            seen.add(el);
            const r = el.getBoundingClientRect();
            if (r.width * r.height < 0.08 * w * h) continue; // floating "cookie settings" buttons, chat bubbles
            if (matches(el, (el.innerText || '').slice(0, 3000))) return el;
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

/** Undo scroll locks left behind by an overlay we hid. */
let unlocked = false;

/** Idempotent: applies once, as soon as the page is actually locked. */
export function unlockScroll() {
    if (unlocked) return;
    const html = document.documentElement;
    const body = document.body;
    if (!body) return;
    const locked = [html, body].some((el) => {
        const cs = getComputedStyle(el);
        return cs.overflow === 'hidden' || cs.overflowY === 'hidden' || cs.position === 'fixed';
    });
    if (!locked) return;
    unlocked = true;
    const bodyFixed = getComputedStyle(body).position === 'fixed';
    const top = bodyFixed ? -parseInt(body.style.top || '0', 10) || 0 : 0;
    let css = 'html,body{overflow:auto!important;overflow-y:auto!important}';
    if (bodyFixed) css += 'body{position:static!important;top:auto!important}';
    addHideSheet([], css);
    if (top) window.scrollTo(0, top);
}
