#!/usr/bin/env node
// Bundles src/ into the installable Sleipnir extension public/sleipnir-shield.slex.js.
//
//   node tools/build-ext.mjs --base https://<user>.github.io/<repo>/
//
// --base: URL the public/ directory is served from (filters at <base>f/, extension at <base>).

import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public');
export const EXT_FILE = 'sleipnir-shield.slex.js';

/**
 * Sleipnir runs extensions through WebView.loadUrl("javascript:..."), and javascript: URLs are
 * percent-decoded before they run: "%3D" inside a string would arrive as "=". Escape every
 * percent-hex sequence inside literals as \x25 so the code is identical whether or not decoding happens.
 * Whitespace minification stays off, so "%" in code only ever appears as " % " (modulo operator).
 */
export function escapePercentSequences(code) {
    const out = code.replace(/%(?=[0-9A-Fa-f]{2})/g, '\\x25');
    if (/%[0-9A-Fa-f]{2}/.test(out)) throw new Error('percent sequence left in bundle');
    return out;
}

export function header({ version, base, author }) {
    const lines = [
        '==UserScript==',
        '@name            Shield - Werbe- und Cookie-Blocker',
        `@author          ${author}`,
        '@description     Blockiert Werbung und Tracker und lehnt Cookie-Banner automatisch ab.',
        '@description     Filterlisten (EasyList, EasyList Germany, EasyPrivacy, Cookie-Regeln) aktualisieren sich selbst.',
        '@description     Ausnahmen und Element-Ausblenden ueber den Schild-Knopf am linken Rand.',
        `@version         ${version}`,
        '@include         http://*',
        '@include         https://*',
        '@require         api',
        `@origin          ${base}${EXT_FILE}`,
        '==/UserScript==',
    ];
    return lines.map((l) => '// ' + l).join('\n') + '\n';
}

export async function buildExtension({ base, outDir = OUT_DIR }) {
    if (!/^https?:\/\/.+\/$/.test(base)) throw new Error('--base must be an http(s) URL ending in "/"');
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const result = await build({
        entryPoints: [path.join(ROOT, 'src/main.js')],
        bundle: true,
        format: 'iife',
        target: 'chrome100',
        minifyIdentifiers: true,
        minifySyntax: true,
        minifyWhitespace: false,
        legalComments: 'none',
        charset: 'utf8',
        write: false,
        define: {
            __FILTER_BASE__: JSON.stringify(base),
            __VERSION__: JSON.stringify(pkg.version),
        },
    });
    const body = escapePercentSequences(result.outputFiles[0].text);
    const code = header({ version: pkg.version, base, author: pkg.author || 'shield' }) + body;
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, EXT_FILE), code);
    await writeFile(path.join(outDir, 'index.html'), installPage(base, pkg.version));
    return { file: path.join(outDir, EXT_FILE), bytes: Buffer.byteLength(code) };
}

function installPage(base, version) {
    return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shield für Sleipnir</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2em auto;padding:0 1em;line-height:1.5}
a.btn{display:inline-block;background:#1d4ed8;color:#fff;padding:.8em 1.2em;border-radius:10px;text-decoration:none;font-size:1.1em}</style>
</head><body>
<h1>Shield für Sleipnir Mobile</h1>
<p>Werbe- und Trackerblocker mit automatischer Cookie-Banner-Ablehnung. Version ${version}.</p>
<p><a class="btn" href="${base}${EXT_FILE}">In Sleipnir installieren</a></p>
<p>Diese Seite in <b>Sleipnir</b> öffnen und auf den Knopf tippen. Filterlisten werden automatisch von
<code>${base}f/</code> aktualisiert.</p>
</body></html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf('--base');
    const base = i !== -1 ? process.argv[i + 1] : null;
    if (!base) {
        console.error('usage: node tools/build-ext.mjs --base https://<user>.github.io/<repo>/');
        process.exit(2);
    }
    const { file, bytes } = await buildExtension({ base });
    console.log(`${path.relative(ROOT, file)}: ${(bytes / 1024).toFixed(1)} KiB`);
}
