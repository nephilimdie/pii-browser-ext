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

  const t = (key, subs) => globalThis.PseudoraCore.t(key, subs);
  /** Messages, read lazily so chrome.i18n picks the browser language. */
  const TEXT = Object.freeze({
    get hint() { return t('shotHint'); },
    get full() { return t('shotFullArea'); },
    get cancel() { return t('shotCancel'); },
    get working() { return t('shotWorking'); },
    get attached() { return t('shotAttached'); },
    get copied() { return t('shotCopied'); },
    get copyFailed() { return t('shotCopyFailed'); },
    get copy() { return t('shotCopy'); },
    get close() { return t('actionClose'); },
  });

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
    const summary = t('imgSummary', { summary: G.summarize([resp]) });
    const file = new File([G.base64ToBytes(resp.image_base64)], 'screenshot-protetto.png', { type: 'image/png' });
    if (io.route === 'attach' && await io.attach([file])) return { outcome: 'attached', summary, file };
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
  let host = null, shadow = null, root = null, busy = false;

  // Brand tokens copied from src/tokens.css: the shadow root cannot see page or extension CSS.
  const CSS = `
    :host { all: initial; }
    .root { --ink: #0f1729; --muted: #5b647a; --surface: #fff; --line: #e6e9f2; --indigo: #4f46e5; --on-indigo: #fff;
      --err-bg: #fef2f2; --err-text: #991b1b; --err-line: #fecaca; --wash: #eef0ff;
      font: 14px/1.45 Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--ink); }
    .root.dark { --ink: #eef0f8; --muted: #a7aec2; --surface: #1a2036; --line: #2a3047; --indigo: #818cf8; --on-indigo: #0f1424;
      --err-bg: #3a1618; --err-text: #ffb4b4; --err-line: #5c2427; --wash: #23264a; }
    .layer { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .dim { position: absolute; inset: 0; background: rgba(15, 23, 41, .45); }
    .sel { position: absolute; border: 2px solid #818cf8; box-shadow: 0 0 0 100vmax rgba(15, 23, 41, .45); }
    .hint, .toast { position: fixed; left: 50%; transform: translateX(-50%); background: var(--surface); color: var(--ink);
      border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 14px 34px rgba(15, 23, 41, .22); box-sizing: border-box; }
    .hint { top: 16px; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 12px 10px 16px;
      cursor: default; width: max-content; max-width: calc(100vw - 24px); }
    .hint p { margin: 0; flex: 1 1 220px; }
    .toast { bottom: 24px; z-index: 2147483647; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
      padding: 12px 12px 12px 16px; width: max-content; max-width: min(560px, calc(100vw - 24px)); }
    .toast p { margin: 0; flex: 1 1 240px; min-width: 0; }
    .toast.error { background: var(--err-bg); color: var(--err-text); border-color: var(--err-line); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    button { font: 600 13px/1.2 inherit; font-family: inherit; border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px;
      cursor: pointer; background: var(--surface); color: var(--ink); white-space: nowrap; min-height: 36px; }
    button:hover { background: var(--wash); }
    button.primary { background: var(--indigo); border-color: var(--indigo); color: var(--on-indigo); }
    button:focus-visible { outline: 2px solid var(--indigo); outline-offset: 2px; }
    kbd { font: 600 12px/1 'IBM Plex Mono', ui-monospace, Menlo, monospace; border: 1px solid var(--line); border-radius: 5px; padding: 2px 5px; }
    @media (prefers-reduced-motion: no-preference) { .toast { animation: rise .18s ease-out; } }
    @keyframes rise { from { opacity: 0; transform: translate(-50%, 6px); } }`;

  /** Dark when the page's own background is dark (sites can differ from the OS setting). */
  function pageIsDark() {
    for (const n of [document.body, document.documentElement]) {
      const m = n && getComputedStyle(n).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (m && m[4] !== '0') return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.45;
    }
    return !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
  }

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
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(el('style', '', CSS));
    root = el('div', `root${pageIsDark() ? ' dark' : ''}`);
    shadow.appendChild(root);
    document.documentElement.appendChild(host);
    return root;
  }

  function clear(selector) { root?.querySelectorAll(selector).forEach(n => n.remove()); }

  function toast(text, { error = false, actions = [], ttl = 0, closable = true } = {}) {
    clear('.toast');
    const box = el('div', `toast${error ? ' error' : ''}`);
    box.setAttribute('role', error ? 'alert' : 'status');
    box.appendChild(el('p', '', text));
    const row = el('div', 'actions');
    actions.forEach(([label, fn, cls]) => {
      const b = el('button', cls || '', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      row.appendChild(b);
    });
    if (closable) row.appendChild(Object.assign(el('button', '', TEXT.close), { type: 'button', onclick: () => box.remove() }));
    box.appendChild(row);
    ensureRoot().appendChild(box);
    if (ttl) setTimeout(() => box.remove(), ttl);
  }

  async function decode(dataUrl) {
    const bytes = G.base64ToBytes(String(dataUrl).slice(String(dataUrl).indexOf(',') + 1));
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  }

  /**
   * Frozen capture + drag selection. Resolves with the crop rectangle in image pixels, or null (Esc).
   * Keyboard: Enter (or the focused button) takes the whole visible area, Esc cancels.
   */
  function select(bitmap) {
    return new Promise(resolve => {
      const layer = el('div', 'layer');
      const canvas = el('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const dim = el('div', 'dim');
      const box = el('div', 'sel');
      box.hidden = true;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const whole = () => cropRect({ x: 0, y: 0, width: viewport.width, height: viewport.height }, viewport, bitmap, window.devicePixelRatio || 1);
      const hint = el('div', 'hint');
      hint.setAttribute('role', 'dialog');
      hint.setAttribute('aria-label', 'Pseudora');
      const fullBtn = Object.assign(el('button', 'primary', TEXT.full), { type: 'button' });
      const cancelBtn = Object.assign(el('button', '', TEXT.cancel), { type: 'button' });
      const actions = el('div', 'actions');
      actions.append(fullBtn, cancelBtn);
      hint.append(el('p', '', TEXT.hint), actions);
      // Clicks on the bar are not selections.
      hint.addEventListener('pointerdown', e => e.stopPropagation());
      fullBtn.addEventListener('click', () => done(whole()));
      cancelBtn.addEventListener('click', () => done(null));
      layer.append(canvas, dim, box, hint);
      ensureRoot().appendChild(layer);
      const previous = document.activeElement;
      fullBtn.focus();
      let start = null;

      const done = rect => {
        window.removeEventListener('keydown', onKey, true);
        layer.remove();
        previous?.focus?.({ preventScroll: true });
        resolve(rect);
      };
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(null); return; }
        if (e.key === 'Enter' && !start) {
          e.preventDefault(); e.stopImmediatePropagation();
          // Enter on a focused bar button clicks it; anywhere else it takes the whole area.
          if (e.composedPath?.().includes(cancelBtn)) done(null); else done(whole());
          return;
        }
        if (e.key === 'Tab') {                         // keep focus on the two bar buttons
          e.preventDefault(); e.stopImmediatePropagation();
          (shadow.activeElement === fullBtn ? cancelBtn : fullBtn).focus();
        }
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
      toast(TEXT.working, { actions: [[TEXT.cancel, () => { cancelled.value = true; clear('.toast'); }]], closable: false });
      const result = await protectShot(crop, {
        send: G.safeSend,
        route: route({ site, hasComposer: !!site?.input(document) }),
        attach: files => (typeof G.attach === 'function' ? G.attach(files) : false),
        copy,
        cancelled: () => cancelled.value,
      });
      if (result.outcome === 'cancelled') return;
      if (result.outcome === 'error') { toast(result.message, { error: true }); return; }
      if (result.outcome === 'copy_failed') {
        toast(`${TEXT.copyFailed} ${result.summary}`, { actions: [[TEXT.copy, () => copy(result.file)
          .then(() => toast(`${TEXT.copied} ${result.summary}`, { ttl: 6000 }))
          .catch(() => toast(TEXT.copyFailed, { error: true })), 'primary']] });
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
