import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { src, i18n } from './helpers/env.mjs';

// Popup: every preference saves on change with an inline "Salvato"; the saved document type
// survives the late options list (the 1.2.x race); connection settings live under "Avanzate".
const [html, coreSrc, popupSrc] = await Promise.all(['popup.html', 'core.js', 'popup.js'].map(src));
const it = await i18n('it');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open({ sync = {}, local = {}, loggedIn = true, docsDelay = 30, teams = [] } = {}) {
  const window = new Window({ url: 'chrome-extension://ext/src/popup.html', width: 360, height: 600 });
  const { document } = window;
  document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  const store = { sync: { ...sync }, local: { ...local } };
  const sets = [];
  const sent = [];
  const replies = {
    OAUTH_STATUS: () => ({ loggedIn, name: 'Giulia Ferri', email: 'giulia@example.it' }),
    GET_DOC_TYPES: () => sleep(docsDelay).then(() => ({
      presets: [{ value: 'generic_professional', label: 'Generico' }, { value: 'hr_payroll', label: 'Busta paga' }],
      policies: [{ domain: 'legal_it', display_name: 'Studio legale' }],
    })),
    GET_TEAMS: () => ({ teams, selectedTeamCode: teams[0]?.tenant_code || '' }),
  };
  window.chrome = {
    i18n: it,
    runtime: {
      id: 'ext', lastError: null, getManifest: () => ({ version: '1.3.0' }),
      sendMessage(msg, cb) { sent.push(msg); Promise.resolve(replies[msg.type]?.() ?? {}).then(cb); },
    },
    storage: {
      sync: {
        get: async keys => (keys === null ? { ...store.sync } : { ...keys, ...store.sync }),
        set: async obj => { sets.push(obj); Object.assign(store.sync, obj); },
        remove: async keys => { [].concat(keys).forEach(k => delete store.sync[k]); },
      },
      local: { get: async d => ({ ...d, ...store.local }), set: async o => Object.assign(store.local, o) },
    },
    commands: { getAll: cb => cb([{ name: 'anonymize', shortcut: 'Alt+Shift+A' }, { name: 'restore', shortcut: 'Alt+Shift+R' }, { name: 'protected-screenshot', shortcut: 'Alt+Shift+S' }]) },
    permissions: { request: (o, cb) => cb(true) },
    tabs: { create: async () => {}, query: async () => [] },
  };
  window.eval(coreSrc);
  window.eval(popupSrc);
  await window.__popupReady;
  return { window, document, store, sets, sent, $: id => document.getElementById(id) };
}
const change = (p, el) => el.dispatchEvent(new p.window.Event('change', { bubbles: true }));
const savedNote = el => el.closest('[data-field]').querySelector('.saved').textContent;

// Immediate save, one control at a time, each with its own "Salvato".
{
  const p = await open({ sync: { piiApiUrl: 'https://pseudora.cloud', interceptSend: false } });
  const intercept = p.$('intercept-send');
  assert.equal(intercept.checked, false);
  assert.equal(p.$('protect-images').disabled, true, 'image protection needs send protection');
  intercept.checked = true; change(p, intercept);
  await sleep(5);
  assert.deepEqual(JSON.parse(JSON.stringify(p.sets.at(-1))), { interceptSend: true }, 'saved on change, no Save button');
  assert.equal(savedNote(intercept), 'Salvato');
  assert.equal(p.$('protect-images').disabled, false);
  assert.equal(p.$('status-pill').dataset.state, 'on');
  assert.equal(p.$('status-label').textContent, 'Protezione attiva');

  for (const [id, value, key] of [['face-style', 'black', 'faceStyle'], ['language', 'en', 'language'], ['doc-type', 'hr_payroll', 'docType']]) {
    const el = p.$(id);
    await sleep(40);                                   // doc types loaded
    el.value = value; change(p, el);
    await sleep(5);
    assert.deepEqual(JSON.parse(JSON.stringify(p.sets.at(-1))), { [key]: value }, id);
    assert.equal(savedNote(el), 'Salvato', id);
  }
  const images = p.$('protect-images');
  images.checked = false; change(p, images);
  await sleep(5);
  assert.deepEqual(JSON.parse(JSON.stringify(p.sets.at(-1))), { protectImages: false });
  p.document.querySelector('.seg [data-mode="surrogate"]').click();
  await sleep(5);
  assert.deepEqual(JSON.parse(JSON.stringify(p.sets.at(-1))), { mode: 'surrogate' });
  assert.equal(p.$('mode-example').className, 'chip is-surrogate');
  assert.equal(p.document.querySelector('.seg [data-mode="surrogate"]').getAttribute('aria-checked'), 'true');
  // Auto-send is gone, and nothing else asks for a Save.
  assert.equal(p.$('auto-send'), null);
  assert.equal(p.$('tab-protect').querySelector('#save-btn'), null);
}

