import assert from 'node:assert/strict';
import vm from 'node:vm';
import { src, i18n } from './helpers/env.mjs';

// Shared pure logic: settings migration, the single document type, error kinds, page-button status.
const ctx = vm.createContext({ chrome: { i18n: await i18n('it') } });
vm.runInContext(await src('core.js'), ctx);
const C = ctx.PseudoraCore;
const plain = v => JSON.parse(JSON.stringify(v));

// t(): named substitutions; a missing key shows itself instead of a blank.
assert.equal(C.t('toolbarProtectedTeam', { team: 'Studio Ferri' }), 'Protetto · Studio Ferri');
assert.equal(C.t('no_such_key'), 'no_such_key');

// Migration from 1.2.x: contextType + imageDomain + autoSend become one docType.
assert.equal(C.migrate({ docType: 'hr_payroll' }), null, 'nothing to migrate');
assert.deepEqual(plain(C.migrate({ contextType: 'domain:legal_it', imageDomain: 'hr_payroll', autoSend: true })),
  { set: { docType: 'domain:legal_it' }, remove: ['contextType', 'imageDomain', 'autoSend'] }, 'team policy wins');
assert.equal(C.migrate({ contextType: 'domain:fine_appeal' }).set.docType, 'fine_appeal', 'a preset policy is stored bare');
assert.equal(C.migrate({ contextType: 'contract' }).set.docType, 'contract_analysis');
assert.equal(C.migrate({ contextType: 'generic', imageDomain: 'tax_accounting' }).set.docType, 'tax_accounting', 'image choice kept');
assert.equal(C.migrate({ contextType: 'medical' }).set.docType, 'generic_professional');
assert.equal(C.migrate({ autoSend: false }).set.docType, 'generic_professional', 'dead Auto-send removed');
assert.equal(C.migrate({ contextType: 'domain:"><img>' }).set.docType, 'generic_professional', 'malformed value refused');

// One document type → text and image requests.
assert.deepEqual(plain(C.requestFor('generic_professional')), { text: { context_type: 'generic' }, image: 'generic_professional', deanonContext: 'generic' });
assert.deepEqual(plain(C.requestFor('hr_payroll')), { text: { domain: 'hr_payroll' }, image: 'hr_payroll', deanonContext: 'hr_payroll' });
assert.deepEqual(plain(C.requestFor('domain:legal_it')), { text: { domain: 'legal_it' }, image: 'generic_professional', deanonContext: 'legal_it' });
assert.deepEqual(plain(C.requestFor('x"; DROP')), plain(C.requestFor('generic_professional')));

// The race fix: the saved value is selected whatever arrives, and never silently replaced.
{
  const offline = C.docOptions({}, 'domain:legal_it');
  assert.equal(offline.selected, 'domain:legal_it', 'policies not loaded yet: still the saved choice');
  assert.match(C.docLabel(offline.groups, 'domain:legal_it'), /legal_it \(non disponibile\)/);
  assert.equal(offline.groups[0].options.length, 7, 'built-in Italian presets offline');
  assert.equal(C.docLabel(offline.groups, 'hr_payroll'), 'Busta paga e personale');
  const loaded = C.docOptions({ presets: [{ value: 'generic_professional', label: 'Generico' }], policies: [{ domain: 'legal_it', display_name: 'Studio legale' }, { domain: 'generic_professional' }] }, 'domain:legal_it');
  assert.equal(loaded.selected, 'domain:legal_it');
  assert.deepEqual(plain(loaded.groups.map(g => g.label)), ['Tipi di documento', 'Policy del team'], 'no "unavailable" group once it exists');
  assert.equal(C.docLabel(loaded.groups, 'domain:legal_it'), 'Studio legale');
  assert.equal(loaded.groups[1].options.length, 1, 'a policy that duplicates a preset is listed once');
  assert.equal(C.docOptions({}, '').selected, 'generic_professional');
}

// Entity labels: Italian names, unknown codes read as words.
assert.equal(C.entityLabel('FISCAL_CODE'), 'Codice fiscale');
assert.equal(C.entityLabel('PERSON'), 'Persona');
assert.equal(C.entityLabel('NEW_THING'), 'new thing');

// Errors by type: policy ≠ outage ≠ login; every message says nothing was sent.
const kinds = [
  [{ responseCode: 'policy_blocked', meta: { blocked_types: ['IBAN', 'FISCAL_CODE'] } }, 'policy_blocked', 'policy', null, /IBAN, Codice fiscale/],
  [{ responseCode: 'PII_BLOCKED' }, 'policy_blocked', 'policy', null, /policy/],
  [{ responseCode: 'server' }, 'server', 'error', 'retry', /riprova/i],
  [{ responseCode: 'timeout' }, 'timeout', 'error', 'retry', /Riprova/],
  [{ responseCode: 'network' }, 'network', 'error', 'retry', /rete/],
  [{ responseCode: 'auth' }, 'auth', 'error', 'login', /Accedi di nuovo/],
  [{ responseCode: 'not_configured' }, 'not_configured', 'error', 'login', /Accedi/],
  [{ responseCode: 'monthly_quota_exceeded' }, 'quota', 'error', null, /credito/],
  [{ responseCode: 'rate_limited' }, 'rate_limited', 'error', 'retry', /Attendi/],
  [{ responseCode: 'unsafe' }, 'unsafe', 'error', 'retry', /confermare/],
  [{ error: 'Extension context invalidated.' }, 'reloaded', 'error', null, /Ricarica/],
  [{ error: 'boom' }, 'failed', 'error', 'retry', /imprevisto/],
];
for (const [resp, kind, tone, action, detail] of kinds) {
  const e = C.describeError(resp);
  assert.equal(e.kind, kind, JSON.stringify(resp));
  assert.equal(e.tone, tone);
  assert.equal(e.action, action);
  assert.match(e.detail, detail);
  assert.match(e.detail, /Nulla è stato inviato/);
  assert.doesNotMatch(`${e.title} ${e.detail}`, /HTTP|API URL|errTitle|errDetail/);
}

// Page button status.
assert.deepEqual(plain(C.toolbarStatus({ configured: true, interceptSend: true, teamName: 'Studio Ferri', docLabel: 'Generico' })), {
  state: 'on', label: 'Protetto · Studio Ferri',
  aria: 'Pseudora: protezione invio attiva, team Studio Ferri, tipo documento Generico. Apri il pannello.',
});
assert.equal(C.toolbarStatus({ configured: true, interceptSend: false }).state, 'off');
assert.equal(C.toolbarStatus({ configured: false, interceptSend: true }).state, 'setup');
console.log('core: ok');
