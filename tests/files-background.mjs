import assert from 'node:assert/strict';
import vm from 'node:vm';

// Service-worker documents (REDACT_DOCUMENT) and the context-menu job hand-off:
// only a complete, Cloud-confirmed file comes back; jobs are one-shot.
import { src } from './helpers/env.mjs';
let reply;
let calls = [];
const session = {};
const tabs = [];
const menus = [];
const installed = [];
let clicked = () => {};
const context = vm.createContext({
  AbortSignal, FormData, Blob, atob, btoa, Uint8Array, Number, TextDecoder,
  crypto: { randomUUID: () => 'job-1' },
  fetch: async (url, init) => { calls.push({ url, init }); return reply(); },
  chrome: {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener(fn) { installed.push(fn); } }, getURL: p => `chrome-extension://ext/${p}` },
    storage: { sync: { get: async d => d }, local: { get: async d => d, set: async () => {} },
      session: { set: async o => Object.assign(session, o), get: async k => ({ [k]: session[k] }), remove: async k => { delete session[k]; } } },
    tabs: { create: async o => tabs.push(o.url) },
    contextMenus: { removeAll: cb => cb(), create: m => menus.push(m), onClicked: { addListener(fn) { clicked = fn; } } },
  },
});
vm.runInContext(await src('core.js'), context);
vm.runInContext(await src('bg-files.js'), context);
vm.runInContext(await src('background.js'), context);
vm.runInContext(`getSettings = async () => ({ piiApiUrl: 'https://api.test', docType: 'contract_analysis' });
  getAuthHeaders = async () => ({ Authorization: 'Bearer t' });`, context);
const run = code => vm.runInContext(code, context);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n%%EOF\n');
const doc = (body = PDF, headers = {}, status = 200) => () => new Response(body, { status, headers: {
  'Content-Type': 'application/pdf', 'X-Pii-Redacted': 'true', 'X-Pii-Entity-Count': '2', 'X-Pii-Types': 'PERSON,IBAN,<x>', ...headers } });
const ORIGINAL = Buffer.from('%PDF original Mario Rossi').toString('base64');

reply = doc();
const ok = JSON.parse(JSON.stringify(await run(`PseudoraFiles.redactDocument({ data: ${JSON.stringify(ORIGINAL)}, name: 'Contratto Rossi.pdf' })`)));
assert.equal(calls[0].url, 'https://api.test/v1/documents/redact');
assert.equal(calls[0].init.body.get('domain'), 'contract_analysis');
assert.equal(calls[0].init.body.get('file').name, 'documento.pdf', 'the original name never reaches the Cloud');
assert.deepEqual(ok, { safe: true, kind: 'pdf', type: 'application/pdf', name: 'Contratto Rossi-protetto.pdf',
  data: PDF.toString('base64'), entity_count: 2, types: ['PERSON', 'IBAN'] });

for (const [bad, code] of [
  [doc(Buffer.from('%PDF-1.7 truncated')), 'failed'],
  [doc(PDF, { 'X-Pii-Redacted': 'false' }), 'failed'],
  [doc(PDF, { 'Content-Type': 'text/plain' }), 'failed'],
  [doc(PDF, { 'X-Pii-Entity-Count': 'x' }), 'failed'],
  [() => new Response(JSON.stringify({ error: 'quota', safe: false }), { status: 402 }), 'quota'],
  [() => new Response(JSON.stringify({ error: 'unsupported_type', safe: false }), { status: 415 }), 'unsupported_file'],
]) {
  reply = bad;
  const err = await run(`PseudoraFiles.redactDocument({ data: ${JSON.stringify(ORIGINAL)}, name: 'a.pdf' })`).catch(e => e);
  assert.equal(err.responseCode, code);
}
calls = [];
assert.equal((await run(`PseudoraFiles.redactDocument({ data: 'AAAA', name: 'a.zip' })`).catch(e => e)).responseCode, 'unsupported_file');
assert.equal(calls.length, 0);

// Context menus: two entries; a click stores a one-shot job and opens the page with only its id.
installed.forEach(fn => fn());
assert.deepEqual(menus.map(m => [m.id, m.contexts[0]]), [['pseudora-protect-image', 'image'], ['pseudora-protect-file', 'link']]);
assert.ok(menus[1].targetUrlPatterns.includes('*://*/*.pdf*'));
clicked({ menuItemId: 'pseudora-protect-image', srcUrl: 'https://example.org/photo.jpg' }, { id: 7 });
await new Promise(r => setTimeout(r, 0));
assert.deepEqual(tabs, ['chrome-extension://ext/src/protect.html#job-1']);
assert.deepEqual(JSON.parse(JSON.stringify(await run(`PseudoraFiles.takeJob({ id: 'job-1' })`))),
  { job: { source: 'https://example.org/photo.jpg', kind: 'image', tabId: 7 } });
assert.deepEqual(JSON.parse(JSON.stringify(await run(`PseudoraFiles.takeJob({ id: 'job-1' })`))), { job: null }, 'one-shot');
clicked({ menuItemId: 'pseudora-protect-image', srcUrl: 'javascript:alert(1)' }, { id: 7 });
await new Promise(r => setTimeout(r, 0));
assert.equal(tabs.length, 1, 'only http(s) and data:image sources');
console.log('files-background: ok');
