import assert from 'node:assert/strict';
import vm from 'node:vm';

// Background REDACT_IMAGE: only a 200 safe JSON reply with intact image bytes is
// handed back; every other reply rejects (fail closed).
import { src } from './helpers/env.mjs';
const source = await src('background.js');
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
vm.runInContext(await src('core.js'), context);
vm.runInContext(source, context);
let settings = { piiApiUrl: 'https://api.test/', docType: 'fine_appeal', faceStyle: 'blur' };
context.testSettings = () => settings;
vm.runInContext(`getSettings = async () => testSettings();
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
const ok = await run(`handleRedactImage({ data: ${JSON.stringify(ORIGINAL)}, format: 'png' })`);
assert.equal(calls[0].url, 'https://api.test/v1/images/redact');
assert.ok(calls[0].init.body instanceof FormData, 'multipart body');
const sent = calls[0].init.body.get('file');
assert.equal(sent.type, 'image/png');
assert.equal(calls[0].init.body.get('domain'), 'fine_appeal', 'document type comes from storage.sync');
assert.equal(calls[0].init.body.get('face_style'), 'blur', 'faces blurred by default');
assert.equal(calls[0].init.body.get('review_restore'), '1', 'asks for the doubtful boxes');
assert.equal(Buffer.from(await sent.arrayBuffer()).toString(), 'original-screenshot');
assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
assert.equal(calls[0].init.headers.Accept, 'application/json', 'without it the Cloud replies with image bytes');
assert.equal(calls[0].init.headers['Content-Type'], undefined, 'fetch must set the multipart boundary');
assert.ok(calls[0].init.signal instanceof AbortSignal);
assert.deepEqual({ ...ok, types: [...ok.types], review_boxes: [...ok.review_boxes] }, {
  safe: true, format: 'png', image_base64: Buffer.from(PNG).toString('base64'),
  entity_count: 3, review_regions: 2, types: ['PERSON', 'FACE'], review_boxes: [],
});

// Doubtful boxes: only the geometry reaches the page, never the review image.
reply = image(PNG, { review: { content_type: 'image/png', image_base64: 'UkVWSUVX', regions: [
  { id: 0, reason: 'low_confidence', bbox: [0.1, 0.2, 0.3, 0.4] },
  { id: 1, reason: 'low_confidence', bbox: [0.5, 0.5, 0.4, 0.6] },          // inverted
  { id: 2, reason: 'low_confidence', bbox: [0, 0, 2, 1] },                  // out of range
  { id: 3, reason: 'low_confidence', bbox: 'x' },
] } });
const reviewed = await run(`handleRedactImage({ data: ${JSON.stringify(ORIGINAL)}, format: 'png' })`);
assert.deepEqual(JSON.parse(JSON.stringify(reviewed.review_boxes)), [[0.1, 0.2, 0.3, 0.4]]);
assert.equal(JSON.stringify(reviewed).includes('UkVWSUVX'), false, 'review layer dropped');
reply = image();

// A team policy is text-only: images fall back to the generic preset.
settings = { ...settings, docType: 'domain:legal_it' };
await run(`handleRedactImage({ data: ${JSON.stringify(ORIGINAL)}, format: 'png' })`);
assert.equal(calls.at(-1).init.body.get('domain'), 'generic_professional');

// A tampered stored setting is never forwarded: generic preset, faces fall back to blur.
settings = { ...settings, docType: 'x"; DROP', faceStyle: 'none' };
await run(`handleRedactImage({ data: ${JSON.stringify(ORIGINAL)}, format: 'png' })`);
assert.equal(calls.at(-1).init.body.get('domain'), 'generic_professional');
assert.equal(calls.at(-1).init.body.get('face_style'), 'blur');
settings = { ...settings, docType: 'generic_professional', faceStyle: 'black' };
await run(`handleRedactImage({ data: ${JSON.stringify(ORIGINAL)}, format: 'png' })`);
assert.equal(calls.at(-1).init.body.get('face_style'), 'black', 'an explicit choice is sent as is');

// Options: Italian label preferred, malformed entries dropped, bad shapes reject.
reply = () => new Response(JSON.stringify({ mode: 'redact', default: 'generic_professional', domains: [
  { value: 'generic_professional', label: 'Generic', labels: { it: 'Generico', en: 'Generic' } },
  { value: 'fine_appeal', label: 'Fine appeal' }, { value: '<img src=x>', label: 'evil' }, { value: 'x', label: 7 },
] }), { headers: { 'Content-Type': 'application/json' } });
const options = await run('handleImageOptions()');
assert.equal(calls.at(-1).url, 'https://api.test/v1/images/options');
assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer t');
assert.deepEqual(JSON.parse(JSON.stringify(options)), { mode: 'redact', domains: [
  { value: 'generic_professional', label: 'Generico' }, { value: 'fine_appeal', label: 'Fine appeal' },
] });
for (const bad of [{ mode: 'pseudonymize', domains: [{ value: 'a', label: 'A' }] }, { mode: 'redact', domains: [] }, { mode: 'redact' }]) {
  reply = () => new Response(JSON.stringify(bad), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(run('handleImageOptions()'));
}
reply = () => new Response('{}', { status: 404 });
await assert.rejects(run('handleImageOptions()'));
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
  [image(PNG, { image_base64: 'iVBORw0' }), 'failed'],          // not a multiple of 4
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

// Document types: presets + team policies; a failing list degrades to empty, never rejects.
vm.runInContext(`getAuthHeaders = async () => ({ Authorization: 'Bearer t' });`, context);
reply = () => { const url = calls.at(-1).url;
  return url.endsWith('/v1/images/options')
    ? new Response(JSON.stringify({ mode: 'redact', domains: [{ value: 'hr_payroll', labels: { it: 'Busta paga', en: 'Payslip' } }] }), { headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify([{ domain: 'legal_it', display_name: 'Studio legale' }, { nope: 1 }]), { headers: { 'Content-Type': 'application/json' } }); };
const docs = JSON.parse(JSON.stringify(await run('handleDocTypes()')));
assert.deepEqual(docs, { presets: [{ value: 'hr_payroll', label: 'Busta paga' }], policies: [{ domain: 'legal_it', display_name: 'Studio legale' }] });
reply = () => new Response('{}', { status: 500 });
assert.deepEqual(JSON.parse(JSON.stringify(await run('handleDocTypes()'))), { presets: [], policies: [] });
settings = { piiApiUrl: '' };
assert.deepEqual(JSON.parse(JSON.stringify(await run('handleDocTypes()'))), { presets: [], policies: [] });
console.log('image-background: ok');
