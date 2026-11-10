import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Window } from 'happy-dom';

// "Screenshot protetto": crop math, output routing, fail-closed redaction and the
// service-worker start (activeTab capture + on-demand injection).
import { src, i18n } from './helpers/env.mjs';
const [composerSrc, guardSrc, shotSrc, bgSrc, coreSrc, panelSrc] = await Promise.all(['composer.js', 'image-guard.js', 'screenshot.js', 'background.js', 'core.js', 'panel.js'].map(src));
const it = await i18n('it');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pure module in a bare context (no DOM: the overlay wiring stays off).
const pure = vm.createContext({ atob, btoa, Blob, File, Uint8Array, Promise, setTimeout, chrome: { i18n: it } });
for (const s of [coreSrc, composerSrc, guardSrc, shotSrc]) vm.runInContext(s, pure);
const S = pure.PseudoraScreenshot;
const C = pure.PseudoraComposer;
const plain = o => (o ? { ...o } : o);

// Crop math: CSS selection → device pixels of the capture.
{
  const vp = { width: 1280, height: 800 }, img = { width: 2560, height: 1600 };
  assert.deepEqual(plain(S.cropRect({ x: 10, y: 20, width: 100, height: 50 }, vp, img, 2)), { x: 20, y: 40, width: 200, height: 100 }, 'dpr 2 (Retina)');
  assert.deepEqual(plain(S.cropRect({ x: 110, y: 70, width: -100, height: -50 }, vp, img, 2)), { x: 20, y: 40, width: 200, height: 100 }, 'drag up-left normalized');
  assert.deepEqual(plain(S.cropRect({ x: 10, y: 20, width: 100, height: 50 }, vp, { width: 1280, height: 800 }, 1)), { x: 10, y: 20, width: 100, height: 50 }, 'dpr 1');
  // 125% zoom on a dpr-2 screen: the capture/viewport ratio (2.5) wins over a stale dpr.
  assert.deepEqual(plain(S.cropRect({ x: 4, y: 4, width: 40, height: 40 }, { width: 1024, height: 640 }, img, 2)), { x: 10, y: 10, width: 100, height: 100 });
  // Fractional dpr rounds to whole pixels.
  assert.deepEqual(plain(S.cropRect({ x: 3, y: 3, width: 33, height: 33 }, { width: 1000, height: 1000 }, { width: 1500, height: 1500 }, 1.5)), { x: 5, y: 5, width: 49, height: 49 });
  // Unknown viewport: fall back to devicePixelRatio.
  assert.deepEqual(plain(S.cropRect({ x: 10, y: 10, width: 20, height: 20 }, { width: 0, height: 0 }, img, 2)), { x: 20, y: 20, width: 40, height: 40 });
  // Clamped to the viewport / image; dragging off-screen never reads outside the capture.
  assert.deepEqual(plain(S.cropRect({ x: 1200, y: 700, width: 500, height: 500 }, vp, img, 2)), { x: 2400, y: 1400, width: 160, height: 200 });
  assert.deepEqual(plain(S.cropRect({ x: -50, y: -50, width: 70, height: 70 }, vp, img, 2)), { x: 0, y: 0, width: 40, height: 40 });
  // A click or a sliver is not a selection.
  assert.equal(S.cropRect({ x: 10, y: 10, width: 0, height: 0 }, vp, img, 2), null);
  assert.equal(S.cropRect({ x: 10, y: 10, width: 200, height: 7 }, vp, img, 2), null);
}

// Output routing: attach only where image-guard can inject and a composer exists.
{
  assert.equal(S.route({ site: C.forHost('chatgpt.com'), hasComposer: true }), 'attach');
  assert.equal(S.route({ site: C.forHost('claude.ai'), hasComposer: true }), 'attach');
  assert.equal(S.route({ site: C.forHost('chatgpt.com'), hasComposer: false }), 'clipboard');
  assert.equal(S.route({ site: C.forHost('gemini.google.com'), hasComposer: true }), 'clipboard');
  assert.equal(S.route({ site: C.forHost('example.com'), hasComposer: false }), 'clipboard');
}

