/**
 * "Screenshot protetto": the service worker captures the visible tab (activeTab) and
 * sends it here; the user selects an area on the frozen capture, the crop is redacted by
 * the Cloud exactly like a pasted image (REDACT_IMAGE), then either attached to the
 * ChatGPT / Claude composer or copied to the clipboard.
 * Pure decisions live in `PseudoraScreenshot` (tested in Node); the overlay lives in a
 * closed shadow root, so the page's own scripts cannot read the original capture.
 * Fail closed: only a Cloud-confirmed image ever leaves this file; the capture is never
 * stored and is released as soon as the crop exists.
 * Needs composer.js and image-guard.js (manifest content scripts, or injected with them).
 */
(function () {
  'use strict';
  if (globalThis.PseudoraScreenshot) return;      // injected again by a second trigger

  const G = globalThis.PseudoraImageGuard;
  const MIN_CSS_PX = 8;

  const TEXT = {
    hint: "Trascina per selezionare l'area da proteggere · Esc per annullare",
    working: 'Protezione dello screenshot in corso…',
    attached: 'Screenshot protetto allegato.',
    copied: 'Screenshot protetto copiato negli appunti.',
    copyFailed: 'Screenshot protetto pronto, ma il browser non ha consentito la copia negli appunti.',
    copy: 'Copia negli appunti',
  };

  /**
   * Why: captureVisibleTab returns device pixels while the selection is in CSS pixels;
   *      with devicePixelRatio 2 (Retina) or page zoom a 1:1 crop cuts the wrong area.
   * What: maps a CSS-pixel selection (any drag direction) onto the capture, scaling by
   *       capture/viewport size (devicePixelRatio when the viewport is unknown) and
   *       clamping to the image; null when the area is smaller than 8 CSS px.
   * Test: tests/screenshot.mjs, {10,20,100,50} at dpr 2 on 2560x1600 → {20,40,200,100}.
   */
  function cropRect(sel, viewport, image, dpr = 1) {
    const x1 = Math.max(0, Math.min(sel.x, sel.x + sel.width));
    const y1 = Math.max(0, Math.min(sel.y, sel.y + sel.height));
    const x2 = Math.min(viewport.width || Infinity, Math.max(sel.x, sel.x + sel.width));
    const y2 = Math.min(viewport.height || Infinity, Math.max(sel.y, sel.y + sel.height));
    if (x2 - x1 < MIN_CSS_PX || y2 - y1 < MIN_CSS_PX) return null;
    const sx = viewport.width > 0 ? image.width / viewport.width : dpr;
    const sy = viewport.height > 0 ? image.height / viewport.height : dpr;
    const left = Math.round(x1 * sx), top = Math.round(y1 * sy);
    const right = Math.min(image.width, Math.round(x2 * sx)), bottom = Math.min(image.height, Math.round(y2 * sy));
    return right - left > 0 && bottom - top > 0 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }

  /**
   * Why: only ChatGPT and Claude accept the protected image through the image-guard path;
   *      Gemini and every other site get it on the clipboard.
   * What: 'attach' when the site supports image injection and a composer is on the page.
   * Test: chatgpt.com + composer → attach; chatgpt.com without composer, gemini, example.com → clipboard.
   */
  function route({ site, hasComposer }) {
    return site?.images && hasComposer ? 'attach' : 'clipboard';
  }

  /**
   * Why: the crop must follow the same fail-closed contract as a pasted image.
   * What: sends the PNG crop as REDACT_IMAGE; anything but a validResult() reply → error.
   *       Then attaches (io.attach returns false when it cannot) or copies the redacted
   *       PNG. Resolves to { outcome: attached|copied|copy_failed|error|cancelled, ... };
   *       the returned `file` is always the Cloud's redacted image, never the crop.
   * Test: tests/screenshot.mjs, error/unsafe replies never call attach or copy.
   * @param {Blob} crop
   * @param {{ send: Function, route: string, attach: Function, copy: Function, cancelled?: () => boolean }} io
   */
  async function protectShot(crop, io) {
    if (crop.size > 10_000_000) return { outcome: 'error', message: G.describeError('too_large') };
    const resp = await io.send({ type: 'REDACT_IMAGE', data: await G.fileToBase64(crop), format: 'png' });
    if (io.cancelled?.()) return { outcome: 'cancelled' };
    if (resp?.error || !G.validResult(resp) || resp.format !== 'png') return { outcome: 'error', message: G.describeError(resp) };
    const summary = `Oscurati: ${G.summarize([resp])}.`;
    const file = new File([G.base64ToBytes(resp.image_base64)], 'screenshot-protetto.png', { type: 'image/png' });
    if (io.route === 'attach' && io.attach([file])) return { outcome: 'attached', summary, file };
    try {
      await io.copy(file);
      return { outcome: 'copied', summary, file };
    } catch (_) {
      return { outcome: 'copy_failed', summary, file };
    }
  }

  globalThis.PseudoraScreenshot = Object.freeze({ cropRect, route, protectShot, TEXT });

  /* ── DOM wiring ───────────────────────────────────────────────────────────── */
  if (typeof document === 'undefined' || !globalThis.chrome?.runtime?.onMessage) return;

  const site = globalThis.PseudoraComposer?.forHost(location.hostname) || null;
  let host = null, root = null, busy = false;

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .dim { position: absolute; inset: 0; background: rgba(15, 23, 41, .45); }
    .sel { position: absolute; border: 2px solid #6366f1; box-shadow: 0 0 0 100vmax rgba(15, 23, 41, .45); }
    .hint, .toast { position: fixed; left: 50%; transform: translateX(-50%); font: 13px/1.45 system-ui, sans-serif;
      background: #0f1729; color: #fff; border-radius: 10px; padding: 10px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.3); }
    .hint { top: 16px; pointer-events: none; }
    .toast { bottom: 24px; z-index: 2147483647; display: flex; gap: 10px; align-items: center; max-width: min(560px, 92vw); }
    .toast.error { background: #7f1d1d; }
    button { font: inherit; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; background: #6366f1; color: #fff; white-space: nowrap; }
    button.ghost { background: transparent; border: 1px solid rgba(255,255,255,.4); }`;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  /** One closed shadow root for overlay and toast: the page cannot reach the capture. */
  function ensureRoot() {
    if (host?.isConnected) return root;
    host = document.createElement('pseudora-screenshot');
    root = host.attachShadow({ mode: 'closed' });
    root.appendChild(el('style', '', CSS));
    document.documentElement.appendChild(host);
    return root;
  }

  function clear(selector) { root?.querySelectorAll(selector).forEach(n => n.remove()); }

  function toast(text, { error = false, actions = [], ttl = 0 } = {}) {
    clear('.toast');
    const t = el('div', `toast${error ? ' error' : ''}`);
    t.setAttribute('role', error ? 'alert' : 'status');
    t.appendChild(el('span', '', text));
    actions.forEach(([label, fn, cls]) => {
      const b = el('button', cls || '', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      t.appendChild(b);
    });
    t.appendChild(Object.assign(el('button', 'ghost', 'Chiudi'), { type: 'button', onclick: () => t.remove() }));
    ensureRoot().appendChild(t);
    if (ttl) setTimeout(() => t.remove(), ttl);
  }

  async function decode(dataUrl) {
    const bytes = G.base64ToBytes(String(dataUrl).slice(String(dataUrl).indexOf(',') + 1));
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  }

  /** Frozen capture + drag selection. Resolves with the crop rectangle in image pixels, or null (Esc). */
  function select(bitmap) {
    return new Promise(resolve => {
      const layer = el('div', 'layer');
      const canvas = el('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const dim = el('div', 'dim');
      const box = el('div', 'sel');
      box.hidden = true;
      layer.append(canvas, dim, box, el('div', 'hint', TEXT.hint));
      ensureRoot().appendChild(layer);
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      let start = null;

      const done = rect => {
        window.removeEventListener('keydown', onKey, true);
        layer.remove();
        resolve(rect);
      };
      const onKey = e => {
        if (e.key !== 'Escape') return;
        e.preventDefault(); e.stopImmediatePropagation();
        done(null);
      };
      const draw = e => {
        const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
        Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - start.x)}px`, height: `${Math.abs(e.clientY - start.y)}px` });
      };
      window.addEventListener('keydown', onKey, true);
      layer.addEventListener('wheel', e => e.preventDefault(), { passive: false });
      layer.addEventListener('pointerdown', e => {
        start = { x: e.clientX, y: e.clientY };
        layer.setPointerCapture?.(e.pointerId);
        dim.hidden = true; box.hidden = false;
        draw(e);
      });
      layer.addEventListener('pointermove', e => { if (start) draw(e); });
      layer.addEventListener('pointerup', e => {
        if (!start) return;
        const rect = cropRect({ x: start.x, y: start.y, width: e.clientX - start.x, height: e.clientY - start.y },
          viewport, bitmap, window.devicePixelRatio || 1);
        start = null;
        if (rect) { done(rect); return; }
        dim.hidden = false; box.hidden = true;         // a click, not a drag: select again
      });
    });
  }

  async function cropToPng(bitmap, r) {
    const canvas = new OffscreenCanvas(r.width, r.height);
    canvas.getContext('2d').drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  const copy = file => navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);

  async function run(msg) {
    if (busy) return;
    if (msg.error || !msg.dataUrl) { toast(G.describeError(msg.error || 'failed'), { error: true }); return; }
    busy = true;
    let bitmap = null;
    const cancelled = { value: false };
    try {
      bitmap = await decode(msg.dataUrl);
      const rect = await select(bitmap);
      if (!rect) return;
      const crop = await cropToPng(bitmap, rect);
      bitmap.close(); bitmap = null;                 // the full capture is gone from here on
      toast(TEXT.working, { actions: [['Annulla', () => { cancelled.value = true; clear('.toast'); }, 'ghost']] });
      const result = await protectShot(crop, {
        send: G.safeSend,
        route: route({ site, hasComposer: !!site?.input(document) }),
        attach: files => typeof G.attach === 'function' && G.attach(files),
        copy,
        cancelled: () => cancelled.value,
      });
      if (result.outcome === 'cancelled') return;
      if (result.outcome === 'error') { toast(result.message, { error: true }); return; }
      if (result.outcome === 'copy_failed') {
        toast(`${TEXT.copyFailed} ${result.summary}`, { actions: [[TEXT.copy, () => copy(result.file)
          .then(() => toast(`${TEXT.copied} ${result.summary}`, { ttl: 6000 }))
          .catch(() => toast(TEXT.copyFailed, { error: true }))]] });
        return;
      }
      toast(`${result.outcome === 'attached' ? TEXT.attached : TEXT.copied} ${result.summary}`, { ttl: 6000 });
    } catch (_) {
      if (!cancelled.value) toast(G.describeError('failed'), { error: true });
    } finally {
      bitmap?.close();
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'SCREENSHOT_START') return false;
    sendResponse({ ok: !busy });
    run(msg);
    return false;
  });
})();
