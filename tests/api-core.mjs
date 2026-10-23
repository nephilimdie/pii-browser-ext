import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Fail-closed cases for the background API core: every failure must reject,
// and nothing may be recorded as a completed operation.
const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
let reply;
let calls = [];
let writes = 0;
const context = vm.createContext({
  AbortSignal,
  crypto: { randomUUID: () => 'test-context' },
  fetch: async (url, init) => { calls.push({ url, init }); return reply(); },
  chrome: {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: {
      sync: { get: async defaults => defaults },
      local: { get: async defaults => defaults, set: async () => { writes++; } },
    },
  },
});
vm.runInContext(source, context);
vm.runInContext(`getSettings = async () => ({ piiApiUrl: 'https://api.test/', contextType: 'generic', mode: 'tag' });
  getAuthHeaders = async () => ({ 'X-Api-Key': 'test-key' });`, context);
const run = code => vm.runInContext(code, context);
const json = (body, status = 200) => () => ({ ok: status < 300, status, json: async () => body });

const failures = [
  [json({ success: false, error: { response_code: 'PII_BLOCKED', message: 'Blocked by policy' } }, 422), /Blocked by policy/],
  [json({ error: 'invalid_api_key' }, 401), /401 — invalid_api_key/],
  [json({ error: 'monthly_quota_exceeded' }, 429), /HTTP 429/],
  [json({ safe: true, anonymized_text: '[PERSON_1]' }, 502), /HTTP 502/],
  [() => { throw new TypeError('Failed to fetch'); }, /Failed to fetch/],
  [() => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, /did not respond in time/],
  [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }), /Unexpected token/],
  [json({ anonymized_text: '[PERSON_1]', entities: [] }), /safe processing/],
];
for (const [failure, message] of failures) {
  reply = failure;
  await assert.rejects(run(`handleAnonymize({ text: 'Mario Rossi' })`), message);
}
assert.equal(writes, 0, 'a failed anonymization must not be recorded');

reply = json({ success: false, error: { response_code: 'PII_BLOCKED', message: 'Blocked', meta: { types: ['IBAN'] } } }, 422);
const blocked = await run(`handleAnonymize({ text: 'x' })`).catch(e => e);
assert.equal(blocked.responseCode, 'PII_BLOCKED');
assert.deepEqual({ ...blocked.meta }, { types: ['IBAN'] });

// Successful call: spec path, trailing slash stripped, typed body, timeout signal attached.
calls = [];
reply = json({ safe: true, anonymized_text: '[PERSON_1]' });
assert.equal((await run(`handleAnonymize({ text: 'Mario Rossi' })`)).anonymized_text, '[PERSON_1]');
assert.equal(calls[0].url, 'https://api.test/v1/anonymize');
assert.deepEqual(JSON.parse(calls[0].init.body), {
  text: 'Mario Rossi', context_id: 'test-context', language: 'it',
  include_entity_values: false, context_type: 'generic', mode: 'tag',
});
assert.ok(calls[0].init.signal instanceof AbortSignal);
assert.equal(writes, 1);

// Deanonymize must carry restored_text (the spec field); anything else rejects.
for (const body of [{}, { text: 'Mario Rossi' }, { deanonymized_text: 'Mario Rossi' }, { restored_text: 7 }]) {
  reply = json(body);
  await assert.rejects(run(`handleDeanonymize({ text: '[PERSON_1]', contextId: 'c1' })`), /no restored text/);
}
assert.equal(writes, 1);
reply = json({ restored_text: 'Mario Rossi' });
assert.equal((await run(`handleDeanonymize({ text: '[PERSON_1]', contextId: 'c1' })`)).restored_text, 'Mario Rossi');

console.log('api_core_ok');
