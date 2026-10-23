import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(await read('send-guard.js'), context);
const { decide, composerHolds } = context.PseudoraSendGuard;
const base = { interceptSend: true, inFlight: false, nativeSendAllowed: false, hasText: true };

// Interception off, empty editor or our own post-anonymize click: the site sends.
assert.equal(decide({ ...base, interceptSend: false }), 'pass');
assert.equal(decide({ ...base, hasText: false }), 'pass');
assert.equal(decide({ ...base, inFlight: true, nativeSendAllowed: true }), 'pass');
// A user send is anonymized first, and a second one while that runs is swallowed.
assert.equal(decide(base), 'anonymize');
assert.equal(decide({ ...base, inFlight: true }), 'block');

// The programmatic send fires only when the editor really holds the protected text.
assert.equal(composerHolds('Ciao [PERSON_1]\n', 'Ciao  [PERSON_1]'), true);
assert.equal(composerHolds('Ciao Mario Rossi', 'Ciao [PERSON_1]'), false);
assert.equal(composerHolds('', '[PERSON_1]'), false);
assert.equal(composerHolds('undefined', undefined), false);

// content.js must route both send paths through the guard and must not let an
// in-flight anonymization short-circuit interception (the pre-fix fail-open).
const content = await read('content.js');
assert.match(content, /guard\.decide\(/);
assert.doesNotMatch(content, /if \(!interceptSend \|\| isAnonymizing\) return;/);
assert.match(content, /guard\.composerHolds\(site\.getText\(currentInput\), resp\.anonymized_text\)/);
assert.match(content, /chrome\.storage\.onChanged\.addListener/);
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.deepEqual(manifest.content_scripts[0].js, ['src/send-guard.js', 'src/content.js']);

console.log('send_guard_ok');
