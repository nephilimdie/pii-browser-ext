import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

// Composer detection against markup captured from the live sites, and the content
// script following the editor across SPA re-renders. Regression for 1.1.1: the
// Nov 2026 chatgpt.com composer (textarea[name="prompt"]) left the toolbar missing.
import { i18n } from './helpers/env.mjs';
const read = f => readFile(new URL(f, import.meta.url), 'utf8');
const [composerSrc, sendGuardSrc, contentSrc, coreSrc, panelSrc, chatgpt2026] = await Promise.all([
  read('../src/composer.js'), read('../src/send-guard.js'), read('../src/content.js'),
  read('../src/core.js'), read('../src/panel.js'), read('./fixtures/chatgpt-composer-2026-11.html'),
]);
const it = await i18n('it');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function page(host, html) {
  const window = new Window({ url: `https://${host}/` });
  window.document.body.innerHTML = html;
  window.eval(composerSrc);
  return { window, document: window.document, c: window.PseudoraComposer.forHost(host) };
}

// Current chatgpt.com (captured 2026-11-08): plain textarea in an "octane" form.
{
  const { document, c } = page('chatgpt.com', chatgpt2026);
  // The 1.1.0 selector finds nothing here: the root cause of the missing toolbar.
  assert.equal(document.querySelector('#prompt-textarea, div[contenteditable="true"][data-lexical-editor]'), null);
  const input = c.input(document);
  assert.equal(input?.id, 'mobile-composer-prompt');
  assert.equal(input.tagName, 'TEXTAREA');
  assert.equal(c.root(input), document.querySelector('form'));
  assert.ok(c.sendButton(document)?.hasAttribute('data-composer-submit'), 'localized send button found without aria-label');
  assert.equal(c.images, true);
}

// Legacy chatgpt.com: ProseMirror #prompt-textarea next to a hidden fallback textarea.
{
  const { document, c } = page('chatgpt.com', '<form><textarea name="prompt-textarea" style="display:none"></textarea><div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div><button data-testid="send-button"></button></form>');
  assert.equal(c.input(document).id, 'prompt-textarea');
  assert.equal(c.sendButton(document).dataset.testid, 'send-button');
}

// Rich editor mounted in the new host wins over the plain textarea.
{
  const { document, c } = page('www.chatgpt.com', '<form><div data-composer-editor-host><textarea name="prompt"></textarea><div data-octane-lexical-host><div id="lx" contenteditable="true" data-lexical-editor="true"></div></div></div></form>');
  assert.equal(c.input(document).id, 'lx');
}

// A rendered candidate beats an earlier hidden one.
{
  const { document, c } = page('chatgpt.com', '<form><div id="prompt-textarea" contenteditable="true"></div><textarea id="shown" name="prompt"></textarea></form>');
  document.getElementById('prompt-textarea').getClientRects = () => [];
  document.getElementById('shown').getClientRects = () => [{ width: 600, height: 24 }];
  assert.equal(c.input(document).id, 'shown');
}

// Claude and Gemini keep their selectors; Gemini anchors to the whole pill.
{
  const cl = page('claude.ai', '<fieldset><div contenteditable="true" id="pm"></div><button aria-label="Send message"></button></fieldset>');
  assert.equal(cl.c.input(cl.document).id, 'pm');
  assert.equal(cl.c.root(cl.c.input(cl.document)).tagName, 'FIELDSET');
  const ge = page('gemini.google.com', '<input-area-v2><fieldset><rich-textarea><div contenteditable="true" id="q"></div></rich-textarea></fieldset></input-area-v2>');
  assert.equal(ge.c.root(ge.c.input(ge.document)).tagName, 'INPUT-AREA-V2');
  assert.equal(ge.c.images, false);
  assert.equal(page('example.com', '').c, null);
}