// The race: a saved team policy is selected before and after the options arrive.
{
  const p = await open({ sync: { piiApiUrl: 'https://pseudora.cloud', docType: 'domain:legal_it' }, docsDelay: 40 });
  assert.equal(p.$('doc-type').value, 'domain:legal_it', 'selected while the list is still loading');
  await sleep(60);
  assert.equal(p.$('doc-type').value, 'domain:legal_it', 'still selected once the policies arrive');
  assert.equal(p.$('doc-type').selectedOptions[0].textContent, 'Studio legale');
  assert.equal(p.sets.some(s => 'docType' in s), false, 'loading never overwrites the saved choice');
}

// 1.2.x settings are migrated on open (team policy kept, autoSend dropped).
{
  const p = await open({ sync: { piiApiUrl: 'https://pseudora.cloud', contextType: 'domain:legal_it', imageDomain: 'hr_payroll', autoSend: true } });
  assert.equal(p.store.sync.docType, 'domain:legal_it');
  assert.equal('autoSend' in p.store.sync, false);
  assert.equal('contextType' in p.store.sync, false);
}

// First run: one primary action, cloud prefilled, self-hosted settings folded away.
{
  const p = await open({ loggedIn: false });
  assert.equal(p.$('onboard').hidden, false);
  assert.equal(p.$('onboard-login').textContent, 'Accedi con Pseudora');
  assert.equal(p.$('status-pill').dataset.state, 'setup');
  assert.equal(p.$('api-url').value, 'https://pseudora.cloud');
  assert.equal(p.$('advanced').open, false, 'API URL, key and client ID behind "Avanzate"');
  assert.ok(p.$('advanced').contains(p.$('api-key')) && p.$('advanced').contains(p.$('oauth-client-id')) && p.$('advanced').contains(p.$('clear-cache-btn')));
  assert.equal(p.document.documentElement.lang, 'it');
}

// Reset cache asks first.
{
  const p = await open();
  p.$('clear-cache-btn').click();
  assert.equal(p.$('clear-confirm').hidden, false);
  assert.equal(p.sent.some(m => m.type === 'CLEAR_CACHE'), false, 'nothing reset before confirming');
  p.$('clear-no').click();
  assert.equal(p.$('clear-confirm').hidden, true);
  p.$('clear-cache-btn').click();
  p.$('clear-yes').click();
  await sleep(5);
  assert.equal(p.sent.filter(m => m.type === 'CLEAR_CACHE').length, 1);
}

// Shortcuts are listed in the guide, the screenshot button shows its key.
{
  const p = await open();
  assert.match(p.$('shortcut-list').textContent, /Alt\+Shift\+A.*Alt\+Shift\+R.*Alt\+Shift\+S/s);
  assert.equal(p.$('shot-key').textContent, 'Alt+Shift+S');
  // Tabs are an ARIA tablist with arrow keys.
  const tabs = [...p.document.querySelectorAll('.tab')];
  tabs[0].dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(p.$('tab-account').hidden, false);
  assert.equal(p.$('tab-protect').hidden, true);
}
console.log('popup: ok');
