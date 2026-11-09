/**
 * Image and document protection: images (and PDF/DOCX/TXT files) pasted, dropped or picked
 * in the ChatGPT / Claude composer are redacted by Pseudora before the site can upload them.
 * Uncertain image areas come back visible; the panel's editor (src/review-editor.js) lets the
 * user cover them or draw more, and the covered boxes are burned into the pixels on "Usa".
 * Pure decisions live in `PseudoraImageGuard` (tested in Node); the DOM wiring
 * at the bottom only runs on the supported sites. Loaded before content.js.
 * Fail closed: the original image is swallowed in the capture phase and only a
 * redacted copy, confirmed safe by the Cloud, is ever handed to the site.
 */
(function () {
  'use strict';

  const FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/webp': 'webp' };
  const EXTENSIONS = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };
  const HEIC = /^image\/hei[cf]|\.(heic|heif)$/i;
  const DOCUMENTS = { 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'text/plain': 'txt' };
  const DOC_EXT = /\.(pdf|docx|txt)$/i;
  const MAX_IMAGES = 4;
  const MAX_BYTES = 10_000_000;
  const MAX_DOC_BYTES = 20_000_000;
  const t = (key, subs) => globalThis.PseudoraCore.t(key, subs);
  // Refusal reasons with their own message (img_<code> in _locales); anything else is img_failed.
  const CODES = ['heic', 'unsupported', 'unsupported_file', 'too_many', 'too_large', 'image_too_large', 'image_unsupported', 'invalid_document',
    'ocr_no_text', 'quota', 'monthly_quota_exceeded', 'in_progress', 'rate_limited', 'rate_limit_exceeded', 'busy', 'timeout',
    'unavailable', 'acl_forbidden', 'not_configured', 'network', 'failed'];

  /**
   * Why: only formats the Cloud redacts may be offered to it; a HEIC photo needs its own hint.
   * What: 'image' (png/jpeg/webp), 'document' (pdf/docx/txt), 'heic', 'unsupported' (any other
   *       image/*) or 'other'.
   * Test: tests/image-guard.mjs, {type:'', name:'a.JPG'} is 'image', image/heic is 'heic'.
   */
  function classify(file) {
    const type = String(file?.type || '').toLowerCase();
    const ext = String(file?.name || '').toLowerCase().split('.').pop();
    if (HEIC.test(type) || HEIC.test(file?.name || '')) return 'heic';
    if (FORMATS[type] || (!type && EXTENSIONS[ext])) return 'image';
    if (DOCUMENTS[type] || ((!type || type === 'application/octet-stream') && DOC_EXT.test(file?.name || ''))) return 'document';
    return type.startsWith('image/') ? 'unsupported' : 'other';
  }

  /** Format ('png' | 'jpeg' | 'webp') of a file classify() accepted. */
  function formatOf(file) {
    return FORMATS[String(file.type).toLowerCase()] || EXTENSIONS[String(file.name).toLowerCase().split('.').pop()];
  }

  /**
   * Why: one event can mix images, other files and refused formats; the decision must be total.
   * What: { images, documents, blocked } where blocked is an img_<code> message code or null;
   *       null when there is nothing Pseudora can protect (other files alone pass as before).
   *       A file Pseudora cannot transform never rides along with protected ones.
   * Test: [png, pdf] → 1 image, 1 document; [png, zip] → blocked 'unsupported_file'; [zip] → null.
   */
  function plan(files) {
    const list = [...(files || [])];
    const kinds = list.map(classify);
    if (!kinds.some(k => k !== 'other')) return null;
    const blocked = kinds.includes('heic') ? 'heic' : kinds.includes('unsupported') ? 'unsupported' : null;
    const images = list.filter((_, i) => kinds[i] === 'image');
    const documents = list.filter((_, i) => kinds[i] === 'document');
    return {
      images, documents,
      blocked: blocked || (kinds.includes('other') ? 'unsupported_file'
        : images.length + documents.length > MAX_IMAGES ? 'too_many'
          : images.some(f => f.size > MAX_BYTES) || documents.some(f => f.size > MAX_DOC_BYTES) ? 'too_large' : null),
    };
  }

  /** User message for a refused event or a failed REDACT_IMAGE reply, always ending "not sent". */
  function describeError(codeOrReply) {
    const code = typeof codeOrReply === 'string' ? codeOrReply : codeOrReply?.responseCode || '';
    return `${t(`img_${CODES.includes(code) ? code : 'failed'}`, { max: MAX_IMAGES })} ${t('imgNotSent')}`;
  }

  /**
   * Why: an image is only usable when the Cloud explicitly confirmed it.
   * What: true for { safe: true, format in png/jpeg/webp, non-empty image_base64, types array }.
   * Test: safe 'true' (string), missing image or format 'gif' → false.
   */
  function validResult(r) {
    return r?.safe === true && typeof r.image_base64 === 'string' && r.image_base64.length > 0
      && ['png', 'jpeg', 'webp'].includes(r.format) && Array.isArray(r.types);
  }

  /**
   * Why: the user decides from "3 elementi: volti, IBAN", not from type codes.
   * What: total entity_count of every result + the distinct Italian type labels (Cloud order).
   * Test: [{entity_count:2,types:['FACE']},{entity_count:1,types:['IBAN']}] → '3 elementi: volti, IBAN'.
   */
  function summarize(results) {
    const n = results.reduce((sum, r) => sum + (Number(r.entity_count) || 0), 0);
    const labels = [...new Set(results.flatMap(r => r.types || []))].map(type => {
      const key = `entities_${type}`;
      const label = t(key);
      return label === key ? globalThis.PseudoraCore.entityLabel(type).toLowerCase() : label;
    });
    if (!n && !labels.length) return t('imgSummaryNone');
    const count = t(n === 1 ? 'imgCountOne' : 'imgCountMany', { n });
    return labels.length ? `${count}: ${labels.join(', ')}` : count;
  }

  /** "immagine-protetta-1.png": the original name never reaches the Cloud or the site. */
  function protectedName(format, index = 1) {
    return `immagine-protetta-${index}.${format === 'jpeg' ? 'jpg' : format}`;
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function fileToBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /**
   * Why: content scripts must never hit the network; the service worker does (no CORS).
   * What: chrome.runtime.sendMessage as a promise that resolves to { error } on any failure.
   * Test: tests/image-guard.mjs, a missing runtime id resolves with an error.
   */
  function safeSend(msg) {
    return new Promise(resolve => {
      try {
        if (!chrome.runtime?.id) { resolve({ error: 'Extension reloaded — refresh the page.' }); return; }
        chrome.runtime.sendMessage(msg, resp => {
          if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message }); return; }
          resolve(resp);
        });
      } catch (e) { resolve({ error: e.message }); }
    });
  }

  const timing = { verifyMs: 5000, pollMs: 250 };
  let attachImpl = null;      // set by the DOM wiring on ChatGPT / Claude

  globalThis.PseudoraImageGuard = Object.freeze({
    classify, plan, describeError, validResult, summarize, protectedName, base64ToBytes, fileToBase64, safeSend,
    formatOf, timing, MAX_IMAGES,
    /**
     * Hands already-protected files to the composer (screenshot.js) without opening the panel:
     * resolves true once the site shows the attachment, false when there is no composer or
     * it never appeared (the caller then copies to the clipboard: one notification channel).
     */
    attach: files => (attachImpl ? attachImpl(files) : false),
  });

  /* ── DOM wiring (ChatGPT and Claude only) ──────────────────────────────────── */
  const site = typeof location === 'undefined' ? null : globalThis.PseudoraComposer?.forHost(location.hostname);
  if (!site?.images || typeof document === 'undefined') return;

  let interceptSend = false;
  let protectImages = true;
  let bypass = false;          // true only while we dispatch the protected copy
  let busy = false;
  const swallowChange = new WeakSet();

  try {
    chrome.storage.sync.get({ interceptSend: false, protectImages: true }, s => { interceptSend = !!s.interceptSend; protectImages = s.protectImages !== false; });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.interceptSend) interceptSend = !!changes.interceptSend.newValue;
      if (changes.protectImages) protectImages = changes.protectImages.newValue !== false;
    });
  } catch (_) {}

  const enabled = () => interceptSend && protectImages && !bypass;
  const composerRoot = () => { const c = site.input(document); return c ? site.root(c) : null; };

  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** Files on a clipboard: `files` when the browser fills it, else the file items. */
  function clipboardFiles(data) {
    if (data?.files?.length) return [...data.files];
    return [...(data?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  }

  function onPaste(e) {
    if (!enabled()) return;
    const root = composerRoot();
    if (!root || !(root.contains(e.target) || e.target === root)) return;
    const p = plan(clipboardFiles(e.clipboardData));
    if (!p) return;
    swallow(e);
    // text/html is dropped on purpose: it can embed the original image as a data: URL.
    protect(p, { origin: 'paste', target: e.target, text: e.clipboardData?.getData('text/plain') || '' });
  }

  function onDrop(e) {
    if (!enabled()) return;
    const p = plan(e.dataTransfer?.files);
    if (!p) return;
    swallow(e);
    protect(p, { origin: 'drop', target: e.target });
  }

  function onFileInput(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    if (swallowChange.has(input) && e.type === 'change') { swallowChange.delete(input); swallow(e); return; }
    if (!enabled()) return;
    const p = plan(input.files);
    if (!p) return;
    swallow(e);
    input.value = '';                      // the site can no longer read the originals
    if (e.type === 'input') swallowChange.add(input);
    protect(p, { origin: 'input', target: input });
  }

  attachImpl = files => {
    const input = site.input(document);
    if (!input) return false;
    return deliver(files, { origin: 'paste', target: input }, { quiet: true });   // bypass: not intercepted again
  };

  // src/protect.html hands already-protected files (images burned, documents redacted) to this tab.
  chrome.runtime.onMessage?.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'PSEUDORA_ATTACH' || !Array.isArray(msg.files)) return false;
    const files = msg.files.slice(0, MAX_IMAGES).filter(f => typeof f?.data === 'string' && typeof f.name === 'string')
      .map(f => new File([base64ToBytes(f.data)], f.name.slice(0, 80), { type: String(f.type || '') }))
      .filter(f => ['image', 'document'].includes(classify(f)));
    if (!files.length) { sendResponse({ ok: false }); return false; }
    Promise.resolve(attachImpl(files)).then(ok => sendResponse({ ok: !!ok }), () => sendResponse({ ok: false }));
    return true;
  });

  window.addEventListener('paste', onPaste, true);
  window.addEventListener('drop', onDrop, true);
  window.addEventListener('input', onFileInput, true);
  window.addEventListener('change', onFileInput, true);

  async function protect(p, ctx) {
    if (p.blocked) { showPanel({ error: describeError(p.blocked) }); return; }
    if (busy) { showPanel({ error: describeError('in_progress') }); return; }
    busy = true;
    const cancelled = { value: false };
    showPanel({ loading: true, onCancel: () => { cancelled.value = true; } });
    try {
      const results = [];
      for (const file of p.images) {
        const resp = await safeSend({ type: 'REDACT_IMAGE', data: await fileToBase64(file), format: formatOf(file), visible: true });
        if (cancelled.value) return;
        if (resp?.error || !validResult(resp)) { showPanel({ error: describeError(resp) }); return; }
        results.push(resp);
      }
      const docs = [];
      for (const file of p.documents) {
        const resp = await safeSend({ type: 'REDACT_DOCUMENT', data: await fileToBase64(file), name: file.name });
        if (cancelled.value) return;
        if (resp?.error || resp?.safe !== true || typeof resp.data !== 'string') { showPanel({ error: describeError(resp) }); return; }
        docs.push(resp);
      }
      const files = results.map((r, i) => new File([base64ToBytes(r.image_base64)], protectedName(r.format, i + 1), { type: `image/${r.format}` }));
      const docFiles = docs.map(d => new File([base64ToBytes(d.data)], d.name, { type: d.type }));
      const states = results.map(r => globalThis.PseudoraReview.createState(r));
      showPanel({
        results: [...results, ...docs], files, docFiles, states,
        onUse: async () => {
          try {
            const burned = await Promise.all(files.map(async (f, i) => new File(
              [await globalThis.PseudoraReview.burn(f, results[i].format, states[i])], f.name, { type: f.type })));
            return deliver([...burned, ...docFiles], ctx);
          } catch (_) { showPanel({ error: describeError('failed') }); return false; }
        },
      });
    } catch (_) {
      if (!cancelled.value) showPanel({ error: describeError('failed') });
    } finally {
      busy = false;
    }
  }

  /* ── Handing the protected copy to the site ───────────────────────────────── */
  function attachmentMarks(root) {
    if (!root) return 0;
    return root.querySelectorAll('img, [data-testid*="attachment" i], [data-testid*="file" i], [aria-label*="remove" i], [aria-label*="rimuovi" i]').length;
  }

  function fileInput() {
    const root = composerRoot();
    return root?.querySelector('input[type="file"]') || document.querySelector('input[type="file"]');
  }

  /**
   * Why: the site must receive the protected copy through its own upload path.
   * What: re-dispatches the original gesture (paste/drop) with the protected files, or sets
   *       them on the file input; returns false when no target is left to receive them.
   * Test: tests/image-guard.mjs, the site's paste/change listener sees only protected files.
   */
  function inject(files, ctx) {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    bypass = true;
    try {
      const input = ctx.origin === 'input' && ctx.target.isConnected ? ctx.target : null;
      if (ctx.origin !== 'input' && ctx.target?.isConnected) {
        if (ctx.text) dt.setData('text/plain', ctx.text);
        const init = { bubbles: true, cancelable: true, composed: true };
        const ev = ctx.origin === 'paste'
          ? new ClipboardEvent('paste', { ...init, clipboardData: dt })
          : new DragEvent('drop', { ...init, dataTransfer: dt });
        if (ctx.origin === 'drop' && !ev.dataTransfer) Object.defineProperty(ev, 'dataTransfer', { value: dt });
        ctx.target.dispatchEvent(ev);
        return true;
      }
      const target = input || fileInput();
      if (!target) return false;
      target.files = dt.files;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) {
      return false;
    } finally {
      bypass = false;
    }
  }

  /**
   * Inject, then wait for the site to show an attachment. Resolves true when it does.
   * Without `quiet` the panel narrates the wait and offers the download on failure.
   */
  function deliver(files, ctx, { quiet = false } = {}) {
    const root = composerRoot();
    const before = attachmentMarks(root);
    if (!inject(files, ctx)) { if (!quiet) showPanel({ fallback: files }); return Promise.resolve(false); }
    if (!quiet) showPanel({ status: t('imgAttaching') });
    const started = Date.now();
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if (attachmentMarks(composerRoot()) > before) { clearInterval(poll); if (!quiet) UI().close('image', 'done'); resolve(true); return; }
        if (Date.now() - started >= timing.verifyMs) { clearInterval(poll); if (!quiet) showPanel({ fallback: files }); resolve(false); }
      }, timing.pollMs);
    });
  }

  function download(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  /* ── Review panel (the shared shell of src/panel.js) ──────────────────────── */
  const UI = () => globalThis.PseudoraPanel;
  const previews = [];
  let subtitle = '';

  /** "Tipo documento: <label>" for the header, shared with the text panel. */
  async function loadSubtitle(shell) {
    const [docs, store] = await Promise.all([
      safeSend({ type: 'GET_DOC_TYPES' }),
      new Promise(r => { try { chrome.storage.sync.get({ docType: '' }, r); } catch (_) { r({}); } }),
    ]);
    const C = globalThis.PseudoraCore;
    const value = store?.docType || C.DEFAULT_DOC_TYPE;
    const { groups } = C.docOptions(docs && !docs.error ? docs : {}, value);
    subtitle = t('imgSubtitle', { doc: C.docLabel(groups, C.requestFor(value).image) });
    shell.setSubtitle(subtitle);
  }

  function revokePreviews() { previews.splice(0).forEach(u => URL.revokeObjectURL(u)); }

  /** The uncertain-areas editor for one protected image (preview URL revoked with the panel). */
  function editor(body, file, state) {
    const url = URL.createObjectURL(file);
    previews.push(url);
    globalThis.PseudoraReview.mount(body, { src: url, alt: t('imgPreviewAlt'), state });
  }

  function showPanel({ loading, error, results, files, docFiles, states, onUse, onCancel, fallback, status }) {
    const ui = UI();
    if (!ui) return;
    revokePreviews();
    const shell = ui.open({
      owner: 'image', title: t('imgPanelTitle'), subtitle,
      onClose: reason => { if (loading && reason !== 'done') onCancel?.(); revokePreviews(); },
    });
    loadSubtitle(shell);
    shell.panel.id = 'pii-img-panel';
    const { body, foot, alert } = shell;
    const row = ui.el('div', 'pii-actions');
    foot.appendChild(row);
    const closeBtn = label => ui.button(label, 'secondary', () => ui.close('image', 'dismissed'));

    if (loading) {
      const s = ui.el('p', 'pii-img-status');
      s.setAttribute('role', 'status');
      s.append(ui.el('span', 'pii-spinner is-dark'), document.createTextNode(t('imgWorking')));
      body.appendChild(s);
      row.appendChild(closeBtn(t('actionCancel')));
    } else if (status) {
      const s = ui.el('p', 'pii-img-status', status);
      s.setAttribute('role', 'status');
      body.appendChild(s);
    } else if (error) {
      const box = ui.el('div', 'pii-notice is-error pii-img-error');
      box.append(ui.el('p', 'pii-notice-title', t('imgErrorTitle')), ui.el('p', 'pii-notice-detail', error));
      alert.appendChild(box);
      row.appendChild(closeBtn(t('actionClose')));
    } else if (fallback) {
      const box = ui.el('div', 'pii-notice is-policy pii-img-error');
      box.append(ui.el('p', 'pii-notice-title', t('imgFallbackTitle')), ui.el('p', 'pii-notice-detail', t('imgFallback')));
      alert.appendChild(box);
      fallback.filter(f => ['image', 'document'].includes(classify(f))).forEach(f => row.appendChild(ui.button(t('imgDownload', { name: f.name }), '', () => download(f))));
      row.appendChild(closeBtn(t('actionClose')));
    } else {
      files.forEach((f, i) => editor(body, f, states[i]));
      (docFiles || []).forEach(f => body.appendChild(ui.el('p', 'pii-img-doc', t('fileProtected', { name: f.name }))));
      body.appendChild(ui.el('p', 'pii-img-summary', t('imgSummary', { summary: summarize(results) })));
      const use = ui.button(t('imgUse'), '', () => onUse());
      use.classList.add('pii-img-use');
      row.append(use, closeBtn(t('actionCancel')));
    }
  }
})();