// Content script on the captured markup: toolbar injected once, send guard follows re-renders.
{
  const { window, document } = page('chatgpt.com', chatgpt2026);
  const sent = [];
  let anonReply = { safe: true, anonymized_text: '[PERSON_1] scrive', entities: [{ type: 'PERSON', replacement: '[PERSON_1]', original_value: 'Mario Rossi' }] };
  let status = { configured: true, interceptSend: true, teamName: 'Studio Ferri', docType: 'domain:legal_it', mode: 'tag', shortcuts: { anonymize: 'Alt+Shift+A', restore: 'Alt+Shift+R' } };
  const replies = {
    ANONYMIZE: () => anonReply,
    GET_STATUS: () => status,
    GET_DOC_TYPES: () => ({ presets: [{ value: 'generic_professional', label: 'Generico' }], policies: [{ domain: 'legal_it', display_name: 'Studio legale' }] }),
    GET_TEAMS: () => ({ teams: [{ tenant_code: 's', name: 'Studio Ferri' }], selectedTeamCode: 's' }),
  };
  window.chrome = {
    i18n: it,
    runtime: {
      id: 'ext', lastError: null, getURL: p => `chrome-extension://ext/${p}`,
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        Promise.resolve(replies[msg.type]?.() ?? {}).then(cb);
      },
    },
    storage: {
      sync: { get(d, cb) { cb({ ...d, interceptSend: true, docType: 'domain:legal_it' }); }, set() {} },
      onChanged: { addListener() {} },
    },
  };
  // Chrome refuses insertText in some editors; force the textarea value-setter fallback.
  document.execCommand = () => false;
  window.eval(coreSrc);
  window.eval(sendGuardSrc);
  window.eval(panelSrc);
  window.eval(contentSrc);
  await sleep(80);                                  // status + document types arrive
  const button = () => document.querySelector('#pii-protect-toolbar .pii-shield-btn');
  assert.equal(button().textContent, 'Protetto · Studio Ferri', 'the page button is a status, not "PII"');
  assert.match(button().getAttribute('aria-label'), /protezione invio attiva, team Studio Ferri, tipo documento Studio legale/);
  assert.equal(button().dataset.state, 'on');
  const toolbars = () => document.querySelectorAll('#pii-protect-toolbar').length;
  assert.equal(toolbars(), 1, 'toolbar injected on the new composer');

  const enter = el => {
    const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    el.focus();
    el.dispatchEvent(ev);
    return ev;
  };
  const submits = [];
  const wire = () => document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); submits.push(e); });

  // Home -> conversation: the site throws the whole form away and renders a new one.
  for (const [round, name] of [[1, 'Mario Rossi scrive'], [2, 'Anna Bianchi scrive']]) {
    if (round === 2) {
      document.querySelector('form').remove();
      await sleep(30);
      assert.equal(document.getElementById('pii-protect-toolbar').style.display, 'none', 'hidden while no composer');
      document.body.insertAdjacentHTML('beforeend', chatgpt2026);
      await sleep(30);
    }
    wire();
    const ta = document.querySelector('textarea[name="prompt"]');
    ta.value = name;
    const ev = enter(ta);
    assert.equal(ev.defaultPrevented, true, `round ${round}: original Enter swallowed`);
    await sleep(250);
    const anon = sent.filter(m => m.type === 'ANONYMIZE').at(-1);
    assert.equal(anon?.text, name, `round ${round}: live editor text sent for anonymization`);
    assert.equal(anon.docType, 'domain:legal_it', `round ${round}: the saved document type is used`);
    assert.equal(ta.value, '[PERSON_1] scrive', `round ${round}: anonymized text written into the textarea`);
    assert.equal(submits.length, round, `round ${round}: anonymized prompt submitted via the send button`);
    assert.equal(toolbars(), 1, `round ${round}: exactly one toolbar`);
    assert.equal(document.getElementById('pii-protect-toolbar').style.display, '');
    await sleep(500);                      // let the in-flight guard release
  }

  // The open panel is one dialog: labelled, mapping shown with Italian entity names.
  const panel = () => document.getElementById('pii-main-panel');
  assert.equal(panel().getAttribute('role'), 'dialog');
  assert.equal(document.getElementById(panel().getAttribute('aria-labelledby')).textContent, 'Pseudora');
  assert.match(panel().querySelector('.pii-panel-sub').textContent, /Studio legale · Etichette reversibili/);
  assert.match(panel().textContent, /Persona/, 'entity type in Italian');
  assert.doesNotMatch(panel().textContent, /\bPERSON\b(?!_)/, 'no raw entity code');
  assert.ok(panel().querySelector('.pii-btn-caution'), 'restore is a caution action');
  const foot = panel().querySelector('.pii-panel-foot');
  assert.ok(foot.querySelector('.pii-actions').compareDocumentPosition(foot.querySelector('.pii-feedback')) & 4, 'survey comes after the actions');
  assert.match(foot.textContent, /Alt\+Shift\+A anonimizza · Alt\+Shift\+R ripristina/, 'shortcuts shown');

  // Esc closes the dialog and focus returns to the page button.
  panel().querySelector('.pii-panel-close').focus();
  panel().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel(), null, 'Esc closes the panel');
  assert.equal(document.activeElement, button(), 'focus back on the page button');

  // Intercepted Enter blocked by the team policy: nothing is sent and the panel opens
  // with a policy notice (not "configure the API URL"), in a role=alert region.
  anonReply = { error: 'Richiesta bloccata', responseCode: 'policy_blocked', meta: { blocked_types: ['IBAN'] } };
  const ta = document.querySelector('textarea[name="prompt"]');
  ta.value = 'Mario Rossi IT60X0542811101000000123456';
  assert.equal(enter(ta).defaultPrevented, true, 'failing send still swallowed');
  await sleep(50);
  assert.equal(submits.length, 2, 'nothing submitted when anonymization fails');
  assert.equal(ta.value, 'Mario Rossi IT60X0542811101000000123456');
  assert.ok(panel(), 'panel opened to explain the blocked send');
  const notice = panel().querySelector('[role="alert"] .pii-notice');
  assert.equal(notice.dataset.kind, 'policy_blocked');
  assert.match(notice.textContent, /Bloccato dalla policy del team/);
  assert.match(notice.textContent, /IBAN/);
  assert.match(notice.textContent, /Nulla è stato inviato/);
  assert.doesNotMatch(panel().textContent, /API URL|Settings/);
  assert.equal(notice.querySelector('button'), null, 'a policy block offers no retry');

  // An outage offers [Riprova], which re-runs the anonymization.
  await sleep(600);
  anonReply = { error: 'x', responseCode: 'server' };
  enter(ta);
  await sleep(50);
  const retry = panel().querySelector('.pii-notice button');
  assert.equal(retry.textContent, 'Riprova');
  assert.doesNotMatch(panel().textContent, /HTTP 500/);
  await sleep(600);
  anonReply = { safe: true, anonymized_text: '[PERSON_1] [IBAN_1]', entities: [] };
  const before = sent.filter(m => m.type === 'ANONYMIZE').length;
  retry.click();
  await sleep(50);
  assert.equal(sent.filter(m => m.type === 'ANONYMIZE').length, before + 1, 'Riprova sends again');

  // Expired login offers [Accedi di nuovo], which asks the worker to open the login.
  await sleep(600);
  anonReply = { error: 'x', responseCode: 'auth' };
  ta.value = 'Mario Rossi';
  enter(ta);
  await sleep(50);
  const login = panel().querySelector('.pii-notice button');
  assert.equal(login.textContent, 'Accedi di nuovo');
  login.click();
  await sleep(10);
  assert.equal(sent.at(-1).type, 'OPEN_LOGIN');

  // Intercept off: the button says so.
  status = { ...status, interceptSend: false };
  window.chrome.storage.sync.get = (d, cb) => cb({ ...d, interceptSend: false });
}

// Status labels (core.toolbarStatus) for the other states.
{
  const window = new Window({ url: 'https://chatgpt.com/' });
  window.chrome = { i18n: it };
  window.eval(coreSrc);
  const C = window.PseudoraCore;
  assert.equal(C.toolbarStatus({ configured: false }).label, 'Pseudora · accedi');
  assert.equal(C.toolbarStatus({ configured: true, interceptSend: false }).label, 'Pseudora · invio libero');
  assert.equal(C.toolbarStatus({ configured: true, interceptSend: true }).label, 'Protetto');
}
console.log('composer: ok');
