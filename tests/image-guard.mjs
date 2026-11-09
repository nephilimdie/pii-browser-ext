import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

// Content-side image guard on a fake ChatGPT composer: originals are swallowed in the
// capture phase, only the Cloud-confirmed copy reaches the site, failures fail closed.
import { src, i18n } from './helpers/env.mjs';
const [composerSource, source, coreSource, panelSource] = await Promise.all(['composer.js', 'image-guard.js', 'core.js', 'panel.js'].map(src));
const it = await i18n('it');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REDACTED_B64 = Buffer.from('redacted-bytes').toString('base64');

function boot({ host = 'chatgpt.com', sync = { interceptSend: true, protectImages: true }, reply, html } = {}) {
  const window = new Window({ url: `https://${host}/` });
  const { document } = window;
  document.body.innerHTML = html || '<form><div id="prompt-textarea" contenteditable="true"></div><div id="att"></div><input type="file" id="up"></form>';
  const sent = [];
  const storageListeners = [];
  let networkCalls = 0;
  window.fetch = async () => { networkCalls++; throw new Error('content scripts must not fetch'); };
  window.XMLHttpRequest = function () { networkCalls++; throw new Error('no XHR'); };
  window.chrome = {
    i18n: it,
    runtime: {
      id: 'ext', lastError: null, getURL: p => `chrome-extension://ext/${p}`,
      sendMessage(msg, cb) {
        if (msg.type === 'GET_DOC_TYPES') { Promise.resolve({ presets: [], policies: [] }).then(cb); return; }   // panel header only
        sent.push(msg); Promise.resolve(typeof reply === 'function' ? reply(msg) : reply).then(cb);
      },
    },
    storage: {
      sync: { get(defaults, cb) { cb({ ...defaults, ...sync }); } },
      onChanged: { addListener(fn) { storageListeners.push(fn); } },
    },
  };
  window.URL.createObjectURL = () => 'blob:preview';
  window.URL.revokeObjectURL = () => {};
  window.eval(coreSource);
  window.eval(composerSource);
  window.eval(panelSource);
  window.eval(source);
  const site = [];                                   // what the page's own handlers receive
  const files = ev => [...(ev.clipboardData || ev.dataTransfer || ev.target).files].map(f => f.name);
  window.addEventListener('paste', ev => site.push(['paste', files(ev)]));
  window.addEventListener('drop', ev => site.push(['drop', files(ev)]));
  window.addEventListener('change', ev => site.push(['change', files(ev)]));
  const guard = window.PseudoraImageGuard;
  guard.timing.verifyMs = 60; guard.timing.pollMs = 10;
  const file = (name, type, body = 'original-secret') => new window.File([body], name, { type });
  const paste = list => {
    const dt = new window.DataTransfer();
    list.forEach(f => dt.items.add(f));
    const ev = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    document.querySelector('#prompt-textarea, textarea[name="prompt"]').dispatchEvent(ev);
    return ev;
  };
  const panel = () => document.getElementById('pii-img-panel');
  const click = label => [...panel().querySelectorAll('button')].find(b => b.textContent.startsWith(label)).click();
  const toggle = (key, value) => storageListeners.forEach(fn => fn({ [key]: { newValue: value } }, 'sync'));
  return { window, document, sent, site, guard, file, paste, panel, click, toggle, network: () => networkCalls };
}
const okReply = { safe: true, format: 'png', image_base64: REDACTED_B64, entity_count: 2, visual_count: 1, review_regions: 1, types: ['FACE', 'IBAN'] };

// Pure helpers.
{
  const { guard, file } = boot();
  assert.equal(guard.classify(file('a.JPG', '')), 'image');
  assert.equal(guard.classify(file('a.heic', 'image/heic')), 'heic');
  assert.equal(guard.classify(file('IMG_1.HEIC', '')), 'heic');
  assert.equal(guard.classify(file('a.gif', 'image/gif')), 'unsupported');
  assert.equal(guard.classify(file('a.pdf', 'application/pdf')), 'other');
  assert.equal(guard.plan([file('a.pdf', 'application/pdf')]), null);
  assert.equal(guard.plan([file('a.png', 'image/png'), file('b.heic', 'image/heic')]).blocked, 'heic');
  assert.equal(guard.validResult({ ...okReply, safe: 'true' }), false);
  assert.equal(guard.validResult({ ...okReply, format: 'gif' }), false);
  assert.equal(guard.validResult({ ...okReply, types: undefined }), false);
  assert.equal(guard.summarize([okReply, { entity_count: 1, types: ['FACE'] }]), '3 elementi: volti, IBAN');
  assert.equal(guard.summarize([{ entity_count: 0, types: [] }]), 'nessun dato personale trovato');
}

