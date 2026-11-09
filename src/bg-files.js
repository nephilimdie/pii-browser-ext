/**
 * Service-worker side of "Carica file" and the context menus (loaded by background.js with
 * importScripts; uses its getSettings / getAuthHeaders / post / core). Documents (PDF, DOCX,
 * TXT) go to the Cloud's /v1/documents/redact; only a complete, Cloud-confirmed file is handed
 * back. Context-menu clicks open src/protect.html with a one-shot job in storage.session (the
 * page fetches the source, so nothing is downloaded before the user sees the page).
 * Exposes `globalThis.PseudoraFiles`.
 */
(function () {
  'use strict';

  const DOC_TYPES = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
  };
  const MAX_DOC_BYTES = 20_000_000;
  const DOC_TIMEOUT_MS = 150_000;
  const MENU_IMAGE = 'pseudora-protect-image';
  const MENU_FILE = 'pseudora-protect-file';
  const fail = (message, responseCode) => Object.assign(new Error(message), { responseCode });

  /** 'pdf' | 'docx' | 'txt' from a file name, or null. */
  const docKind = name => {
    const ext = String(name || '').toLowerCase().split(/[?#]/)[0].split('.').pop();
    return DOC_TYPES[ext] ? ext : null;
  };

  /** Complete file of that kind: PDF header + %%EOF trailer, DOCX zip header, any TXT. */
  function looksComplete(bytes, kind) {
    if (!bytes.length) return kind === 'txt';
    if (kind === 'pdf') {
      const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
      return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && tail.includes('%%EOF');
    }
    if (kind === 'docx') return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    return true;
  }

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /**
   * Why: a PDF/DOCX/TXT must be redacted by the Cloud before it reaches a chatbot.
   * What: multipart POST /v1/documents/redact with the user's document type; resolves to
   *       { safe: true, kind, type, name: "<name>-protetto.<ext>", data (base64), entity_count, types }
   *       only for a 200 with X-Pii-Redacted: true, the same format and complete bytes; any error
   *       rejects with a responseCode (fail closed; nothing is kept).
   * Test: tests/files-background.mjs.
   * @param {{ data: string, name: string }} msg
   */
  async function redactDocument({ data, name }) {
    const kind = docKind(name);
    if (!kind || typeof data !== 'string' || !data) throw fail('Unsupported file.', 'unsupported_file');
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    if (bytes.length > MAX_DOC_BYTES) throw fail('File too large.', 'too_large');
    const s = await getSettings();
    if (!s.piiApiUrl) throw fail('API URL not configured.', 'not_configured');
    const headers = await getAuthHeaders(s).catch(() => { throw fail('Not authenticated.', 'not_configured'); });
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: DOC_TYPES[kind] }), `documento.${kind}`);
    form.append('domain', core()?.requestFor(s.docType).image || 'generic_professional');
    const r = await post(s.piiApiUrl, '/v1/documents/redact', { headers, body: form }, DOC_TIMEOUT_MS);
    if (!r.ok) {
      const err = await r.json().catch(() => null);
      const code = typeof err?.error === 'string' ? err.error : (r.status === 401 ? 'not_configured' : r.status === 404 ? 'unavailable' : 'failed');
      throw fail(err?.message || `Pseudora: HTTP ${r.status}`, code === 'unsupported_type' ? 'unsupported_file' : code);
    }
    const type = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    const out = new Uint8Array(await r.arrayBuffer());
    const count = Number(r.headers.get('x-pii-entity-count'));
    if (r.status !== 200 || r.headers.get('x-pii-redacted') !== 'true' || type !== DOC_TYPES[kind]
        || !Number.isSafeInteger(count) || count < 0 || !looksComplete(out, kind)) {
      throw fail('Pseudora could not confirm safe processing. Nothing was sent.', 'failed');
    }
    const base = String(name).replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'documento';
    return {
      safe: true, kind, type, name: `${base}-protetto.${kind}`, data: toBase64(out), entity_count: count,
      types: (r.headers.get('x-pii-types') || '').split(',').filter(t => /^[A-Z][A-Z_]{0,39}$/.test(t)),
    };
  }

  /**
   * Why: the protect page must know what to work on without putting a URL in its address.
   * What: stores { source, kind, tabId } under a random id in storage.session, opens
   *       src/protect.html#<id>. Test: tests/files-background.mjs (job stored, then taken once).
   */
  async function openProtect({ source = '', kind = '', tabId = null } = {}) {
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ [`protect:${id}`]: { source: String(source).slice(0, 4096), kind, tabId } });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/protect.html#${id}`) });
    return { ok: true };
  }

  /** One-shot: returns the job and deletes it. */
  async function takeJob({ id }) {
    const key = `protect:${String(id || '').replace(/[^\w-]/g, '')}`;
    const job = (await chrome.storage.session.get(key))[key] || null;
    await chrome.storage.session.remove(key);
    return { job };
  }

/**
   * Why: the editor outlines uncertain areas; only their geometry and reason may reach the page.
   * What: up to 200 {id, reason, bbox} with bbox [x0, y0, x1, y1] fractions (0..1, x0<x1, y0<y1);
   *       anything else dropped (a dropped area then fails the count check for visible replies).
   * Test: tests/image-background.mjs, bad boxes filtered, review layer image never returned.
   */
  function reviewAreas(regions) {
    regions = Array.isArray(regions) ? regions.slice(0, 200) : [];
    return regions.filter(r => Number.isSafeInteger(r?.id) && Array.isArray(r.bbox) && r.bbox.length === 4
      && r.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1) && r.bbox[0] < r.bbox[2] && r.bbox[1] < r.bbox[3])
      .map(r => ({ id: r.id, reason: typeof r.reason === 'string' ? r.reason : 'unrecognized_ink', bbox: [...r.bbox] }));
  }

  chrome.runtime.onInstalled?.addListener(() => {
    const menus = chrome.contextMenus;
    if (!menus) return;
    menus.removeAll(() => {
      menus.create({ id: MENU_IMAGE, title: core()?.t('menuProtectImage') || 'Proteggi immagine con Pseudora', contexts: ['image'] });
      menus.create({ id: MENU_FILE, title: core()?.t('menuProtectFile') || 'Proteggi file con Pseudora', contexts: ['link'],
        targetUrlPatterns: ['*://*/*.pdf*', '*://*/*.docx*', '*://*/*.txt*', '*://*/*.PDF*', '*://*/*.DOCX*', '*://*/*.TXT*'] });
    });
  });

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    const image = info.menuItemId === MENU_IMAGE;
    if (!image && info.menuItemId !== MENU_FILE) return;
    const source = image ? info.srcUrl : info.linkUrl;
    if (typeof source !== 'string' || !/^(https?:|data:image\/)/i.test(source)) return;
    openProtect({ source, kind: image ? 'image' : 'file', tabId: Number.isSafeInteger(tab?.id) ? tab.id : null }).catch(() => {});
  });

  globalThis.PseudoraFiles = Object.freeze({ reviewAreas, redactDocument, openProtect, takeJob, docKind, looksComplete, DOC_TYPES });
})();
