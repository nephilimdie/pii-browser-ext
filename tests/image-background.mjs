import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Background REDACT_IMAGE: only a 200 safe JSON reply with intact image bytes is
// handed back; every other reply rejects (fail closed).
const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
let reply;
let calls = [];
const context = vm.createContext({
  AbortSignal, FormData, Blob, atob, btoa, Uint8Array, Number,
  crypto: { randomUUID: () => 'test-context' },
  fetch: async (url, init) => { calls.push({ url, init }); return reply(); },
  chrome: {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { sync: { get: async d => d }, local: { get: async d => d, set: async () => {} } },
  },
});
vm.runInContext(source, context);
vm.runInContext(`getSettings = async () => ({ piiApiUrl: 'https://api.test/' });
  getAuthHeaders = async () => ({ Authorization: 'Bearer t', 'X-Pii-Client': 'browser_extension' });`, context);
const run = code => vm.runInContext(code, context);

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const ORIGINAL = Buffer.from('original-screenshot').toString('base64');
const image = (bytes = PNG, fields = {}, status = 200, contentType = 'application/json') => () => new Response(JSON.stringify({
  safe: true, format: 'png', image_base64: Buffer.from(bytes).toString('base64'), entity_count: 3,
  review_regions: 2, type_counts: { PERSON: 2, FACE: 1 }, ...fields,
}), { status, headers: { 'Content-Type': contentType } });
const errorJson = (status, error) => () => new Response(JSON.stringify({ error, message: 'm', safe: false }), { status, headers: { 'Content-Type': 'application/json' } });

// Success: multipart upload of the image, bearer headers, 150 s timeout signal, decoded counts.
reply = image();
const ok = await run(`handleRedactImage({ data: ${JSON.stringify(ORIGINAL)}, format: 'png', domain: 'fine_appeal' })`);
assert.equal(calls[0].url, 'https://api.test/v1/images/redact');
assert.ok(calls[0].init.body instanceof FormData, 'multipart body');
const sent = calls[0].init.body.get('file');
assert.equal(sent.type, 'image/png');
assert.equal(calls[0].init.body.get('domain'), 'fine_appeal');
assert.equal(Buffer.from(await sent.arrayBuffer()).toString(), 'original-screenshot');
assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
assert.equal(calls[0].init.headers.Accept, 'application/json', 'without it the Cloud replies with image bytes');
assert.equal(calls[0].init.headers['Content-Type'], undefined, 'fetch must set the multipart boundary');
assert.ok(calls[0].init.signal instanceof AbortSignal);
assert.deepEqual({ ...ok, types: [...ok.types] }, {
  safe: true, format: 'png', image_base64: Buffer.from(PNG).toString('base64'),
  entity_count: 3, review_regions: 2, types: ['PERSON', 'FACE'],
});

reply = () => new Response(JSON.stringify({ mode: 'redact', domains: [
  { value: 'generic_professional', label: 'Generic' }, { value: 'fine_appeal', label: 'Fine appeal' },
] }), { headers: { 'Content-Type': 'application/json' } });
const options = await run('handleImageOptions()');
assert.equal(calls.at(-1).url, 'https://api.test/v1/images/options');
assert.equal(options.domains[1].value, 'fine_appeal');
reply = image();

// Fail closed: every unsafe reply rejects with a responseCode, never returns bytes.
const failures = [
  [errorJson(402, 'quota'), 'quota'],
  [errorJson(415, 'image_unsupported'), 'image_unsupported'],
  [errorJson(503, 'unavailable'), 'unavailable'],
  [() => new Response('<html>', { status: 401 }), 'not_configured'],
  [() => new Response('oops', { status: 500 }), 'failed'],
  [() => new Response('Not Found', { status: 404 }), 'unavailable'],   // Cloud without the route
  [image(PNG, { safe: false }), 'failed'],
  [image(PNG, { safe: 'true' }), 'failed'],
  [image(PNG, { image_base64: '%%%bad' }), 'failed'],
  [image(PNG, { type_counts: { FACE: -1 } }), 'failed'],
  [image(PNG, { entity_count: '3' }), 'failed'],
  [image(PNG, {}, 200, 'image/png'), 'failed'],
  [image(PNG, { format: 'gif' }), 'failed'],
  [image(PNG.subarray(0, 20)), 'failed'],                   // truncated: no IEND
  [image(Uint8Array.from([0xff, 0xd8, 1, 2])), 'failed'],
  [image(PNG, {}, 202), 'failed'],
  [() => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, 'timeout'],
];
for (const [failure, code] of failures) {
  reply = failure;
  const err = await run(`handleRedactImage({ data: ${JSON.stringify(ORIGINAL)}, format: 'png' })`).catch(e => e);
  assert.ok(err instanceof Error || err?.message, `must reject (${code})`);
  assert.equal(err.responseCode, code);
}

// Refused before any network call: HEIC/GIF formats, empty data.
calls = [];
for (const args of [`{ data: 'AAAA', format: 'heic' }`, `{ data: 'AAAA', format: 'gif' }`, `{ data: '', format: 'png' }`]) {
  const err = await run(`handleRedactImage(${args})`).catch(e => e);
  assert.equal(err.responseCode, 'image_unsupported');
}
assert.equal(calls.length, 0, 'unsupported images never reach the network');

// Unconfigured / unauthenticated: no network.
vm.runInContext(`getAuthHeaders = async () => { throw new Error('nope'); };`, context);
assert.equal((await run(`handleRedactImage({ data: 'AAAA', format: 'png' })`).catch(e => e)).responseCode, 'not_configured');
assert.equal(calls.length, 0);
console.log('image-background: ok');
