/**
 * Image protection: images pasted, dropped or picked in the ChatGPT / Claude
 * composer are redacted by Pseudora before the site can upload them.
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
  const MAX_IMAGES = 4;
  const MAX_BYTES = 10_000_000;
  const NOT_SENT = " L'immagine originale non è stata inviata.";

  const MESSAGES = {
    heic: "Le foto HEIC non sono supportate: converti in JPEG/PNG e riprova.",
    unsupported: 'Formato immagine non supportato: converti in JPEG/PNG e riprova.',
    too_many: `Puoi proteggere al massimo ${MAX_IMAGES} immagini alla volta.`,
    too_large: "Immagine troppo grande: il limite è 10 MB.",
    image_too_large: "Immagine troppo grande (troppi pixel): riducila e riprova.",
    image_unsupported: 'Formato immagine non supportato: converti in JPEG/PNG e riprova.',
    invalid_document: "Il file non è un'immagine valida.",
    ocr_no_text: "Pseudora non ha riconosciuto testo, volti o codici in questa immagine, quindi non può confermarne la protezione. Se è sicura, disattiva \"Proteggi anche le immagini\" e riprova.",
    quota: 'Crediti Pseudora esauriti.',
    monthly_quota_exceeded: 'Crediti Pseudora esauriti.',
    in_progress: "Un'altra immagine è in elaborazione: attendi qualche secondo e riprova.",
    rate_limited: 'Troppe richieste a Pseudora: riprova tra poco.',
    rate_limit_exceeded: 'Troppe richieste a Pseudora: riprova tra poco.',
    busy: 'Pseudora è occupata: riprova tra poco.',
    timeout: 'Pseudora non ha risposto in tempo.',
    unavailable: 'La protezione immagini di Pseudora non è disponibile al momento.',
    acl_forbidden: 'Il tuo ruolo nel team non consente di proteggere le immagini.',
    not_configured: 'Pseudora non è configurata: apri il popup dell\'estensione ed effettua il login.',
    failed: "Pseudora non è riuscita a proteggere l'immagine.",
  };

  const LABELS = {
    FACE: ['volto', 'volti'], BARCODE: ['codice QR/a barre', 'codici QR/a barre'], LICENSE_PLATE: ['targa', 'targhe'],
    PERSON: ['nome', 'nomi'], EMAIL: ['email', 'email'], PHONE: ['telefono', 'telefoni'], IBAN: ['IBAN', 'IBAN'],
    FISCAL_CODE: ['codice fiscale', 'codici fiscali'], ADDRESS: ['indirizzo', 'indirizzi'], DATE_OF_BIRTH: ['data di nascita', 'date di nascita'],
  };

  /**
   * Why: only formats the Cloud redacts may be offered to it; a HEIC photo needs its own hint.
   * What: 'image' (png/jpeg/webp), 'heic', 'unsupported' (any other image/*) or 'other'.
   * Test: tests/image-guard.mjs, {type:'', name:'a.JPG'} is 'image', image/heic is 'heic'.
   */
  function classify(file) {
    const type = String(file?.type || '').toLowerCase();
    const ext = String(file?.name || '').toLowerCase().split('.').pop();
    if (HEIC.test(type) || HEIC.test(file?.name || '')) return 'heic';
    if (FORMATS[type] || (!type && EXTENSIONS[ext])) return 'image';
    return type.startsWith('image/') ? 'unsupported' : 'other';
  }

  /** Format ('png' | 'jpeg' | 'webp') of a file classify() accepted. */
  function formatOf(file) {
    return FORMATS[String(file.type).toLowerCase()] || EXTENSIONS[String(file.name).toLowerCase().split('.').pop()];
  }

  /**
   * Why: one event can mix images, other files and refused formats; the decision must be total.
   * What: { images, others, blocked } where blocked is a MESSAGES key or null; null when
   *       there is nothing for Pseudora to do (no images at all).
   * Test: [png, pdf] → 1 image, 1 other; [png, heic] → blocked 'heic'; [pdf] → null.
   */
  function plan(files) {
    const list = [...(files || [])];
    const kinds = list.map(classify);
    if (!kinds.some(k => k !== 'other')) return null;
    const blocked = kinds.includes('heic') ? 'heic' : kinds.includes('unsupported') ? 'unsupported' : null;
    const images = list.filter((_, i) => kinds[i] === 'image');
    return {
      images,
      others: list.filter((_, i) => kinds[i] === 'other'),
      blocked: blocked || (images.length > MAX_IMAGES ? 'too_many' : images.some(f => f.size > MAX_BYTES) ? 'too_large' : null),
    };
  }

  /** Italian user message for a refused event or a failed REDACT_IMAGE reply. */
  function describeError(codeOrReply) {
    const code = typeof codeOrReply === 'string' ? codeOrReply : codeOrReply?.responseCode || '';
    return (MESSAGES[code] || MESSAGES.failed) + NOT_SENT;
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
    const labels = [...new Set(results.flatMap(r => r.types || []))]
      .map(t => (LABELS[t] || [])[1] || t.toLowerCase().replace(/_/g, ' '));
    if (!n && !labels.length) return 'nessun dato personale trovato';
    return `${n} ${n === 1 ? 'elemento' : 'elementi'}${labels.length ? `: ${labels.join(', ')}` : ''}`;
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

  globalThis.PseudoraImageGuard = Object.freeze({
    classify, plan, describeError, validResult, summarize, protectedName, base64ToBytes, fileToBase64, safeSend,
    formatOf, timing, MAX_IMAGES,
  });

  /* ── DOM wiring (ChatGPT and Claude only) ──────────────────────────────────── */
  const SITES = {
    'chatgpt.com': { composer: '#prompt-textarea, div[contenteditable="true"][data-lexical-editor]', root: 'form' },
    'claude.ai': { composer: 'fieldset div[contenteditable="true"], div[contenteditable="true"][data-placeholder]', root: 'fieldset, form' },
  };
  const site = typeof location === 'undefined' ? null : SITES[location.hostname.replace(/^www\./, '')];
  if (!site || typeof document === 'undefined') return;

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
  const composer = () => document.querySelector(site.composer);
  const composerRoot = () => { const c = composer(); return c ? (c.closest(site.root) || c.parentElement) : null; };

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
        const resp = await safeSend({ type: 'REDACT_IMAGE', data: await fileToBase64(file), format: formatOf(file) });
        if (cancelled.value) return;
        if (resp?.error || !validResult(resp)) { showPanel({ error: describeError(resp) }); return; }
        results.push(resp);
      }
      const files = results.map((r, i) => new File([base64ToBytes(r.image_base64)], protectedName(r.format, i + 1), { type: `image/${r.format}` }));
      showPanel({
        results, files,
        onUse: () => deliver([...files, ...p.others], ctx),
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

  /** Inject, then wait for the site to show an attachment; otherwise offer the download. */
  function deliver(files, ctx) {
    const root = composerRoot();
    const before = attachmentMarks(root);
    if (!inject(files, ctx)) { showPanel({ fallback: files }); return; }
    showPanel({ status: 'Allego l\'immagine protetta…' });
    const started = Date.now();
    const poll = setInterval(() => {
      if (attachmentMarks(composerRoot()) > before) { clearInterval(poll); closePanel(); return; }
      if (Date.now() - started >= timing.verifyMs) { clearInterval(poll); showPanel({ fallback: files }); }
    }, timing.pollMs);
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

  /* ── Review panel ─────────────────────────────────────────────────────────── */
  let panel = null;
  const previews = [];

  function closePanel() {
    panel?.remove();
    panel = null;
    previews.splice(0).forEach(u => URL.revokeObjectURL(u));
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function button(label, cls, onClick) {
    const b = el('button', `pii-btn ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function showPanel({ loading, error, results, files, onUse, onCancel, fallback, status }) {
    closePanel();
    panel = el('div', 'pii-img-panel');
    panel.id = 'pii-img-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Pseudora — protezione immagine');
    panel.appendChild(el('div', 'pii-img-title', 'Pseudora · immagine'));
    const body = el('div', 'pii-img-body');
    const foot = el('div', 'pii-img-foot');
    panel.append(body, foot);

    if (loading) {
      body.appendChild(el('div', 'pii-img-status', 'Protezione dell\'immagine in corso…'));
      foot.appendChild(button('Annulla', 'pii-btn-outline', () => { onCancel?.(); closePanel(); }));
    } else if (status) {
      body.appendChild(el('div', 'pii-img-status', status));
    } else if (error) {
      body.appendChild(el('div', 'pii-img-error', error));
      foot.appendChild(button('Chiudi', 'pii-btn-outline', closePanel));
    } else if (fallback) {
      body.appendChild(el('div', 'pii-img-error', 'Non sono riuscito ad allegare l\'immagine protetta. Scaricala e allegala a mano (l\'originale non è stato inviato). Se compare già tra gli allegati, ignora questo messaggio.'));
      fallback.filter(f => classify(f) === 'image').forEach(f => foot.appendChild(button(`Scarica ${f.name}`, '', () => download(f))));
      foot.appendChild(button('Chiudi', 'pii-btn-outline', closePanel));
    } else {
      const grid = el('div', 'pii-img-previews');
      files.forEach(f => {
        const img = el('img', 'pii-img-preview');
        const url = URL.createObjectURL(f);
        previews.push(url);
        img.src = url; img.alt = 'Anteprima dell\'immagine protetta';
        grid.appendChild(img);
      });
      body.appendChild(grid);
      body.appendChild(el('div', 'pii-img-summary', `Oscurati: ${summarize(results)}.`));
      const review = results.reduce((n, r) => n + (Number(r.review_regions) || 0), 0);
      if (review) body.appendChild(el('div', 'pii-img-note', `${review} ${review === 1 ? 'area incerta oscurata' : 'aree incerte oscurate'} per sicurezza.`));
      foot.appendChild(button('Annulla', 'pii-btn-outline', closePanel));
      foot.appendChild(button('Usa immagine protetta', 'pii-img-use', () => onUse()));
    }
    document.body.appendChild(panel);
  }
})();
