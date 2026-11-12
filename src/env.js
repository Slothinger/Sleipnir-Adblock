/* global SLEX_httpGet, __FILTER_BASE__, __VERSION__ */
// Runtime environment: Sleipnir injects this script after window.onload into the top frame only,
// wrapped in a strict-mode IIFE that also declares the SLEX_* API functions (see README).

export const FILTER_BASE = __FILTER_BASE__;
export const VERSION = __VERSION__;
export const FORMAT_VERSION = 1;

const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
const hasSlexGet = typeof SLEX_httpGet === 'function';

export class NotFoundError extends Error {}

let fetchBlockedByPage = false;
try {
    fetchBlockedByPage = sessionStorage.getItem('slx-shield-nofetch') === '1';
} catch {
    // storage disabled
}

/**
 * GET text. Prefers fetch() (async, HTTP cache); falls back to SLEX_httpGet, which ignores the page's
 * Content-Security-Policy but blocks the page thread while it downloads.
 */
export async function httpGetText(url, { revalidate = false } = {}) {
    if (nativeFetch && !fetchBlockedByPage) {
        try {
            const res = await nativeFetch(url, {
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                cache: revalidate ? 'no-cache' : 'default',
            });
            if (res.status === 404) throw new NotFoundError(url);
            if (res.ok) return await res.text();
        } catch (e) {
            if (e instanceof NotFoundError) throw e;
            // CSP connect-src or network error: remember for this tab, use the native bridge
            fetchBlockedByPage = true;
            try {
                sessionStorage.setItem('slx-shield-nofetch', '1');
            } catch {
                // ignore
            }
        }
    }
    if (hasSlexGet) {
        const text = SLEX_httpGet(url);
        if (typeof text === 'string' && text.length) return text;
    }
    throw new Error('download failed: ' + url);
}

export function now() {
    return Date.now();
}

export function onIdle(fn) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 1500 });
    else setTimeout(fn, 50);
}
