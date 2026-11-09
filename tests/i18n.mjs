import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { messages, src } from './helpers/env.mjs';

// Every user-facing string comes from _locales: Italian (default) and English carry the same keys,
// the same {placeholders}, and every key the code or the HTML asks for exists.
const [it, en] = await Promise.all([messages('it'), messages('en')]);
assert.deepEqual(Object.keys(en).sort(), Object.keys(it).sort(), 'it and en have the same keys');
for (const key of Object.keys(it)) {
  const ph = m => (m.match(/\{\w+\}/g) || []).sort().join();
  assert.equal(ph(en[key].message), ph(it[key].message), `${key}: same placeholders`);
  assert.ok(it[key].message.trim() && en[key].message.trim(), `${key}: not empty`);
  assert.doesNotMatch(it[key].message + en[key].message, /\$/, `${key}: no $ (Chrome placeholder syntax)`);
}

const files = (await readdir(new URL('../src/', import.meta.url))).filter(f => /\.(js|html)$/.test(f));
const sources = Object.fromEntries(await Promise.all(files.map(async f => [f, await src(f)])));
const manifest = await readFile(new URL('../manifest.json', import.meta.url), 'utf8');
const used = new Set();
for (const text of Object.values(sources)) {
  for (const m of text.matchAll(/\bt\('(\w+)'/g)) used.add(m[1]);
  for (const m of text.matchAll(/msgOr\('(\w+)'/g)) used.add(m[1]);
  for (const m of text.matchAll(/data-i18n(?:-aria|-title|-placeholder)?="(\w+)"/g)) used.add(m[1]);
}
for (const m of manifest.matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);
// Keys built at runtime: document presets, error kinds, image refusal codes.
const core = sources['core.js'];
for (const v of core.match(/IMAGE_DOMAINS = \[([^\]]+)\]/)[1].matchAll(/'(\w+)'/g)) used.add(`doc_${v[1]}`);
for (const k of core.match(/const KINDS = \{([\s\S]*?)\n  \};/)[1].matchAll(/^\s+(\w+):/gm)) { used.add(`errTitle_${k[1]}`); used.add(`errDetail_${k[1]}`); }
for (const c of sources['image-guard.js'].match(/const CODES = \[([\s\S]*?)\];/)[1].matchAll(/'(\w+)'/g)) used.add(`img_${c[1]}`);
const missing = [...used].filter(k => !(k in it));
assert.deepEqual(missing, [], 'every referenced key exists');

// The manifest is localized with Italian as the default.
const m = JSON.parse(manifest);
assert.equal(m.default_locale, 'it');
assert.equal(m.name, '__MSG_extName__');
assert.ok(it.extDescription.message.length <= 132 && en.extDescription.message.length <= 132, 'store description limit');

// No user-facing English left hard-coded in the Italian-first surfaces.
for (const f of ['popup.html', 'oauth-callback.html']) assert.match(sources[f], /<html lang="it">/);
for (const legacy of ['Anonymize &amp; Send', 'No result yet', 'Was this anonymization useful', 'Open the extension popup', 'Auto-send', 'Login with Pseudora', '<v-icon']) {
  for (const [f, text] of Object.entries(sources)) assert.equal(text.includes(legacy), false, `${f} still contains "${legacy}"`);
}
console.log(`i18n: ok (${Object.keys(it).length} keys, it + en)`);
