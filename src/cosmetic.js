// Element hiding via constructable stylesheets: not subject to the page's style-src CSP,
// one rule per selector so an invalid selector only drops itself.

const HIDE = '{display:none!important}';
const sheets = new Set();
let watchdog = 0;

function makeSheet(selectors, extraCss = '') {
    const text = selectors.map((s) => s + HIDE).join('\n') + extraCss;
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        return { sheet };
    } catch {
        // very old WebView: plain <style> (may be blocked by CSP)
        const style = document.createElement('style');
        style.textContent = text;
        return { style };
    }
}

function attach(entry) {
    if (entry.sheet) {
        if (!document.adoptedStyleSheets.includes(entry.sheet)) {
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, entry.sheet];
        }
    } else if (!entry.style.isConnected) {
        (document.head || document.documentElement).appendChild(entry.style);
    }
}

function detach(entry) {
    if (entry.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== entry.sheet);
    else entry.style.remove();
}

/** Adds a hiding stylesheet; returns a handle with remove(). */
export function addHideSheet(selectors, extraCss = '') {
    const entry = makeSheet(selectors, extraCss);
    sheets.add(entry);
    attach(entry);
    // SPA frameworks occasionally replace document.adoptedStyleSheets wholesale
    if (!watchdog) {
        watchdog = setInterval(() => sheets.forEach(attach), 3000);
    }
    return {
        remove() {
            sheets.delete(entry);
            detach(entry);
        },
    };
}

/** Selectors (from `selectors`) that currently match at least one element. */
export function matchingSelectors(selectors, budgetMs = 1500) {
    const out = [];
    const deadline = performance.now() + budgetMs;
    for (const s of selectors) {
        if (performance.now() > deadline) break;
        try {
            if (document.querySelector(s)) out.push(s);
        } catch {
            // invalid selector
        }
    }
    return out;
}
