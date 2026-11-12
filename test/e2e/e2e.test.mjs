// End-to-end: real filter lists, the built extension injected the way Sleipnir does it
// (after onload, wrapped in a strict IIFE with SLEX_* functions), in mobile Chromium.
//
//   SHIELD_CHROME=/path/to/chrome node --test test/e2e/
//   (lists are read from .cache/lists/<id>.txt when present, else downloaded)

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { build as buildFilters } from '../../tools/build-filters.mjs';
import { buildExtension, EXT_FILE } from '../../tools/build-ext.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = path.join(ROOT, 'test/e2e/pages');
const SHOTS = process.env.SHIELD_SHOTS || path.join(tmpdir(), 'shield-e2e');

let server;
let port;
let outDir;
let browser;
let extCode;
const requests = [];

function chromePath() {
    if (process.env.SHIELD_CHROME) return process.env.SHIELD_CHROME;
    const base = path.join(process.env.HOME || '', '.cache/ms-playwright');
    for (const p of ['chromium-1208/chrome-linux64/chrome', 'chromium-1169/chrome-linux/chrome']) {
        if (existsSync(path.join(base, p))) return path.join(base, p);
    }
    return undefined;
}

// Node 18 only runs before/after reliably inside a suite
describe('shield e2e', () => {
    before(async () => {
        outDir = await mkdtemp(path.join(tmpdir(), 'shield-pub-'));
        await mkdir(SHOTS, { recursive: true });
        const cache = path.join(ROOT, '.cache/lists');
        await buildFilters({ offlineDir: existsSync(path.join(cache, 'easylist.txt')) ? cache : null, outDir: path.join(outDir, 'f') });

        server = createServer(async (req, res) => {
            const host = (req.headers.host || '').split(':')[0];
            const url = new URL(req.url, 'http://x');
            requests.push({ host, path: url.pathname, t: Date.now() });
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (host === 'shield.test') {
                const file = path.join(outDir, path.normalize(url.pathname));
                try {
                    if (!(await stat(file)).isFile()) throw new Error();
                    res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/javascript');
                    res.end(await readFile(file));
                } catch {
                    res.statusCode = 404;
                    res.end('not found');
                }
                return;
            }
            if (host === 'www.testsite.de' || host === 'www.cspsite.de') {
                if (url.pathname === '/api/data') return res.end('first-party-ok');
                const file = path.join(PAGES, path.basename(url.pathname) || 'ads.html');
                if (host === 'www.cspsite.de') {
                    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; connect-src 'self' http://shield.test:" + port);
                }
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                try {
                    res.end(await readFile(file));
                } catch {
                    res.statusCode = 404;
                    res.end();
                }
                return;
            }
            res.setHeader('Content-Type', 'text/plain');
            res.end('// third party ' + host);
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;

        await buildExtension({ base: `http://shield.test:${port}/`, outDir });
        extCode = await readFile(path.join(outDir, EXT_FILE), 'utf8');

        browser = await chromium.launch({
            executablePath: chromePath(),
            args: ['--host-resolver-rules=MAP * 127.0.0.1'],
        });
    });

    after(async () => {
        await browser?.close();
        server?.closeAllConnections();
        server?.close();
    });

    /**
     * What Sleipnir hands to WebView.loadUrl (q2/u + a2/w2 in the APK): the code without the metadata
     * block, inside a strict IIFE with a guard and the SLEX_* API. Navigating to it makes Chromium apply
     * the real javascript: URL processing (line breaks stripped, %XX decoded).
     */
    function sleipnirUrl(fileText) {
        const lines = fileText.split('\n');
        const code = lines.slice(lines.findIndex((l) => /^\s*\/\/\s*==\/UserScript==/.test(l)) + 1).join('\n');
        return "javascript:(function(){'use strict';try {if (window['slex_guard_1']) return;window['slex_guard_1'] = true;var SLEX_locale=\"en\";"
            + "function SLEX_httpGet(url){var x=new XMLHttpRequest();x.open('GET',url,false);x.send();return x.status==200?x.responseText:null;}"
            + 'var jq=null;(function($,jQuery){\n' + code + '\n})(jq, jq);} catch (e) {window.__slexError = String(e)};})();';
    }

    async function openPage(urlPath, { host = 'www.testsite.de', storage = null, filtersDown = false } = {}) {
        const context = await browser.newContext({
            viewport: { width: 412, height: 915 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 Sleipnir/3.9.1',
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        if (filtersDown) await page.route('**/f/**', (route) => route.abort());
        const url = `http://${host}:${port}/${urlPath}`;
        await page.goto(url, { waitUntil: 'load' });
        if (storage) {
            await page.evaluate((s) => localStorage.setItem('slx-shield', JSON.stringify(s)), storage);
            await page.reload({ waitUntil: 'load' });
        }
        const injectedAt = Date.now();
        await page.evaluate((url) => { location.href = url; }, sleipnirUrl(extCode));
        await page.waitForFunction(() => window.slex_guard_1 === true, null, { timeout: 5000 });
        return { page, context, errors, injectedAt };
    }

    const visible = (page, sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        return !!el && getComputedStyle(el).display !== 'none';
    }, sel);

    test('ads: cosmetic hiding and request blocking after load', async () => {
        const { page, context, errors, injectedAt } = await openPage('ads.html');
        await page.waitForFunction(() => document.adoptedStyleSheets.length > 0, null, { timeout: 15000 });
        await page.waitForTimeout(500);
        assert.equal(await visible(page, '#ad_banner'), false, 'EasyList generic rule');
        assert.equal(await visible(page, '.werbung'), false, 'EasyList Germany rule');
        assert.equal(await visible(page, '#content'), true);
        assert.equal(await visible(page, '#initial-ad'), false, 'ad iframe present before injection is neutralized');

        await page.evaluate(() => window.runDynamic());
        await page.waitForTimeout(1500);
        const r = await page.evaluate(() => window.results);
        assert.equal(r.script, 'blocked');
        assert.equal(r.fetch, 'blocked');
        assert.equal(r.img, 'blocked');
        assert.equal(r.xhr, 'blocked');
        assert.equal(r.popup, 'blocked');
        assert.equal(r.firstParty, 'first-party-ok');
        assert.equal(r.thirdPartyOk, 'ok');
        assert.match(r.fetchToString, /\[native code\]/);
        assert.equal(await visible(page, '#dyn-ad'), false);
        const leaked = requests.filter((q) => q.t > injectedAt + 50 && /doubleclick|googlesyndication|google-analytics|adnxs/.test(q.host));
        assert.deepEqual(leaked, [], 'blocked hosts never received a request after injection');
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => window.__slexError || null), null);
        await page.screenshot({ path: path.join(SHOTS, 'ads.png') });
        await context.close();
    });

    test('ads: per-site exception from the panel turns blocking off', async () => {
        const { page, context } = await openPage('ads.html', { storage: { ads: false } });
        await page.waitForTimeout(2500);
        assert.equal(await visible(page, '#ad_banner'), true);
        await page.evaluate(() => window.runDynamic());
        await page.waitForTimeout(1000);
        assert.equal((await page.evaluate(() => window.results)).fetch, 'ok');
        await context.close();
    });

    test('cookies: generic German banner is rejected, never accepted', async () => {
        const { page, context } = await openPage('cookie-heuristic.html');
        await page.waitForFunction(() => window.decision, null, { timeout: 20000 });
        assert.equal(await page.evaluate(() => window.decision), 'reject');
        await context.close();
    });

    test('cookies: OneTrust is rejected through its CMP rule', async () => {
        const { page, context } = await openPage('cookie-onetrust.html');
        await page.waitForFunction(() => window.decision, null, { timeout: 20000 });
        assert.equal(await page.evaluate(() => window.decision), 'reject');
        await context.close();
    });

    test('cookies: banner is still rejected when the filter host is unreachable', async () => {
        const { page, context } = await openPage('cookie-heuristic.html', { filtersDown: true });
        await page.waitForFunction(() => window.decision, null, { timeout: 20000 });
        assert.equal(await page.evaluate(() => window.decision), 'reject');
        await context.close();
    });

    test('cookies: accept-only banner is hidden, not accepted, and scrolling is unlocked', async () => {
        const { page, context } = await openPage('cookie-acceptonly.html');
        await page.waitForFunction(() => {
            const el = document.getElementById('cookie-banner');
            return !el || getComputedStyle(el).display === 'none';
        }, null, { timeout: 25000 });
        assert.equal(await page.evaluate(() => window.decision || null), null);
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden');
        await context.close();
    });

    test('anti-adblock notice is removed with its backdrop and scroll lock', async () => {
        const { page, context } = await openPage('anti-adblock.html');
        await page.waitForFunction(() => document.getElementById('nag') && getComputedStyle(document.getElementById('nag')).display === 'none', null, { timeout: 15000 });
        assert.equal(await visible(page, '#dim'), false);
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden');
        await context.close();
    });

    test('strict CSP page: hiding and panel still work', async () => {
        const { page, context, errors } = await openPage('csp.html', { host: 'www.cspsite.de' });
        await page.waitForTimeout(3000);
        assert.equal(await visible(page, '#ad_banner'), false);
        assert.equal(await page.evaluate(() => !!document.querySelector('slx-shield-ui')), true);
        // open the panel (closed shadow root: tap the button position)
        await page.mouse.click(23, 915 - 915 * 0.22 - 17);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS, 'panel.png') });
        assert.deepEqual(errors, []);
        await context.close();
    });
});
