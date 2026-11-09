import assert from 'node:assert/strict';
import vm from 'node:vm';

// Fail-closed cases for the background API core: every failure must reject,
// and nothing may be recorded as a completed operation.
import { src, i18n } from './helpers/env.mjs';
const source = await src('background.js');
let reply;
let calls = [];
let writes = 0;
const context = vm.createContext({
  AbortSignal,
  crypto: { randomUUID: () => 'test-context' },
  fetch: async (url, init) => { calls.push({ url, init }); return reply(); },
  chrome: {
    i18n: await i18n('it'),
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: {
      sync: { get: async defaults => defaults },
      local: { get: async defaults => defaults, set: async () => { writes++; } },
    },
  },
});
vm.runInContext(await src('core.js'), context);
vm.runInContext(source, context);
vm.runInContext(`getSettings = async () => ({ piiApiUrl: 'https://api.test/', docType: 'generic_professional', mode: 'tag' });
  getAuthHeaders = async () => ({ 'X-Api-Key': 'test-key' });`, context);
const run = code => vm.runInContext(code, context);
const json = (body, status = 200) => () => ({ ok: status < 300, status, json: async () => body });

// Every failure rejects with a stable responseCode the panel can explain (core.describeError).
const failures = [
  [json({ success: false, error: { response_code: 'PII_BLOCKED', message: 'Blocked by policy' } }, 422), 'policy_blocked'],
  [json({ error: 'invalid_api_key' }, 401), 'auth'],
  [json({ error: 'forbidden' }, 403), 'auth'],
  [json({ error: 'monthly_quota_exceeded' }, 429), 'quota'],
  [json({ error: 'too_many' }, 429), 'rate_limited'],
  [json({ error: 'CREDITS_EXHAUSTED' }, 402), 'quota'],
  [json({ safe: true, anonymized_text: '[PERSON_1]' }, 502), 'server'],
  [json({}, 504), 'timeout'],
  [() => { throw new TypeError('Failed to fetch'); }, 'network'],
  [() => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, 'timeout'],
  [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }), 'unsafe'],
  [json({ anonymized_text: '[PERSON_1]', entities: [] }), 'unsafe'],
];
for (const [failure, code] of failures) {
  reply = failure;
  const err = await run(`handleAnonymize({ text: 'Mario Rossi' })`).catch(e => e);
  assert.ok(err instanceof Error || err?.message, `must reject (${code})`);
  assert.equal(err.responseCode, code);
}
assert.equal(writes, 0, 'a failed anonymization must not be recorded');

reply = json({ success: false, error: { response_code: 'PII_BLOCKED', message: 'Blocked', meta: { blocked_types: ['IBAN'] } } }, 422);
const blocked = await run(`handleAnonymize({ text: 'x' })`).catch(e => e);
assert.equal(blocked.responseCode, 'policy_blocked');
assert.deepEqual({ ...blocked.meta }, { blocked_types: ['IBAN'] });

// Not signed in: refused before the network as not_configured.
vm.runInContext(`getAuthHeaders = async () => { throw new Error('none'); };`, context);
calls = [];
assert.equal((await run(`handleAnonymize({ text: 'x' })`).catch(e => e)).responseCode, 'not_configured');
assert.equal(calls.length, 0);
vm.runInContext(`getAuthHeaders = async () => ({ 'X-Api-Key': 'test-key' });`, context);

// Successful call: spec path, trailing slash stripped, typed body, timeout signal attached.
calls = [];
reply = json({ safe: true, anonymized_text: '[PERSON_1]' });
assert.equal((await run(`handleAnonymize({ text: 'Mario Rossi' })`)).anonymized_text, '[PERSON_1]');
assert.equal(calls[0].url, 'https://api.test/v1/anonymize');
assert.deepEqual(JSON.parse(calls[0].init.body), {
  text: 'Mario Rossi', context_id: 'test-context', language: 'it',
  include_entity_values: false, context_type: 'generic', mode: 'tag',
});

// One document type: a preset or a team policy goes out as `domain`, never as context_type.
for (const [docType, domain] of [['hr_payroll', 'hr_payroll'], ['domain:legal_it', 'legal_it']]) {
  calls = [];
  await run(`handleAnonymize({ text: 'x', docType: ${JSON.stringify(docType)} })`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.domain, domain);
  assert.equal('context_type' in body, false);
}
assert.ok(calls[0].init.signal instanceof AbortSignal);
assert.equal(writes, 3, "failed restores are not recorded");

// Deanonymize must carry restored_text (the spec field); anything else rejects.
for (const body of [{}, { text: 'Mario Rossi' }, { deanonymized_text: 'Mario Rossi' }, { restored_text: 7 }]) {
  reply = json(body);
  assert.equal((await run(`handleDeanonymize({ text: '[PERSON_1]', contextId: 'c1' })`).catch(e => e)).responseCode, 'failed');
}
assert.equal(writes, 3, "failed restores are not recorded");
reply = json({ restored_text: 'Mario Rossi' });
calls = [];
assert.equal((await run(`handleDeanonymize({ text: '[PERSON_1]', contextId: 'c1', docType: 'domain:legal_it' })`)).restored_text, 'Mario Rossi');
assert.equal(JSON.parse(calls[0].init.body).context_type, 'legal_it', 'restore reads the mappings of the anonymize call');

console.log('api_core_ok');