// Intercept paste → review → inject: the site never sees the original.
{
  const t = boot({ reply: okReply });
  const ev = t.paste([t.file('screenshot-mario.png', 'image/png')]);
  assert.equal(ev.defaultPrevented, true, 'original paste cancelled');
  assert.deepEqual(t.site, [], 'site handlers never saw the original paste');
  await sleep(20);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].type, 'REDACT_IMAGE');
  assert.equal(t.sent[0].format, 'png');
  assert.equal(Buffer.from(t.sent[0].data, 'base64').toString(), 'original-secret');
  assert.match(t.panel().textContent, /2 elementi: volti, IBAN/);
  assert.match(t.panel().textContent, /1 area incerta/);
  assert.ok(t.panel().querySelector('img.pii-img-preview'));
  // Same shell as the text panel: a labelled dialog; the preview opens a zoom view.
  assert.equal(t.panel().getAttribute('role'), 'dialog');
  assert.ok(t.panel().getAttribute('aria-labelledby'));
  t.panel().querySelector('.pii-img-figure').click();
  assert.ok(t.panel().querySelector('.pii-zoom img'), 'click-to-zoom');
  t.panel().querySelector('.pii-zoom').dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(t.panel().querySelector('.pii-zoom'), null, 'Esc closes the zoom first');
  assert.ok(t.panel(), 'the panel stays open');
  // the site renders an attachment thumbnail when it receives the protected file
  t.window.addEventListener('paste', () => t.document.getElementById('att').appendChild(t.document.createElement('img')));
  t.click('Usa immagine protetta');
  assert.deepEqual(t.site, [['paste', ['immagine-protetta-1.png']]], 'only the protected copy reaches the site');
  await sleep(40);
  assert.equal(t.panel(), null, 'panel closes once the attachment shows up');
  assert.equal(t.network(), 0, 'content script made no network call');
}

// Doubtful areas are outlined on the preview at their relative position.
{
  const t = boot({ reply: { ...okReply, review_boxes: [[0.1, 0.2, 0.5, 0.4]] } });
  t.paste([t.file('a.png', 'image/png')]);
  await sleep(20);
  const box = t.panel().querySelector('.pii-img-frame .pii-review-box');
  assert.equal(box.style.left, '10%');
  assert.equal(box.style.width, '40%');
  assert.equal(box.textContent, '1');
}

// Annulla on review: nothing reaches the site.
{
  const t = boot({ reply: okReply });
  t.paste([t.file('a.png', 'image/png')]);
  await sleep(20);
  t.click('Annulla');
  assert.equal(t.panel(), null);
  assert.deepEqual(t.site, []);
}

// Injection fallback: site shows no attachment → download offered, original still unsent.
{
  const t = boot({ reply: okReply });
  t.paste([t.file('a.png', 'image/png')]);
  await sleep(20);
  t.click('Usa immagine protetta');
  await sleep(120);
  assert.match(t.panel().textContent, /scaricala e allegala a mano/);
  let downloaded = null;
  t.document.addEventListener('click', e => { if (e.target.download) downloaded = e.target.download; }, true);
  t.click('Scarica');
  assert.equal(downloaded, 'immagine-protetta-1.png');
  assert.deepEqual(t.site.map(s => s[1]).flat(), ['immagine-protetta-1.png']);
}

