import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { src, i18n } from './helpers/env.mjs';

// The shared panel: one instance, a labelled non-modal dialog, never on top of the page button
// (desktop and a 420px window), page-driven dark theme, Esc + focus return.
const [coreSrc, panelSrc] = await Promise.all(['core.js', 'panel.js'].map(src));
const it = await i18n('it');

function page({ width, height, toolbar, bg = '#ffffff' }) {
  const window = new Window({ url: 'https://chatgpt.com/', width, height });
  const { document } = window;
  document.body.style.backgroundColor = bg;
  document.body.innerHTML = '<div id="pii-protect-toolbar" class="pii-ui"><button class="pii-shield-btn">Protetto</button></div><textarea id="c"></textarea>';
  const bar = document.getElementById('pii-protect-toolbar');
  bar.getBoundingClientRect = () => ({ ...toolbar, width: toolbar.right - toolbar.left, height: toolbar.bottom - toolbar.top });
  window.chrome = { i18n: it, runtime: { getURL: p => p } };
  window.eval(coreSrc);
  window.eval(panelSrc);
  return { window, document, P: window.PseudoraPanel };
}

/** Panel rectangle from the inline position the shell computed. */
function rect(window, panel) {
  const px = v => parseFloat(v);
  const width = px(panel.style.width), right = window.innerWidth - px(panel.style.right);
  const maxH = px(panel.style.maxHeight);
  if (panel.style.bottom) { const bottom = window.innerHeight - px(panel.style.bottom); return { left: right - width, right, top: bottom - maxH, bottom }; }
  const top = px(panel.style.top); return { left: right - width, right, top, bottom: top + maxH };
}
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const [name, size, toolbar] of [
  ['desktop', { width: 1280, height: 820 }, { left: 1030, top: 664, right: 1160, bottom: 700 }],
  ['narrow 420px', { width: 420, height: 800 }, { left: 280, top: 650, right: 410, bottom: 686 }],
  ['toolbar near the top', { width: 1280, height: 820 }, { left: 900, top: 40, right: 1030, bottom: 76 }],
]) {
  const { window, document, P } = page({ ...size, toolbar });
  const shell = P.open({ owner: 'text', title: 'Pseudora' });
  const r = rect(window, shell.panel);
  assert.equal(overlaps(r, toolbar), false, `${name}: panel never covers the page button`);
  assert.ok(r.left >= 8 && r.right <= window.innerWidth - 8, `${name}: inside the viewport`);
  assert.ok(parseFloat(shell.panel.style.width) <= 440);
  assert.equal(document.querySelectorAll('.pii-panel').length, 1);
}

// One instance: an image panel replaces the text one (and tells it why).
{
  const { document, P } = page({ width: 1280, height: 820, toolbar: { left: 1030, top: 664, right: 1160, bottom: 700 } });
  const reasons = [];
  P.open({ owner: 'text', title: 'Pseudora', onClose: r => reasons.push(r) });
  const img = P.open({ owner: 'image', title: 'Immagine protetta' });
  assert.deepEqual(reasons, ['replaced']);
  assert.equal(document.querySelectorAll('.pii-panel').length, 1);
  assert.equal(P.owner(), 'image');
  assert.equal(img.panel.getAttribute('role'), 'dialog');
  assert.equal(img.panel.getAttribute('aria-modal'), 'false');
  assert.equal(document.getElementById(img.panel.getAttribute('aria-labelledby')).textContent, 'Immagine protetta');
  assert.equal(img.alert.getAttribute('role'), 'alert');
  assert.equal(P.close('text'), false, 'closing another owner is a no-op');
}

// Esc closes and focus returns to the opener.
{
  const { window, document, P } = page({ width: 1280, height: 820, toolbar: { left: 1030, top: 664, right: 1160, bottom: 700 } });
  const opener = document.querySelector('.pii-shield-btn');
  opener.focus();
  const shell = P.open({ owner: 'text', title: 'Pseudora' });
  assert.equal(document.activeElement, shell.panel.querySelector('.pii-panel-title'), 'focus moves into the dialog');
  shell.panel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(P.isOpen(), false);
  assert.equal(document.activeElement, opener);
  assert.equal(shell.panel.querySelector('.pii-panel-close').getAttribute('aria-label'), 'Chiudi il pannello');
}

// Theme follows the page: dark ChatGPT → dark panel and button.
{
  const { document, P } = page({ width: 1280, height: 820, bg: 'rgb(33, 33, 33)', toolbar: { left: 1030, top: 664, right: 1160, bottom: 700 } });
  const shell = P.open({ owner: 'text', title: 'Pseudora' });
  assert.equal(shell.panel.dataset.piiTheme, 'dark');
  assert.equal(document.getElementById('pii-protect-toolbar').dataset.piiTheme, 'dark');
  assert.equal(P.pageTheme(), 'dark');
}
console.log('panel: ok');
