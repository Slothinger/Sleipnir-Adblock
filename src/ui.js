// In-page controls: a small shield button opening a bottom sheet with per-site exceptions,
// an element picker and diagnostics. Lives in a closed shadow root so page CSS cannot reach it.

const STYLE = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,Roboto,sans-serif}
.btn{position:fixed;left:6px;bottom:22vh;width:34px;height:34px;border-radius:17px;border:0;padding:0;
 background:#1d4ed8;color:#fff;opacity:.55;box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;
 z-index:2147483647;transition:opacity .3s}
.btn.dim{opacity:.22}
.btn svg{width:20px;height:20px;fill:currentColor}
.badge{position:absolute;top:-4px;right:-6px;min-width:16px;height:16px;border-radius:8px;background:#dc2626;color:#fff;
 font-size:10px;line-height:16px;text-align:center;padding:0 3px}
.sheet{position:fixed;left:0;right:0;bottom:0;max-height:82vh;overflow:auto;background:#fff;color:#111;z-index:2147483647;
 border-radius:14px 14px 0 0;box-shadow:0 -4px 24px rgba(0,0,0,.35);padding:14px 16px 22px;font-size:15px;line-height:1.35}
.sheet h2{font-size:17px;margin:0 0 2px}
.muted{color:#666;font-size:13px}
.mt{margin-top:10px}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #eee}
.row:last-child{border-bottom:0}
.status{padding:8px 10px;border-radius:8px;background:#f3f4f6;margin:10px 0;font-size:14px}
button.act{border:0;border-radius:8px;padding:9px 12px;background:#1d4ed8;color:#fff;font-size:14px}
button.sec{border:1px solid #ccc;border-radius:8px;padding:8px 11px;background:#fff;color:#111;font-size:14px}
button.small{padding:4px 8px;font-size:12px}
.sw{position:relative;width:46px;height:26px;flex:none}
.sw input{opacity:0;width:0;height:0}
.sw span{position:absolute;inset:0;border-radius:13px;background:#bbb;transition:.2s}
.sw span:before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;border-radius:10px;background:#fff;transition:.2s}
.sw input:checked+span{background:#16a34a}
.sw input:checked+span:before{transform:translateX(20px)}
.list{margin:6px 0 0;padding:0;list-style:none;font-size:12px;font-family:monospace}
.list li{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #eee;word-break:break-all}
.grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.reload{background:#fef3c7;border-radius:8px;padding:8px 10px;margin:10px 0;display:flex;justify-content:space-between;align-items:center;gap:8px}
.pick-box{position:fixed;pointer-events:none;border:2px solid #dc2626;background:rgba(220,38,38,.15);z-index:2147483646}
.pick-layer{position:fixed;inset:0;z-index:2147483645;background:transparent}
.pick-bar{position:fixed;left:0;right:0;bottom:0;background:#111;color:#fff;padding:10px 12px;z-index:2147483647;font-size:13px}
.pick-bar code{display:block;word-break:break-all;color:#93c5fd;margin:4px 0 8px;font-size:12px}
.pick-bar button{margin-right:6px;margin-top:4px}
@media (prefers-color-scheme:dark){.sheet{background:#1f2937;color:#f3f4f6}.status{background:#374151}.muted{color:#9ca3af}
 .row{border-color:#374151}button.sec{background:#1f2937;color:#f3f4f6;border-color:#4b5563}.reload{background:#78350f}}
`;

// No innerHTML anywhere: pages enforcing Trusted Types would throw.
function shieldIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M12 1 3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5l-9-4zm0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6z');
    svg.append(path);
    return svg;
}

function setLines(el, lines) {
    el.replaceChildren();
    lines.forEach((line, i) => {
        if (i) el.append(document.createElement('br'));
        el.append(line);
    });
}

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'onclick') el.addEventListener('click', v);
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v);
    }
    for (const c of children) if (c) el.append(c);
    return el;
}

function toggle(checked, onChange) {
    const input = h('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'sw' }, input, h('span'));
}

/** Short, stable CSS selector for a picked element. */
export function selectorFor(el) {
    const goodId = (id) => /^[A-Za-z][\w-]{1,60}$/.test(id) && !/\d{4,}/.test(id);
    const goodClass = (c) => /^[A-Za-z][\w-]{1,40}$/.test(c) && !/\d{3,}|^(?:active|open|show|visible|hidden|is-|has-)/.test(c);
    if (el.id && goodId(el.id)) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let cur = el; cur && cur !== document.body && cur !== document.documentElement && parts.length < 5; cur = cur.parentElement) {
        if (cur.id && goodId(cur.id)) {
            parts.unshift('#' + CSS.escape(cur.id));
            break;
        }
        let part = cur.localName;
        const classes = [...cur.classList].filter(goodClass).slice(0, 3);
        if (classes.length) part += classes.map((c) => '.' + CSS.escape(c)).join('');
        else if (cur.parentElement) {
            const same = [...cur.parentElement.children].filter((c) => c.localName === cur.localName);
            if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
        parts.unshift(part);
        try {
            if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
        } catch {
            break;
        }
    }
    return parts.join(' > ');
}

/**
 * @param api {
 *   host, siteCfg, globalAllow: {ads, cookies}, settings,
 *   status(): {adsOn, cookiesOn, blocked, cookie: {status, cmp}, filters: {built, lists}},
 *   save(cfg), hidePreview(selector) -> handle, activeHideSelectors(): string[], refresh(): Promise
 * }
 */
export function mountUi(api) {
    const hostEl = document.createElement('slx-shield-ui');
    const root = hostEl.attachShadow({ mode: 'closed' });
    const css = new CSSStyleSheet();
    css.replaceSync(STYLE); // constructable sheets are not subject to the page's style-src CSP
    root.adoptedStyleSheets = [css];
    const btn = h('button', { class: 'btn', 'aria-label': 'Shield' }, shieldIcon());
    const badge = h('span', { class: 'badge' });
    badge.style.display = 'none';
    btn.append(badge);
    root.append(btn);
    (document.body || document.documentElement).appendChild(hostEl);
    setTimeout(() => btn.classList.add('dim'), 4000);

    let sheet = null;
    let statusEl = null;
    let dirty = false;
    const cfg = api.siteCfg;

    const save = () => {
        api.save(cfg);
        dirty = true;
        if (sheet) render();
    };

    function close() {
        sheet && sheet.remove();
        sheet = null;
    }

    function statusText() {
        const s = api.status();
        const lines = [];
        if (!s.loaded) lines.push('Filter werden geladen …');
        if (s.error) lines.push('Filter konnten nicht geladen werden: ' + s.error);
        if (s.adsOn) lines.push(`Werbung: ${s.blocked} Anfragen blockiert, ${s.selectors} Ausblendregeln aktiv`);
        else lines.push('Werbeblocker auf dieser Seite aus');
        const c = s.cookie;
        const via = c.cmp ? ` (${c.cmp})` : '';
        if (!s.cookiesOn) lines.push('Cookie-Ablehnung auf dieser Seite aus');
        else if (c.status === 'rejected') lines.push(`Cookies: abgelehnt${via}` + (c.leftoverHidden ? ', verbliebene Sperrseite ausgeblendet' : ''));
        else if (c.status === 'hidden') lines.push(`Cookies: Banner ausgeblendet${via}`);
        else if (c.status === 'failed') lines.push(`Cookies: Ablehnen fehlgeschlagen (${c.cmp || 'unbekannt'}), Banner ausgeblendet`);
        else if (c.status === 'none') lines.push('Cookies: kein Banner erkannt');
        else lines.push('Cookies: wird geprüft …');
        return lines;
    }

    function render() {
        const s = api.status();
        const wasOpen = !!sheet;
        const scroll = sheet ? sheet.scrollTop : 0;
        close();
        sheet = h('div', { class: 'sheet' });
        sheet.append(
            h('h2', { text: 'Shield' }),
            h('div', { class: 'muted', text: api.host }),
            (statusEl = h('div', { class: 'status' })),
        );
        setLines(statusEl, statusText());
        if (dirty) {
            sheet.append(
                h('div', { class: 'reload' }, h('span', { text: 'Änderung gilt nach dem Neuladen vollständig.' }), h('button', { class: 'act small', text: 'Neu laden', onclick: () => location.reload() })),
            );
        }
        if (api.globalAllow.ads || api.globalAllow.cookies) {
            sheet.append(h('div', { class: 'muted', text: 'Globale Ausnahme aus allowlist.txt aktiv: ' + [api.globalAllow.ads && 'Werbung', api.globalAllow.cookies && 'Cookies'].filter(Boolean).join(', ') }));
        }
        sheet.append(
            h('div', { class: 'row' }, h('div', {}, h('div', { text: 'Werbeblocker auf dieser Seite' }), h('div', { class: 'muted', text: 'Aus = Ausnahme für ' + api.host })),
                toggle(cfg.ads, (v) => { cfg.ads = v; save(); })),
            h('div', { class: 'row' }, h('div', {}, h('div', { text: 'Cookie-Banner automatisch ablehnen' }), h('div', { class: 'muted', text: 'Aus = Banner selbst bedienen' })),
                toggle(cfg.cookies, (v) => { cfg.cookies = v; save(); })),
        );
        const tools = h('div', { class: 'grid' },
            h('button', { class: 'act', text: 'Element ausblenden', onclick: () => { close(); startPicker(); } }),
            h('button', { class: 'sec', text: 'Ausgeblendetes prüfen', onclick: () => showActive(tools) }),
            h('button', { class: 'sec', text: 'Filter aktualisieren', onclick: async (e) => {
                e.target.textContent = 'Lädt …';
                try {
                    await api.refresh();
                    e.target.textContent = 'Aktualisiert';
                    dirty = true;
                } catch {
                    e.target.textContent = 'Fehlgeschlagen';
                }
            } }),
        );
        sheet.append(tools);
        if (cfg.hide.length) {
            sheet.append(h('div', { class: 'row' }, h('div', { text: `Eigene Ausblendregeln (${cfg.hide.length})` })));
            const ul = h('ul', { class: 'list' });
            cfg.hide.forEach((sel, i) => ul.append(h('li', {}, h('span', { text: sel }), h('button', { class: 'sec small', text: 'Entfernen', onclick: () => { cfg.hide.splice(i, 1); save(); } }))));
            sheet.append(ul);
        }
        if (cfg.unhide.length) {
            sheet.append(h('div', { class: 'row' }, h('div', { text: `Zugelassene Elemente (${cfg.unhide.length})` })));
            const ul = h('ul', { class: 'list' });
            cfg.unhide.forEach((sel, i) => ul.append(h('li', {}, h('span', { text: sel }), h('button', { class: 'sec small', text: 'Wieder ausblenden', onclick: () => { cfg.unhide.splice(i, 1); save(); } }))));
            sheet.append(ul);
        }
        const f = s.filters;
        sheet.append(
            h('div', { class: 'muted mt', text: f ? `Filterstand ${new Date(f.built).toLocaleString('de-DE')} · ${f.lists.map((l) => l.title).join(', ')} · Shield ${s.version}` : `Shield ${s.version}` }),
            h('div', { class: 'grid' }, h('button', { class: 'sec', text: 'Schließen', onclick: close })),
        );
        root.append(sheet);
        if (wasOpen) sheet.scrollTop = scroll;
    }

    function showActive(after) {
        const list = api.activeHideSelectors();
        const box = h('div');
        if (!list.length) box.append(h('div', { class: 'muted mt', text: 'Auf dieser Seite greift gerade keine Ausblendregel.' }));
        else {
            box.append(h('div', { class: 'muted mt', text: 'Diese Regeln blenden hier etwas aus. „Zulassen“ zeigt das Element auf dieser Seite wieder an:' }));
            const ul = h('ul', { class: 'list' });
            for (const sel of list.slice(0, 200)) {
                ul.append(h('li', {}, h('span', { text: sel }), h('button', { class: 'sec small', text: 'Zulassen', onclick: (e) => {
                    if (!cfg.unhide.includes(sel)) cfg.unhide.push(sel);
                    e.target.textContent = 'Zugelassen';
                    e.target.disabled = true;
                    api.save(cfg);
                    dirty = true;
                } })));
            }
            box.append(ul);
        }
        after.after(box);
    }

    function startPicker() {
        const layer = h('div', { class: 'pick-layer' });
        const box = h('div', { class: 'pick-box' });
        const code = h('code');
        const bar = h('div', { class: 'pick-bar' }, h('div', { text: 'Tippe auf das Element, das verschwinden soll.' }), code);
        const stack = [];
        let current = null;
        let preview = null;

        const show = (el) => {
            current = el;
            const r = el.getBoundingClientRect();
            Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', display: 'block' });
            const sel = selectorFor(el);
            let count = 0;
            try {
                count = document.querySelectorAll(sel).length;
            } catch {
                // ignore
            }
            code.textContent = `${sel}  (${count} Treffer)`;
            actions.style.display = 'block';
        };
        const finish = () => {
            layer.remove();
            box.remove();
            bar.remove();
            if (preview) preview.remove();
        };
        const actions = h('div', {},
            h('button', { class: 'sec small', text: 'Größer', onclick: () => { if (current && current.parentElement && current.parentElement !== document.body) { stack.push(current); show(current.parentElement); } } }),
            h('button', { class: 'sec small', text: 'Kleiner', onclick: () => { if (stack.length) show(stack.pop()); } }),
            h('button', { class: 'act small', text: 'Ausblenden', onclick: () => {
                if (!current) return;
                const sel = selectorFor(current);
                if (!cfg.hide.includes(sel)) cfg.hide.push(sel);
                api.save(cfg);
                api.hidePreview(sel);
                finish();
            } }),
            h('button', { class: 'sec small', text: 'Abbrechen', onclick: finish }),
        );
        actions.style.display = 'none';
        bar.append(actions);
        bar.append(h('div', {}, h('button', { class: 'sec small', text: 'Abbrechen', onclick: finish })));
        box.style.display = 'none';
        layer.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            layer.style.pointerEvents = 'none';
            hostEl.style.pointerEvents = 'none';
            const el = document.elementFromPoint(e.clientX, e.clientY);
            layer.style.pointerEvents = '';
            hostEl.style.pointerEvents = '';
            if (el && el !== hostEl && el !== document.body && el !== document.documentElement) {
                stack.length = 0;
                show(el);
            }
        });
        root.append(layer, box, bar);
    }

    btn.addEventListener('click', () => {
        btn.classList.remove('dim');
        if (sheet) close();
        else render();
    });

    return {
        update() {
            const s = api.status();
            const n = s.blocked + (s.cookie.status === 'rejected' || s.cookie.status === 'hidden' ? 1 : 0);
            badge.textContent = n > 99 ? '99+' : String(n);
            badge.style.display = n ? 'block' : 'none';
            if (sheet && statusEl) setLines(statusEl, statusText());
        },
    };
}
