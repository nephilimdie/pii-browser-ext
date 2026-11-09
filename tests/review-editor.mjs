import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

// Uncertain-areas editor: state from the Cloud reply, padded opaque rects, keyboard path,
// burn() paints only black and never falls back to an uncovered copy.
import { src, i18n } from './helpers/env.mjs';
const window = new Window({ url: 'chrome-extension://ext/src/protect.html' });
window.chrome = { i18n: await i18n('it') };
window.eval(await src('core.js'));
window.eval(await src('review-editor.js'));
const R = window.PseudoraReview;
const plain = v => JSON.parse(JSON.stringify(v));
const reply = (mode, extra = []) => ({ review_default: mode, review_areas: [
  { id: 4, reason: 'low_confidence', bbox: [0.1, 0.1, 0.2, 0.2] },
  { id: 5, reason: 'from-the-future', bbox: [0.3, 0.6, 0.5, 0.7] },
  { id: 6, reason: 'low_confidence', bbox: [0.5, 0.5, 0.4, 0.6] },   // inverted: dropped
  ...extra] });

// State: visible only when the server echoed it; unknown reasons are "uncertain", never safe.
const vis = R.createState(reply('visible'));
assert.equal(vis.mode, 'visible');
assert.deepEqual(plain(vis.areas.map(a => [a.id, a.reason, a.covered])), [[4, 'low_confidence', false], [5, 'unrecognized_ink', false]]);
const old = R.createState(reply(undefined));
assert.equal(old.mode, 'cover');
assert.ok(old.areas.every(a => a.covered), 'an older server covered them: shown as covered');
R.setAll(old, false);
assert.ok(old.areas.every(a => a.covered), 'cannot uncover what the server painted');

// Toggle / cover all / show all / summary.
R.toggle(vis, 4);
assert.equal(R.summary(vis), '1 visibili · 1 coperte');
R.setAll(vis, true);
assert.equal(R.summary(vis), '0 visibili · 2 coperte');
R.setAll(vis, false);

// Padded rects: max(3 px, 0.4% of the shorter side), clipped.
vis.areas[0].covered = true;
assert.deepEqual(plain(R.rects(vis, 1000, 500)), [[97, 47, 203, 103]]);
const edge = R.createState({ review_default: 'visible', review_areas: [{ id: 0, reason: 'low_confidence', bbox: [0, 0, 0.1, 0.1] }] });
edge.areas[0].covered = true;
assert.deepEqual(plain(R.rects(edge, 1000, 500)), [[0, 0, 103, 53]]);

// User areas: drag boxes (min 1%), centred default, keys, limit 200.
assert.equal(R.boxFrom(0.5, 0.5, 0.505, 0.9), null, 'thinner than 1%: ignored');
assert.deepEqual(plain(R.boxFrom(0.6, 0.8, 0.2, 0.4)), [0.2, 0.4, 0.6, 0.8]);
const u = R.createState(reply('visible'));
assert.ok(R.addUser(u));
assert.deepEqual(plain(u.user[0]), [0.35, 0.42, 0.65, 0.52]);
for (let i = 0; i < 50; i++) R.key(u, 0, { key: 'ArrowRight' });
assert.ok(Math.abs(u.user[0][2] - 1) < 1e-9 && u.user[0][0] > 0.69, 'clamped inside the image');
for (let i = 0; i < 50; i++) R.key(u, 0, { key: 'ArrowLeft', shiftKey: true });
assert.ok(Math.abs(u.user[0][2] - u.user[0][0] - 0.01) < 1e-9, 'resize stops at 1%');
assert.equal(R.key(u, 0, { key: 'a' }), null);
assert.equal(R.key(u, 0, { key: 'Delete' }), 'removed');
assert.equal(u.user.length, 0);
for (let i = 0; i < 200; i++) R.addUser(u);
assert.equal(R.addUser(u), false, 'at most 200');

// DOM: note, overlay click covers, cover all, add area + keyboard + remove.
const d = window.document;
const s = R.createState(reply('visible'));
R.mount(d.body, { src: 'blob:x', state: s });
const note = d.querySelector('.pii-rev-note');
assert.equal(note.hidden, false);
assert.match(note.textContent, /visibili per impostazione predefinita/);
const labels = [...d.querySelectorAll('.pii-rev-box')].map(b => b.title);
assert.deepEqual(labels, ['Area incerta: testo poco leggibile (1)', 'Area incerta: segni o scritte non riconosciuti (2)']);
d.querySelector('.pii-rev-box.is-visible').click();
assert.equal(d.querySelectorAll('.pii-rev-box.is-covered').length, 1);
const btn = label => [...d.querySelectorAll('button')].find(b => b.textContent === label);
btn('Copri tutte').click();
assert.equal(d.querySelectorAll('.pii-rev-box.is-visible').length, 0);
btn('Mostra tutte').click();
assert.equal(d.querySelectorAll('.pii-rev-box.is-covered').length, 0);
btn('Aggiungi area').click();
const added = d.querySelector('.pii-rev-box.is-user');
assert.equal(d.activeElement, added, 'the new area has focus');
added.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
assert.ok(Math.abs(s.user[0][1] - 0.43) < 1e-9);
assert.match(d.querySelector('.pii-rev-list-title').textContent, /Aree aggiunte da te \(1\)/);
d.querySelector('.pii-rev-box.is-user').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
assert.equal(s.user.length, 0);
assert.equal(d.querySelector('.pii-rev-list').hidden, true);

// burn(): nothing covered → server bytes untouched; covered → opaque black rects, same format.
const server = new window.Blob(['server-png'], { type: 'image/png' });
assert.equal(await R.burn(server, 'png', R.createState(reply('visible'))), server);
const painted = [];
window.createImageBitmap = async () => ({ width: 1000, height: 500, close() {} });
window.OffscreenCanvas = class {
  constructor(w, h) { this.w = w; this.h = h; }
  getContext() { return { drawImage() {}, set fillStyle(v) { this.fs = v; }, get fillStyle() { return this.fs; }, set globalAlpha(v) { this.ga = v; },
    fillRect: function (...r) { painted.push([this.fs, this.ga, ...r]); } }; }
  async convertToBlob({ type }) { return new window.Blob(['burned'], { type }); }
};
const cov = R.createState(reply('visible'));
cov.areas[0].covered = true;
R.addUser(cov, [0.9, 0.9, 1, 1]);
const out = await R.burn(server, 'png', cov);
assert.equal(out.type, 'image/png');
assert.deepEqual(painted, [['#000', 1, 97, 47, 106, 56], ['#000', 1, 897, 447, 103, 53]]);
window.OffscreenCanvas = class extends window.OffscreenCanvas { async convertToBlob() { return new window.Blob(['x'], { type: 'image/gif' }); } };
await assert.rejects(R.burn(server, 'png', cov), 'a failed encode never returns an uncovered copy');
console.log('review-editor: ok');