// Fail closed: Cloud error, malformed reply or runtime failure → error panel, nothing to the site.
for (const reply of [{ error: 'Pseudora: HTTP 503', responseCode: 'unavailable' }, { ...okReply, safe: false }, { safe: true }, undefined]) {
  const t = boot({ reply });
  t.paste([t.file('a.png', 'image/png')]);
  await sleep(20);
  assert.match(t.panel().textContent, /L'immagine originale non è stata inviata/);
  assert.ok(t.panel().querySelector('[role="alert"] .pii-notice'), 'error announced in the alert region');
  assert.equal(t.panel().querySelector('.pii-img-use'), null, 'no way to use an unconfirmed image');
  assert.deepEqual(t.site, []);
}
{
  const t = boot({ reply: { error: 'x', responseCode: 'quota' } });
  t.paste([t.file('a.png', 'image/png')]);
  await sleep(20);
  assert.match(t.panel().textContent, /Crediti Pseudora esauriti/);
}

// HEIC: blocked with its hint, never sent to the Cloud or the site.
{
  const t = boot({ reply: okReply });
  const ev = t.paste([t.file('IMG_0001.HEIC', 'image/heic')]);
  assert.equal(ev.defaultPrevented, true);
  await sleep(10);
  assert.match(t.panel().textContent, /HEIC non sono supportate/);
  assert.equal(t.sent.length, 0);
  assert.deepEqual(t.site, []);
}

// Toggle: protectImages off (or intercept send off) → the site handles the paste untouched.
{
  const t = boot({ sync: { interceptSend: true, protectImages: false }, reply: okReply });
  const ev = t.paste([t.file('a.png', 'image/png')]);
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(t.site, [['paste', ['a.png']]]);
  assert.equal(t.sent.length, 0);
  t.toggle('protectImages', true);                 // live storage change re-arms the guard
  t.paste([t.file('b.png', 'image/png')]);
  assert.equal(t.site.length, 1);
  await sleep(20);
  assert.equal(t.sent.length, 1);
}
{
  const t = boot({ sync: { interceptSend: false, protectImages: true }, reply: okReply });
  t.paste([t.file('a.png', 'image/png')]);
  assert.equal(t.sent.length, 0);
  assert.equal(t.site.length, 1);
}

// Text-only paste and non-image files pass through.
{
  const t = boot({ reply: okReply });
  const ev = t.paste([t.file('notes.pdf', 'application/pdf')]);
  assert.equal(ev.defaultPrevented, false);
  assert.equal(t.sent.length, 0);
}

// Drop and file input are intercepted too; the file input is cleared before the site reads it.
{
  const t = boot({ reply: okReply });
  const dt = new t.window.DataTransfer();
  dt.items.add(t.file('a.webp', 'image/webp'));
  const drop = new t.window.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  if (!drop.dataTransfer) Object.defineProperty(drop, 'dataTransfer', { value: dt }); // happy-dom drops the init field
  t.document.getElementById('prompt-textarea').dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true);
  await sleep(20);
  assert.equal(t.sent[0].format, 'webp');
  assert.deepEqual(t.site, []);

  const u = boot({ reply: okReply });
  const input = u.document.getElementById('up');
  const pick = new u.window.DataTransfer();
  pick.items.add(u.file('scan.jpg', 'image/jpeg'));
  input.files = pick.files;
  input.dispatchEvent(new u.window.Event('change', { bubbles: true }));
  assert.equal(input.files.length, 0, 'original removed from the input');
  assert.deepEqual(u.site, []);
  await sleep(20);
  assert.equal(u.sent[0].format, 'jpeg');
  u.click('Usa immagine protetta');
  assert.deepEqual(u.site.at(-1), ['change', ['immagine-protetta-1.png']]);
}

// Current chatgpt.com markup (textarea[name="prompt"], no #prompt-textarea): still intercepted.
{
  const html = await readFile(new URL('./fixtures/chatgpt-composer-2026-11.html', import.meta.url), 'utf8');
  const t = boot({ reply: okReply, html });
  const ev = t.paste([t.file('a.png', 'image/png')]);
  assert.equal(ev.defaultPrevented, true, 'paste into the new composer is cancelled');
  assert.deepEqual(t.site, []);
  await sleep(20);
  assert.equal(t.sent[0]?.type, 'REDACT_IMAGE');
}

// Other sites (Gemini): no wiring at all.
{
  const t = boot({ host: 'gemini.google.com', reply: okReply });
  const ev = t.paste([t.file('a.png', 'image/png')]);
  assert.equal(ev.defaultPrevented, false);
  assert.equal(t.sent.length, 0);
}
console.log('image-guard: ok');
