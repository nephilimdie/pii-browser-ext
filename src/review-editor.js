/**
 * Uncertain areas editor (contract: Cloud `review_default=visible`).
 * The server image already hides every confirmed PII; uncertain areas come back visible
 * with their boxes, and the user covers/uncovers each one or draws extra areas. Export
 * burns opaque black boxes into the server pixels: covering only ever adds black, so it
 * can never reveal anything the server image did not already show.
 * Pure state functions are exposed for Node tests; mount() needs a DOM; burn() a canvas.
 * Loaded by content scripts (panel), src/protect.html. Exposes `globalThis.PseudoraReview`.
 */
(function () {
  'use strict';
  if (globalThis.PseudoraReview) return;

  const t = (key, subs) => globalThis.PseudoraCore.t(key, subs);
  const REASONS = ['low_confidence', 'unrecognized_ink', 'uncertain_mark'];
  const MAX_USER = 200;
  const MIN_SIDE = 0.01;
  const STEP = 0.01;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const validBox = b => Array.isArray(b) && b.length === 4 && b.every(v => typeof v === 'number' && v >= 0 && v <= 1)
    && b[0] < b[2] && b[1] < b[3];

  /**
   * Why: the reply decides what the user sees; anything malformed must never look "safe".
   * What: state { mode: 'visible'|'cover', areas: [{id, reason, bbox, covered}], user: [] };
   *       areas start uncovered only when the server echoed `visible` (an older server covered them);
   *       unknown reasons become `unrecognized_ink`; bad boxes are dropped.
   * Test: tests/review-editor.mjs, legacy reply → every area covered, mode 'cover'.
   */
  function createState(reply) {
    const mode = reply?.review_default === 'visible' ? 'visible' : 'cover';
    const areas = (Array.isArray(reply?.review_areas) ? reply.review_areas : []).slice(0, 200)
      .filter(a => Number.isSafeInteger(a?.id) && validBox(a?.bbox))
      .map(a => ({ id: a.id, reason: REASONS.includes(a.reason) ? a.reason : 'unrecognized_ink', bbox: [...a.bbox], covered: mode !== 'visible' }));
    return { mode, areas, user: [] };
  }

  /** "Area incerta: testo poco leggibile" etc. */
  const label = reason => t(`rev_${REASONS.includes(reason) ? reason : 'unrecognized_ink'}`);

  /** "2 visibili · 1 coperta" over server areas (user areas are always covered). */
  function summary(state) {
    const covered = state.areas.filter(a => a.covered).length;
    return t('revSummary', { visible: state.areas.length - covered, covered: covered + state.user.length });
  }

  const setAll = (state, covered) => { if (state.mode === 'visible') state.areas.forEach(a => { a.covered = covered; }); };
  const toggle = (state, id) => {
    const area = state.areas.find(a => a.id === id);
    if (area && state.mode === 'visible') area.covered = !area.covered;
  };

  /** Normalized user box from two drag corners (fractions); null when smaller than 1% a side. */
  function boxFrom(x0, y0, x1, y1) {
    const b = [clamp(Math.min(x0, x1), 0, 1), clamp(Math.min(y0, y1), 0, 1), clamp(Math.max(x0, x1), 0, 1), clamp(Math.max(y0, y1), 0, 1)];
    return b[2] - b[0] >= MIN_SIDE && b[3] - b[1] >= MIN_SIDE ? b : null;
  }

  /** Adds a user area (the centred default box when none given); false at the 200 limit or for a tiny box. */
  function addUser(state, bbox = [0.35, 0.42, 0.65, 0.52]) {
    if (state.user.length >= MAX_USER || !validBox(bbox) || bbox[2] - bbox[0] < MIN_SIDE || bbox[3] - bbox[1] < MIN_SIDE) return false;
    state.user.push([...bbox]);
    return true;
  }

  /**
   * Why: the keyboard path must reach everything the mouse can.
   * What: arrows move by 1%, Shift+arrows resize from the right/bottom edge (min 1%), Delete/Backspace
   *       removes; always clamped inside the image. Returns 'moved' | 'removed' | null (not handled).
   * Test: tests/review-editor.mjs, ArrowRight at the right edge stays inside; Shift+ArrowLeft stops at 1%.
   */
  function key(state, index, { key: k, shiftKey }) {
    const b = state.user[index];
    if (!b) return null;
    if (k === 'Delete' || k === 'Backspace') { state.user.splice(index, 1); return 'removed'; }
    const d = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[k];
    if (!d) return null;
    if (shiftKey) {
      b[2] = clamp(b[2] + d[0], b[0] + MIN_SIDE, 1);
      b[3] = clamp(b[3] + d[1], b[1] + MIN_SIDE, 1);
    } else {
      const dx = clamp(d[0], -b[0], 1 - b[2]);
      const dy = clamp(d[1], -b[1], 1 - b[3]);
      b[0] += dx; b[2] += dx; b[1] += dy; b[3] += dy;
    }
    return 'moved';
  }

  /**
   * Why: a box that hugs the glyphs can leave anti-aliased edges readable.
   * What: integer pixel rects for every covered server area and every user area, padded by
   *       max(3 px, 0.4% of the shorter side) and clipped to the image.
   * Test: tests/review-editor.mjs, [0,0,0.1,0.1] on 1000x500 → [0,0,103,53].
   */
  function rects(state, width, height) {
    const pad = Math.max(3, Math.round(0.004 * Math.min(width, height)));
    return [...state.areas.filter(a => a.covered).map(a => a.bbox), ...state.user].map(([x0, y0, x1, y1]) => [
      Math.max(0, Math.floor(x0 * width) - pad), Math.max(0, Math.floor(y0 * height) - pad),
      Math.min(width, Math.ceil(x1 * width) + pad), Math.min(height, Math.ceil(y1 * height) + pad),
    ]);
  }

  /**
   * Why: the exported file must contain a real redaction of what the user covered.
   * What: the server image with opaque #000 rects burned in, re-encoded in its format (no
   *       metadata: canvas output). With nothing covered the server bytes are returned as is.
   *       Rejects (never falls back to an uncovered copy) when decoding or encoding fails.
   * Test: tests/review-editor.mjs with a canvas stub: covered rect painted, format kept.
   * @param {Blob} blob server image   @param {string} format png|jpeg|webp
   */
  async function burn(blob, format, state) {
    if (!state.user.length && !state.areas.some(a => a.covered)) return blob;   // nothing to add: server bytes as is
    const bitmap = await createImageBitmap(blob);
    try {
      const list = rects(state, bitmap.width, bitmap.height);
      if (!list.length) return blob;
      const canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(bitmap, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      list.forEach(([x0, y0, x1, y1]) => ctx.fillRect(x0, y0, x1 - x0, y1 - y0));
      const type = `image/${format}`;
      const out = canvas.convertToBlob
        ? await canvas.convertToBlob({ type, quality: 0.92 })
        : await new Promise(r => canvas.toBlob(r, type, 0.92));
      if (!out || out.type !== type) throw new Error('encode failed');
      return out;
    } finally {
      bitmap.close?.();
    }
  }

  /* ── DOM editor ─────────────────────────────────────────────────────────────── */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function place(node, [x0, y0, x1, y1]) {
    Object.assign(node.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
  }

  /**
   * Why: one editor for the chat panel and the "Carica file" page.
   * What: renders note, preview with clickable overlays (Visibile / Coperta), Copri tutte /
   *       Mostra tutte, summary, "Disegna un'area da coprire" (drag) and "Aggiungi area"
   *       (keyboard), the list of user areas with ×. Mutates `state`; calls onChange().
   * Test: tests/review-editor.mjs (happy-dom): toggles, cover all, add + keys + remove.
   */
  function mount(container, { src, alt, state, onChange = () => {} }) {
    const root = el('div', 'pii-rev');
    let drawing = false;
    let focusUser = -1;
    const changed = () => { render(); onChange(state); };

    const note = el('p', 'pii-rev-note');
    const frame = el('div', 'pii-rev-frame');
    const img = el('img', 'pii-rev-img');
    img.src = src; img.alt = alt || t('imgPreviewAlt'); img.draggable = false;
    const layer = el('div', 'pii-rev-layer');
    frame.append(img, layer);
    const tools = el('div', 'pii-rev-tools');
    const coverAll = el('button', 'pii-btn pii-btn-secondary', t('revCoverAll'));
    const showAll = el('button', 'pii-btn pii-btn-secondary', t('revShowAll'));
    const draw = el('button', 'pii-btn pii-btn-secondary', t('revDraw'));
    const add = el('button', 'pii-btn pii-btn-secondary', t('revAdd'));
    [coverAll, showAll, draw, add].forEach(b => { b.type = 'button'; });
    draw.setAttribute('aria-pressed', 'false');
    const count = el('p', 'pii-rev-summary');
    count.setAttribute('aria-live', 'polite');
    const listTitle = el('p', 'pii-rev-list-title');
    const list = el('ul', 'pii-rev-list');
    tools.append(coverAll, showAll, draw, add);
    root.append(note, frame, tools, count, listTitle, list);
    container.appendChild(root);

    coverAll.addEventListener('click', () => { setAll(state, true); changed(); });
    showAll.addEventListener('click', () => { setAll(state, false); changed(); });
    draw.addEventListener('click', () => { drawing = !drawing; render(); });
    add.addEventListener('click', () => { if (addUser(state)) { focusUser = state.user.length - 1; changed(); } });

    // Drag to draw (pointer events; fractions of the displayed image).
    let start = null;
    let ghost = null;
    const at = e => {
      const r = frame.getBoundingClientRect();
      return [clamp((e.clientX - r.left) / (r.width || 1), 0, 1), clamp((e.clientY - r.top) / (r.height || 1), 0, 1)];
    };
    frame.addEventListener('pointerdown', e => {
      if (!drawing || e.button !== 0) return;
      e.preventDefault();
      start = at(e);
      ghost = el('span', 'pii-rev-box is-user is-ghost');
      layer.appendChild(ghost);
      frame.setPointerCapture?.(e.pointerId);
    });
    frame.addEventListener('pointermove', e => {
      if (!start || !ghost) return;
      const [x, y] = at(e);
      place(ghost, [Math.min(start[0], x), Math.min(start[1], y), Math.max(start[0], x), Math.max(start[1], y)]);
    });
    frame.addEventListener('pointerup', e => {
      if (!start) return;
      const [x, y] = at(e);
      const b = boxFrom(start[0], start[1], x, y);
      start = null; ghost?.remove(); ghost = null;
      if (b && addUser(state, b)) { focusUser = state.user.length - 1; changed(); }
    });

    function render() {
      note.hidden = !state.areas.length;
      note.textContent = state.mode === 'visible' ? t('revNoteVisible') : t('revNoteCovered');
      coverAll.hidden = showAll.hidden = state.mode !== 'visible' || !state.areas.length;
      draw.setAttribute('aria-pressed', String(drawing));
      draw.textContent = drawing ? t('revDrawStop') : t('revDraw');
      frame.classList.toggle('is-drawing', drawing);
      count.textContent = summary(state);
      layer.replaceChildren();
      state.areas.forEach((a, i) => {
        const b = el('button', `pii-rev-box ${a.covered ? 'is-covered' : 'is-visible'}`);
        b.type = 'button';
        place(b, a.bbox);
        b.title = `${label(a.reason)} (${i + 1})`;
        b.setAttribute('aria-label', `${label(a.reason)} ${i + 1}: ${t(a.covered ? 'revCovered' : 'revVisible')}. ${t(a.covered ? 'revShow' : 'revCover')}`);
        b.appendChild(el('span', 'pii-rev-tag', `${i + 1} · ${t(a.covered ? 'revCovered' : 'revVisible')}`));
        b.disabled = state.mode !== 'visible';
        b.addEventListener('click', e => { if (drawing) return; e.stopPropagation(); toggle(state, a.id); changed(); });
        layer.appendChild(b);
      });
      state.user.forEach((bbox, i) => {
        const u = el('span', 'pii-rev-box is-user is-covered');
        place(u, bbox);
        u.tabIndex = 0;
        u.setAttribute('role', 'group');
        u.setAttribute('aria-label', t('revUserArea', { n: i + 1 }));
        u.addEventListener('keydown', e => {
          const done = key(state, i, e);
          if (!done) return;
          e.preventDefault(); e.stopPropagation();
          focusUser = done === 'removed' ? Math.min(i, state.user.length - 1) : i;
          changed();
        });
        const x = el('button', 'pii-rev-remove', '×');
        x.type = 'button';
        x.setAttribute('aria-label', t('revRemove', { n: i + 1 }));
        x.addEventListener('click', e => { e.stopPropagation(); state.user.splice(i, 1); focusUser = -1; changed(); });
        u.appendChild(x);
        layer.appendChild(u);
      });
      listTitle.hidden = list.hidden = !state.user.length;
      listTitle.textContent = t('revUserList', { n: state.user.length });
      list.replaceChildren(...state.user.map((_, i) => {
        const li = el('li', '', t('revUserArea', { n: i + 1 }));
        const x = el('button', 'pii-rev-remove-inline', t('revRemoveShort'));
        x.type = 'button';
        x.addEventListener('click', () => { state.user.splice(i, 1); changed(); });
        li.appendChild(x);
        return li;
      }));
      if (focusUser >= 0) layer.querySelectorAll('.is-user')[focusUser]?.focus();
      focusUser = -1;
    }
    render();
    return { root, render };
  }

  globalThis.PseudoraReview = Object.freeze({ createState, summary, setAll, toggle, boxFrom, addUser, key, rects, burn, mount, label, MAX_USER });
})();
