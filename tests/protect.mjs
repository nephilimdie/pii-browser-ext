import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

// "Carica file" / context-menu page: the job's source is fetched here, protected by the
// service worker, shown in the editor, then attached to the chat tab or copied; failures never deliver.
import { src, i18n } from './helpers/env.mjs';
const html = await readFile(new URL('../src/protect.html', import.meta.url), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PNG_B64 = Buffer.from('server-png').toString('base64');

async function boot({ job, tabUrl = 'https://chatgpt.com/c/1', reply, fetchOk = true }) {
  const window = new Window({ url: 'chrome-extension://ext/src/protect.html#job-1' });
  window.document.write(html.replace(/<script[^>]*><\/script>/g, ''));
  const sent = [];
  const tabMessages = [];
  window.fetch = async () => (fetchOk ? new window.Response(new window.Blob(['original'], { type: 'image/png' })) : Promise.reject(new Error('cors')));
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
  window.chrome = {
    i18n: await i18n('it'),
    runtime: { lastError: null, sendMessage(msg, cb) { sent.push(msg); Promise.resolve(msg.type === 'TAKE_PROTECT_JOB' ? { job } : reply(msg)).then(cb); } },
    tabs: { get: async () => ({ url: tabUrl }), update: async () => {}, sendMessage(id, msg, cb) { tabMessages.push([id, msg]); cb({ ok: true }); } },
    permissions: { request: async () => false },
  };
  window.close = () => { window.closed = true; };
  for (const f of ['core.js', 'review-editor.js', 'protect.js']) window.eval(await src(f));
  await sleep(30);
  return { window, d: window.document, sent, tabMessages };
}
const okImage = () => ({ safe: true, format: 'png', image_base64: PNG_B64, entity_count: 2, types: ['FACE'], review_default: 'visible',
  review_areas: [{ id: 0, reason: 'uncertain_mark', bbox: [0.1, 0.1, 0.3, 0.2] }],
  protected_areas: [{ id: 'visual:0', type: 'FACE', bbox: [0.2, 0.2, 0.4, 0.4] }],
  confirmed_review: { content_type: 'image/png', image_base64: PNG_B64 } });

// Context menu on a ChatGPT tab: fetched, protected with visible areas, editor, "Allega alla chat".
{
  const t = await boot({ job: { source: 'https://cdn.example/x.png', kind: 'image', tabId: 9 }, reply: okImage });
  const redact = t.sent.find(m => m.type === 'REDACT_IMAGE');
  assert.equal(redact.visible, true);
  assert.equal(Buffer.from(redact.data, 'base64').toString(), 'original');
  assert.equal(t.d.getElementById('result').hidden, false);
  assert.match(t.d.body.textContent, /Possibile firma o timbro|visibili per impostazione predefinita/);
  assert.equal(t.d.getElementById('attach').hidden, false);
  assert.equal(t.d.getElementById('copy').hidden, true);
  t.d.getElementById('attach').click();
  await sleep(20);
  const [[tabId, msg]] = t.tabMessages;
  assert.equal(tabId, 9);
  assert.equal(msg.type, 'PSEUDORA_ATTACH');
  assert.equal(msg.files[0].data, PNG_B64, 'the server image (nothing covered) is what reaches the chat');
  assert.equal(t.window.closed, true);
}

// Any other page: "Copia negli appunti" instead of attach.
{
  const t = await boot({ job: { source: 'https://news.example/a.png', kind: 'image', tabId: 3 }, tabUrl: 'https://news.example/', reply: okImage });
  assert.equal(t.d.getElementById('attach').hidden, true);
  assert.equal(t.d.getElementById('copy').hidden, false);
}

// Cloud refusal: error shown, nothing to deliver.
{
  const t = await boot({ job: { source: 'https://cdn.example/x.png', kind: 'image', tabId: 9 }, reply: () => ({ error: 'x', responseCode: 'quota' }) });
  assert.equal(t.d.getElementById('error').hidden, false);
  assert.equal(t.d.getElementById('result').hidden, true);
  assert.equal(t.tabMessages.length, 0);
}

// Unreadable source (CORS): asks for the site's permission instead of failing silently.
{
  const t = await boot({ job: { source: 'https://private.example/doc.pdf', kind: 'file', tabId: 9 }, reply: okImage, fetchOk: false });
  assert.equal(t.d.getElementById('grant').hidden, false);
  assert.match(t.d.getElementById('grant-text').textContent, /private\.example/);
  assert.equal(t.sent.filter(m => m.type.startsWith('REDACT')).length, 0);
}

// No job (popup "Carica file"): the picker.
{
  const t = await boot({ job: null, reply: okImage });
  assert.equal(t.d.getElementById('pick').hidden, false);
}
console.log('protect: ok');
