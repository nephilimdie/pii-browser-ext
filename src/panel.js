/**
 * One Pseudora panel for text and images: same shell, same place, same theme, same keyboard
 * behaviour. content.js (text) and image-guard.js (images) fill it; only one is open at a time.
 * The panel is a non-modal dialog anchored to the page button, never on top of it.
 * Exposes `globalThis.PseudoraPanel`. Loaded after core.js, before image-guard.js/content.js.
 */
(function () {
  'use strict';
  if (globalThis.PseudoraPanel || typeof document === 'undefined') return;
  const { t } = globalThis.PseudoraCore;
  const GAP = 8;
  const MARGIN = 8;
  const MAX_WIDTH = 440;
  let current = null;                 // { owner, panel, onClose, returnTo }
  let seq = 0;

  /**
   * Why: the host site decides light or dark (ChatGPT can differ from the OS setting).
   * What: 'dark' when the page background is dark, else 'light'; OS preference as fallback.
   * Test: tests/panel.mjs, a #212121 body yields 'dark'.
   */
  function pageTheme() {
    for (const el of [document.body, document.documentElement]) {
      const m = el && getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || m[4] === '0') continue;
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45 ? 'dark' : 'light';
    }
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /** Applies the page theme to every Pseudora surface in the page (button, panel). */
  function syncTheme() {
    const theme = pageTheme();
    document.querySelectorAll('.pii-ui').forEach(n => n.setAttribute('data-pii-theme', theme));
    return theme;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** A shell button: variant '' (primary), 'secondary', 'quiet' or 'caution'. */
  function button(label, variant, onClick) {
    const b = el('button', `pii-btn${variant ? ` pii-btn-${variant}` : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Why: in a narrow window the 1.2.x panel covered the composer and its own button.
   * What: anchors the panel above the page button (below it when there is more room there),
   *       right-aligned to it, width ≤ 440px, height limited to the free space.
   * Test: tests/panel.mjs, panel rect never intersects the toolbar rect.
   */
  function reposition() {
    if (!current) return;
    const p = current.panel;
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.min(MAX_WIDTH, vw - 2 * MARGIN);
    const bar = document.getElementById('pii-protect-toolbar');
    const tb = bar && bar.style.display !== 'none' ? bar.getBoundingClientRect() : null;
    Object.assign(p.style, { width: `${width}px`, top: '', bottom: '' });
    if (!tb || !tb.width) {
      Object.assign(p.style, { right: `${MARGIN * 2}px`, bottom: `${MARGIN * 2}px`, maxHeight: `${vh - 4 * MARGIN}px` });
      return;
    }
    const right = Math.min(Math.max(MARGIN, vw - tb.right), vw - width - MARGIN);
    const above = tb.top - GAP - MARGIN, below = vh - tb.bottom - GAP - MARGIN;
    p.style.right = `${right}px`;
    if (above >= Math.min(320, below)) {
      Object.assign(p.style, { bottom: `${vh - tb.top + GAP}px`, maxHeight: `${Math.max(160, above)}px` });
    } else {
      Object.assign(p.style, { top: `${tb.bottom + GAP}px`, maxHeight: `${Math.max(160, below)}px` });
    }
  }

  /**
   * Why: text and image flows must look and behave as one product.
   * What: replaces any open panel with a new shell: header (title, subtitle, close), scrolling
   *       body, footer, and an assertive live region for errors. Esc closes it; focus moves in
   *       and returns to where it came from. Returns { panel, body, foot, alert, setSubtitle }.
   * Test: tests/panel.mjs (role, labelling, Esc, focus return, single instance).
   * @param {{ owner: string, title: string, subtitle?: string, onClose?: (reason: string) => void, returnTo?: Element }} opts
   */
  function open({ owner, title, subtitle = '', onClose, returnTo }) {
    const previousFocus = returnTo || (current ? current.returnTo : document.activeElement);
    close(null, 'replaced');
    const id = `pii-panel-${++seq}`;
    const panel = el('section', 'pii-ui pii-panel');
    panel.id = 'pii-main-panel';
    panel.dataset.owner = owner;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', `${id}-title`);

    const head = el('header', 'pii-panel-head');
    const mark = el('img', 'pii-panel-mark');
    mark.src = chrome.runtime.getURL('icons/icon48.png');
    mark.alt = '';
    const titles = el('div', 'pii-panel-titles');
    const h = el('h2', 'pii-panel-title', title);
    h.id = `${id}-title`;
    h.tabIndex = -1;
    const sub = el('p', 'pii-panel-sub', subtitle);
    sub.hidden = !subtitle;
    titles.append(h, sub);
    const x = el('button', 'pii-panel-close');
    x.type = 'button';
    x.setAttribute('aria-label', t('panelClose'));
    x.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    x.addEventListener('click', () => close(owner, 'dismissed'));
    head.append(mark, titles, x);

    const alert = el('div', 'pii-panel-alert');
    alert.setAttribute('role', 'alert');
    const body = el('div', 'pii-panel-body');
    const foot = el('footer', 'pii-panel-foot');
    panel.append(head, alert, body, foot);
    panel.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(owner, 'dismissed');
    });

    document.body.appendChild(panel);
    current = { owner, panel, onClose, returnTo: previousFocus };
    syncTheme();
    reposition();
    h.focus({ preventScroll: true });
    return {
      panel, body, foot, alert,
      setSubtitle(text) { sub.textContent = text || ''; sub.hidden = !text; },
    };
  }

  /**
   * Closes the panel (only when `owner` matches, or any panel when owner is null), runs its
   * onClose(reason) and puts focus back where it was, falling back to the page button.
   */
  function close(owner = null, reason = 'closed') {
    if (!current || (owner && current.owner !== owner)) return false;
    const { panel, onClose, returnTo } = current;
    const hadFocus = panel.contains(document.activeElement);
    current = null;
    panel.remove();
    try { onClose?.(reason); } catch (_) {}
    if (hadFocus && reason !== 'replaced') {
      const target = returnTo?.isConnected ? returnTo : document.querySelector('#pii-protect-toolbar .pii-shield-btn');
      target?.focus?.({ preventScroll: true });
    }
    return true;
  }

  window.addEventListener('resize', reposition);
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncTheme);

  globalThis.PseudoraPanel = Object.freeze({
    open, close, reposition, syncTheme, pageTheme, button, el,
    owner: () => current?.owner || null,
    isOpen: owner => !!current && (!owner || current.owner === owner),
  });
})();
