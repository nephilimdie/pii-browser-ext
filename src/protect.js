/**
 * "Carica file" page (popup button) and the target of the context menus.
 * Why: a file must be protected by the Cloud before it reaches a chatbot, also when it does
 *      not come from a paste in the composer (a file on disk, an image or file link on any page).
 * What: takes the one-shot job (#id) from the service worker, or lets the user pick a file;
 *       images go to REDACT_IMAGE with the uncertain-areas editor, PDF/DOCX/TXT to
 *       REDACT_DOCUMENT. The result is attached to the ChatGPT/Claude tab it came from, copied
 *       to the clipboard (images from other pages), or downloaded. Nothing is stored; the
 *       original never leaves this page except to the Cloud.
 * Test: tests/protect.mjs (job → fetch → redact → attach / copy; failures never deliver).
 */
(function () {
  'use strict';
  const C = globalThis.PseudoraCore;
  const R = globalThis.PseudoraReview;
  const t = (k, s) => C.t(k, s);
  const $ = id => document.getElementById(id);
  const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
  const DOC_EXT = /\.(pdf|docx|txt)$/i;
  const CHAT_HOSTS = ['chatgpt.com', 'claude.ai'];
  let job = { source: '', kind: '', tabId: null };
  let current = null;   // { file: File (deliverable, before burn), kind: 'image'|'document', state?, format? }
  let editorUrl = null;
  let previewSeq = 0;

  const send = msg => new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r)); }
    catch (e) { resolve({ error: e.message }); }
  });

  function show(section) {
    for (const id of ['pick', 'grant', 'status', 'error', 'result']) $(id).hidden = id !== section && !(section === 'error' && id === 'pick');
  }

  function fail(code) {
    const known = ['heic', 'unsupported', 'unsupported_file', 'too_large', 'image_too_large', 'quota', 'monthly_quota_exceeded',
      'in_progress', 'rate_limited', 'busy', 'timeout', 'unavailable', 'acl_forbidden', 'not_configured', 'network', 'ocr_no_text'];
    $('error-text').textContent = `${t(`img_${known.includes(code) ? code : 'failed'}`, { max: 4 })} ${t('imgNotSent')}`;
    show('error');
  }

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const fromBase64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  /** Any decodable image as PNG (GIF/SVG/BMP from the web): the Cloud takes PNG/JPEG/WebP only. */
  async function asPng(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return canvas.convertToBlob({ type: 'image/png' });
  }

  async function chatTab() {
    if (!Number.isSafeInteger(job.tabId)) return null;
    try {
      const tab = await chrome.tabs.get(job.tabId);
      return CHAT_HOSTS.includes(new URL(tab.url || '').hostname) ? tab : null;
    } catch (_) { return null; }
  }

  async function protect(file, name) {
    show('status');
    try {
      const type = String(file.type).toLowerCase();
      if (type.startsWith('image/') || (!type && /\.(png|jpe?g|webp)$/i.test(name))) {
        if (/hei[cf]/.test(type) || /\.(heic|heif)$/i.test(name)) return fail('heic');
        const blob = IMAGE_TYPES[type] ? file : await asPng(file).catch(() => null);
        if (!blob) return fail('unsupported');
        if (blob.size > 10_000_000) return fail('too_large');
        const format = IMAGE_TYPES[blob.type] || 'png';
        const resp = await send({ type: 'REDACT_IMAGE', data: toBase64(new Uint8Array(await blob.arrayBuffer())), format, visible: true, confirmed: true });
        if (resp?.error || resp?.safe !== true || typeof resp.image_base64 !== 'string') return fail(resp?.responseCode);
        const out = new File([fromBase64(resp.image_base64)], `immagine-protetta.${resp.format === 'jpeg' ? 'jpg' : resp.format}`, { type: `image/${resp.format}` });
        const layer = resp.confirmed_review
          ? new Blob([fromBase64(resp.confirmed_review.image_base64)], { type: `image/${resp.format}` }) : null;
        current = { kind: 'image', file: out, layer, format: resp.format, state: R.createState(resp), results: [resp] };
      } else if (DOC_EXT.test(name) || ['application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(type)) {
        const ext = (name.match(DOC_EXT) || [])[1] || { 'application/pdf': 'pdf', 'text/plain': 'txt' }[type] || 'docx';
        if (file.size > 20_000_000) return fail('too_large');
        const resp = await send({ type: 'REDACT_DOCUMENT', data: toBase64(new Uint8Array(await file.arrayBuffer())), name: name.replace(/\.[^.]*$/, '') + '.' + ext.toLowerCase() });
        if (resp?.error || resp?.safe !== true || typeof resp.data !== 'string') return fail(resp?.responseCode);
        current = { kind: 'document', file: new File([fromBase64(resp.data)], resp.name, { type: resp.type }), results: [resp] };
      } else {
        return fail('unsupported_file');
      }
      await render();
    } catch (_) { fail('failed'); }
  }

  async function render() {
    if (editorUrl) URL.revokeObjectURL(editorUrl);
    $('editor').replaceChildren();
    if (current.kind === 'image') {
      editorUrl = URL.createObjectURL(current.file);
      const editor = R.mount($('editor'), { src: editorUrl, state: current.state, onChange: async () => {
        const seq = ++previewSeq;
        try {
          const image = await R.burn(current.file, current.format, current.state, current.layer);
          if (seq !== previewSeq) return;
          const next = URL.createObjectURL(image);
          editor.setPreview(next);
          URL.revokeObjectURL(editorUrl);
          editorUrl = next;
        } catch (_) { fail('failed'); }
      } });
    } else {
      $('editor').appendChild(Object.assign(document.createElement('p'), { className: 'pii-img-doc', textContent: t('fileProtected', { name: current.file.name }) }));
    }
    const n = current.results.reduce((s, r) => s + (Number(r.entity_count) || 0), 0);
    $('summary').textContent = t(n === 1 ? 'imgCountOne' : 'imgCountMany', { n });
    const chat = await chatTab();
    $('attach').hidden = !chat;
    $('copy').hidden = !!chat || current.kind !== 'image';
    $('done').hidden = true;
    show('result');
  }

  /** The file to deliver: images get the covered areas burned into the server pixels. */
  async function deliverable() {
    if (current.kind !== 'image') return current.file;
    const blob = await R.burn(current.file, current.format, current.state, current.layer);
    return new File([blob], current.file.name, { type: blob.type });
  }

  function done(text) { $('done').textContent = text; $('done').hidden = false; }

  $('attach').addEventListener('click', async () => {
    try {
      const file = await deliverable();
      const data = toBase64(new Uint8Array(await file.arrayBuffer()));
      const resp = await new Promise(r => chrome.tabs.sendMessage(job.tabId, { type: 'PSEUDORA_ATTACH', files: [{ name: file.name, type: file.type, data }] },
        x => r(chrome.runtime.lastError ? null : x)));
      if (!resp?.ok) { done(t('protectAttachFailed')); return; }
      await chrome.tabs.update(job.tabId, { active: true });
      window.close();
    } catch (_) { done(t('protectAttachFailed')); }
  });

  $('copy').addEventListener('click', async () => {
    try {
      const file = await deliverable();
      const png = file.type === 'image/png' ? file : await asPng(file);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      done(t('protectCopied'));
    } catch (_) { done(t('protectCopyFailed')); }
  });

  $('download').addEventListener('click', async () => {
    try {
      const file = await deliverable();
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (_) { done(t('protectCopyFailed')); }
  });

  $('again').addEventListener('click', () => { current = null; job.source = ''; show('pick'); });

  $('file').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) protect(f, f.name); });
  const drop = $('drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('is-over'); const f = e.dataTransfer?.files?.[0]; if (f) protect(f, f.name); });

  /** Context menu source: fetched by this page (CORS, or the optional host permission the user grants). */
  async function fromSource() {
    const url = job.source;
    const name = decodeURIComponent((url.split(/[?#]/)[0].split('/').pop() || '')).slice(0, 80) || (job.kind === 'image' ? 'immagine.png' : 'documento');
    show('status');
    let blob = null;
    try { const r = await fetch(url, { credentials: 'omit' }); if (r.ok) blob = await r.blob(); } catch (_) {}
    if (blob) return protect(blob, name);
    const origin = /^https?:/i.test(url) ? new URL(url).origin : null;
    if (!origin) return fail('unsupported_file');
    $('grant-text').textContent = t('protectGrantText', { site: new URL(url).hostname });
    show('grant');
    $('grant-btn').onclick = async () => {
      const ok = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
      if (!ok) return fail('failed');
      show('status');
      try { const r = await fetch(url, { credentials: 'omit' }); if (!r.ok) throw new Error(); protect(await r.blob(), name); }
      catch (_) { fail('failed'); }
    };
  }

  (async () => {
    C.apply(document);
    const id = location.hash.slice(1);
    const resp = id ? await send({ type: 'TAKE_PROTECT_JOB', id }) : null;
    if (resp?.job) job = { source: String(resp.job.source || ''), kind: resp.job.kind || '', tabId: resp.job.tabId ?? null };
    if (job.source) fromSource(); else show('pick');
  })();
})();
