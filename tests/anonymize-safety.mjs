import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
let response;
let writes = 0;
const context = vm.createContext({
  crypto: { randomUUID: () => 'test-context' },
  fetch: async () => ({ ok: true, json: async () => response }),
  chrome: {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: {
      sync: { get: async defaults => defaults },
      local: { get: async defaults => defaults, set: async () => { writes++; } },
    },
  },
});
vm.runInContext(source, context);
vm.runInContext(`getSettings = async () => ({ piiApiUrl: 'https://api.test', piiApiKey: 'test-key' });
  getAuthHeaders = async () => ({ 'X-Api-Key': 'test-key' });`, context);

for (response of [null, {}, {safe: false, anonymized_text: 'private'},
  {safe: 'true', anonymized_text: 'private'}, {safe: true}, {safe: true, anonymized_text: 123}]) {
  await assert.rejects(vm.runInContext(`handleAnonymize({text: 'private'})`, context), /safe processing/);
}
assert.equal(writes, 0);
response = { safe: true, anonymized_text: '[PERSON_1]' };
assert.equal((await vm.runInContext(`handleAnonymize({text: 'private'})`, context)).anonymized_text, '[PERSON_1]');
assert.equal(writes, 1);
console.log('anonymize_safety_ok');