// protectShot: fail closed, and only the Cloud's bytes are ever attached or copied.
{
  const REDACTED = 'redacted-png-bytes';
  const ok = { safe: true, format: 'png', image_base64: Buffer.from(REDACTED).toString('base64'), entity_count: 3, review_regions: 0, types: ['FACE', 'IBAN'] };
  const crop = new Blob(['original-crop'], { type: 'image/png' });
  const io = (reply, extra = {}) => {
    const log = { sent: [], attached: [], copied: [] };
    return { log, io: {
      send: async m => { log.sent.push(m); return typeof reply === 'function' ? reply() : reply; },
      route: 'clipboard',
      attach: files => { log.attached.push(...files); return true; },
      copy: async f => { log.copied.push(f); },
      ...extra,
    } };
  };
  const text = async f => Buffer.from(await f.arrayBuffer()).toString();

  // Request shape: the crop as PNG base64, same message as a pasted image.
  let t = io(ok);
  let r = await S.protectShot(crop, t.io);
  assert.equal(t.log.sent[0].type, 'REDACT_IMAGE');
  assert.equal(t.log.sent[0].format, 'png');
  assert.equal(Buffer.from(t.log.sent[0].data, 'base64').toString(), 'original-crop');
  assert.equal(r.outcome, 'copied');
  assert.equal(r.summary, 'Oscurati: 3 elementi: volti, IBAN.');
  assert.equal(await text(t.log.copied[0]), REDACTED, 'clipboard gets the redacted bytes');
  assert.equal(t.log.copied[0].type, 'image/png');
  assert.equal(t.log.attached.length, 0);

  // Attach route.
  t = io(ok, { route: 'attach' });
  r = await S.protectShot(crop, t.io);
  assert.equal(r.outcome, 'attached');
  assert.equal(await text(t.log.attached[0]), REDACTED);
  assert.equal(t.log.attached[0].name, 'screenshot-protetto.png');
  assert.equal(t.log.copied.length, 0);

  // A whole-image uncertain region must never be automatically sent or copied.
  t = io({ ...ok, review_regions: 1, review_areas: [{ id: 0, reason: 'unrecognized_ink', bbox: [0, 0, 1, 1] }] }, { route: 'attach' });
  r = await S.protectShot(crop, t.io);
  assert.equal(r.outcome, 'error');
  assert.match(r.message, /revisione/);
  assert.equal(t.log.attached.length + t.log.copied.length, 0);
  assert.equal(S.needsManualReview({ review_regions: 1, review_areas: [] }), true, 'missing area metadata blocks auto-send');
  assert.equal(S.needsManualReview({ review_regions: 1, review_areas: [{ bbox: [0.1, 0.1, 0.2, 0.2] }] }), false);

  // Attach impossible (composer vanished) → clipboard, still the redacted copy.
  t = io(ok, { route: 'attach', attach: () => false });
  r = await S.protectShot(crop, t.io);
  assert.equal(r.outcome, 'copied');
  assert.equal(await text(t.log.copied[0]), REDACTED);

  // Clipboard refused (page lost focus) → copy_failed carries the redacted file for a retry.
  t = io(ok, { copy: async () => { throw new Error('Document is not focused.'); } });
  r = await S.protectShot(crop, t.io);
  assert.equal(r.outcome, 'copy_failed');
  assert.equal(await text(r.file), REDACTED);

  // Every unsafe reply: error message, nothing attached, nothing copied, no fallback to the original.
  const unsafe = [
    [{ error: 'Not authenticated.', responseCode: 'not_configured' }, /non è configurata/],
    [{ error: 'm', responseCode: 'monthly_quota_exceeded' }, /Crediti Pseudora esauriti/],
    [{ error: 'm', responseCode: 'quota' }, /Crediti/],
    [{ error: 'm', responseCode: 'image_unsupported' }, /Formato immagine non supportato/],
    [{ error: 'Failed to fetch', responseCode: '' }, /non è riuscita a proteggere/],
    [{ error: 'timeout', responseCode: 'timeout' }, /non ha risposto in tempo/],
    [{ ...ok, safe: 'true' }, /non è riuscita/],
    [{ ...ok, image_base64: '' }, /non è riuscita/],
    [{ ...ok, format: 'jpeg' }, /non è riuscita/],         // clipboard takes PNG only, never convert silently
    [undefined, /non è riuscita/],
  ];
  for (const [reply, msg] of unsafe) {
    t = io(reply, { route: 'attach' });
    r = await S.protectShot(crop, t.io);
    assert.equal(r.outcome, 'error', JSON.stringify(reply));
    assert.match(r.message, msg);
    assert.match(r.message, /L'immagine originale non è stata inviata/);
    assert.equal(t.log.attached.length + t.log.copied.length, 0, 'nothing delivered on error');
  }

  // Too large: refused before the network.
  t = io(ok);
  r = await S.protectShot({ size: 10_000_001 }, t.io);
  assert.equal(r.outcome, 'error');
  assert.equal(t.log.sent.length, 0);

  // Cancelled while the Cloud works: the late reply is dropped.
  t = io(ok, { cancelled: () => true });
  r = await S.protectShot(crop, t.io);
  assert.equal(r.outcome, 'cancelled');
  assert.equal(t.log.attached.length + t.log.copied.length, 0);
}

// image-guard attach on ChatGPT: the site's paste handler gets the protected file and the
// guard does not intercept it again (no second REDACT_IMAGE).
{
  const window = new Window({ url: 'https://chatgpt.com/' });
  const { document } = window;
  document.body.innerHTML = '<form><textarea name="prompt"></textarea><div id="att"></div></form>';
  document.querySelector('textarea').getClientRects = () => [{}];
  const sent = [];
  window.chrome = {
    i18n: it,
    runtime: { id: 'ext', lastError: null, getURL: p => p, sendMessage(m, cb) { if (m.type !== 'GET_DOC_TYPES') sent.push(m); cb({}); }, onMessage: { addListener() {} } },
    storage: { sync: { get(d, cb) { cb({ ...d, interceptSend: true, protectImages: true }); } }, onChanged: { addListener() {} } },
  };
  window.eval(coreSrc);
  window.eval(composerSrc);
  window.eval(panelSrc);
  window.eval(guardSrc);
  window.eval(shotSrc);
  const got = [];
  let showThumb = true;
  window.addEventListener('paste', ev => {
    got.push([...ev.clipboardData.files].map(f => f.name));
    if (showThumb) document.getElementById('att').appendChild(document.createElement('img'));   // site shows a thumbnail
  });
  const G = window.PseudoraImageGuard;
  G.timing.verifyMs = 60; G.timing.pollMs = 10;
  assert.equal(window.PseudoraScreenshot.route({ site: window.PseudoraComposer.forHost('chatgpt.com'), hasComposer: true }), 'attach');
  assert.equal(await G.attach([new window.File(['redacted'], 'screenshot-protetto.png', { type: 'image/png' })]), true, 'resolves once the site shows it');
  assert.deepEqual(got, [['screenshot-protetto.png']]);
  assert.equal(sent.length, 0, 'the protected copy is not sent to the Cloud again');
  assert.equal(document.getElementById('pii-main-panel'), null, 'one notification channel: no image panel next to the toast');

  // The site never shows the attachment: resolves false, still no panel (the toast reports the clipboard copy).
  showThumb = false;
  assert.equal(await G.attach([new window.File(['redacted'], 'b.png', { type: 'image/png' })]), false);
  assert.equal(document.getElementById('pii-main-panel'), null);

  // No composer on the page: attach refuses, so the caller falls back to the clipboard.
  document.querySelector('form').remove();
  assert.equal(G.attach([new window.File(['x'], 'a.png', { type: 'image/png' })]), false);
}

// Gemini and other sites: no attach hook, so screenshots go to the clipboard.
{
  const window = new Window({ url: 'https://example.com/' });
  window.chrome = { i18n: it, runtime: { id: 'ext', onMessage: { addListener() {} } }, storage: { sync: { get() {} }, onChanged: { addListener() {} } } };
  window.eval(coreSrc); window.eval(composerSrc); window.eval(guardSrc); window.eval(shotSrc);
  assert.equal(window.PseudoraImageGuard.attach([]), false);
}

// Service worker: activeTab capture, on-demand injection, fail closed before capturing.
{
  let calls, settings, scriptingFails, present;
  const context = vm.createContext({
    AbortSignal, FormData, Blob, atob, btoa, Uint8Array, Number, setTimeout,
    crypto: { randomUUID: () => 'x' },
    fetch: async () => { calls.push(['fetch']); throw new Error('no network expected'); },
    chrome: {
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      commands: { onCommand: { addListener(fn) { context.onCommand = fn; } } },
      action: { setBadgeText: o => calls.push(['badge', o.text]), setBadgeBackgroundColor() {}, setTitle: o => calls.push(['title', o.title]) },
      storage: { sync: { get: async d => d }, local: { get: async d => d, set: async () => {} } },
      scripting: { executeScript: async o => {
        if (scriptingFails) throw new Error('Cannot access a chrome:// URL');
        calls.push(o.files ? ['inject', o.files] : ['probe']);
        return [{ result: o.func ? o.args[0].filter(n => !present.includes(n)) : undefined }];
      } },
      tabs: {
        captureVisibleTab: async (win, opts) => { calls.push(['capture', win, opts.format]); return 'data:image/png;base64,AAAA'; },
        sendMessage: async (tabId, m) => { calls.push(['send', tabId, m]); return { ok: true }; },
      },
    },
  });
  vm.runInContext(bgSrc, context);
  vm.runInContext('getSettings = async () => globalThis.__settings;', context);
  const start = () => vm.runInContext('startScreenshot(7, 3)', context);
  const reset = (s, p = []) => { calls = []; context.__settings = s; scriptingFails = false; present = p; };
  const logged = { piiApiUrl: 'https://api.test', oauthAccessToken: 't', oauthRefreshToken: '', piiApiKey: '' };

  // Any site: inject the three files, then capture PNG, then hand the capture to the tab.
  reset(logged);
  assert.equal((await start()).ok, true);
  assert.deepEqual(calls.map(c => c[0]), ['probe', 'inject', 'capture', 'send']);
  assert.deepEqual([...calls[1][1]], ['src/core.js', 'src/composer.js', 'src/image-guard.js', 'src/screenshot.js']);
  assert.deepEqual(calls[2], ['capture', 3, 'png']);
  assert.equal(calls[3][2].type, 'SCREENSHOT_START');
  assert.equal(calls[3][2].dataUrl, 'data:image/png;base64,AAAA');

  // ChatGPT/Claude with the manifest content scripts: nothing re-injected (no duplicate paste guard).
  reset(logged, ['PseudoraCore', 'PseudoraComposer', 'PseudoraImageGuard', 'PseudoraScreenshot']);
  await start();
  assert.deepEqual(calls.map(c => c[0]), ['probe', 'capture', 'send']);

  // Not logged in: the tab shows the error, nothing is captured, nothing hits the network.
  reset({ piiApiUrl: 'https://api.test', oauthAccessToken: '', oauthRefreshToken: '', piiApiKey: '' });
  assert.equal((await start()).responseCode, 'not_configured');
  assert.deepEqual(calls.map(c => c[0]), ['probe', 'inject', 'send']);
  assert.equal(calls[2][2].error, 'not_configured');
  assert.equal(calls[2][2].dataUrl, undefined);
  reset({ piiApiUrl: '', piiApiKey: 'k' });
  assert.equal((await start()).responseCode, 'not_configured');
  assert.equal(calls.some(c => c[0] === 'capture'), false);

  // chrome:// and Web Store pages: refused with a reason, no capture.
  reset(logged); scriptingFails = true;
  const err = await start().catch(e => e);
  assert.equal(err.responseCode, 'not_capturable');
  assert.equal(calls.some(c => c[0] === 'capture'), false);

  // Keyboard shortcut: same flow; a failure lands on the badge.
  reset(logged);
  context.onCommand('protected-screenshot', { id: 7, windowId: 3 });
  await sleep(10);
  assert.deepEqual(calls.map(c => c[0]), ['probe', 'inject', 'capture', 'send']);
  reset(logged); scriptingFails = true;
  context.onCommand('protected-screenshot', { id: 7, windowId: 3 });
  await sleep(10);
  assert.deepEqual(calls.find(c => c[0] === 'badge'), ['badge', '!']);
  assert.match(calls.find(c => c[0] === 'title')[1], /non può catturare/);
  reset(logged);
  context.onCommand('something-else', { id: 7, windowId: 3 });
  await sleep(10);
  assert.equal(calls.length, 0);
}
console.log('screenshot: ok');
