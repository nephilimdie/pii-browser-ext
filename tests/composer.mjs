import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

// Composer detection against markup captured from the live sites, and the content
// script following the editor across SPA re-renders. Regression for 1.1.1: the
// Nov 2026 chatgpt.com composer (textarea[name="prompt"]) left the toolbar missing.
const read = f => readFile(new URL(f, import.meta.url), 'utf8');
const [composerSrc, sendGuardSrc, contentSrc, chatgpt2026] = await Promise.all([
  read('../src/composer.js'), read('../src/send-guard.js'), read('../src/content.js'),
  read('./fixtures/chatgpt-composer-2026-11.html'),
]);
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
  let anonReply = { safe: true, anonymized_text: '[PERSON_1] scrive', entities: [] };
  window.chrome = {
    runtime: {
      id: 'ext', lastError: null, getURL: p => `chrome-extension://ext/${p}`,
      sendMessage(msg, cb) {
        sent.push(msg);
        const reply = msg.type === 'ANONYMIZE' ? anonReply : {};
        Promise.resolve(reply).then(cb);
      },
    },
    storage: {
      sync: { get(d, cb) { cb({ ...d, interceptSend: true }); }, set() {} },
      onChanged: { addListener() {} },
    },
  };
  // Chrome refuses insertText in some editors; force the textarea value-setter fallback.
  document.execCommand = () => false;
  window.eval(sendGuardSrc);
  window.eval(contentSrc);
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
    assert.equal(ta.value, '[PERSON_1] scrive', `round ${round}: anonymized text written into the textarea`);
    assert.equal(submits.length, round, `round ${round}: anonymized prompt submitted via the send button`);
    assert.equal(toolbars(), 1, `round ${round}: exactly one toolbar`);
    assert.equal(document.getElementById('pii-protect-toolbar').style.display, '');
    await sleep(500);                      // let the in-flight guard release
  }

  // Intercepted Enter whose anonymization fails: nothing is sent and the panel opens with
  // the reason, so the user knows why Enter did nothing (no panel was open before).
  document.querySelector('#pii-main-panel .pii-panel-close').click();
  assert.equal(!!document.getElementById('pii-main-panel'), false, 'panel closed before the failing send');
  anonReply = { error: 'Crediti esauriti', responseCode: 'monthly_quota_exceeded' };
  const ta = document.querySelector('textarea[name="prompt"]');
  ta.value = 'Mario Rossi scrive';
  assert.equal(enter(ta).defaultPrevented, true, 'failing send still swallowed');
  await sleep(50);
  assert.equal(submits.length, 2, 'nothing submitted when anonymization fails');
  assert.equal(ta.value, 'Mario Rossi scrive');
  const errPanel = document.getElementById('pii-main-panel');
  assert.equal(!!errPanel, true, 'panel opened to explain the blocked send');
  assert.match(errPanel.textContent, /Crediti esauriti/);
}
console.log('composer: ok');
