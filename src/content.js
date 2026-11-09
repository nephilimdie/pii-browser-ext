(function () {
  'use strict';

  /* ── Reading the composer ────────────────────────────────────────────────────
     innerText is the obvious way to read a contenteditable and the wrong one:
     the spec gives <p> a required line break count of 2, so the one-paragraph-
     per-line structure these editors use comes back with every newline
     doubled. Writing that back creates a blank line between every line, and it
     compounds on each round trip. Walk the blocks instead — one line each. */
  function blockText(node) {
    let out = '';
    const kids = [...node.childNodes];
    kids.forEach((child, i) => {
      if (child.nodeType === Node.TEXT_NODE) { out += child.nodeValue; return; }
      if (child.nodeName === 'BR') {
        // A <br> closing a block is the filler browsers add to keep an empty
        // line visible, not a line of its own.
        if (i !== kids.length - 1) out += '\n';
        return;
      }
      out += blockText(child);
    });
    return out;
  }

  function readComposer(el) {
    if (!el) return '';
    if (typeof el.value === 'string') return el.value;   // plain <textarea>
    const blocks = [...el.children].filter(n => n.nodeName === 'P' || n.nodeName === 'DIV');
    return blocks.length ? blocks.map(blockText).join('\n') : blockText(el);
  }

  /* ── Writing the composer ────────────────────────────────────────────────────
     Replace everything through the editing pipeline so the site's own state
     (React, ProseMirror, Lexical, Quill) sees a user edit. A plain <textarea>
     falls back to the native value setter plus an input event. */
  function writeComposer(el, text) {
    el.focus();
    if (typeof el.value === 'string') el.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    if (document.execCommand('insertText', false, text) || typeof el.value !== 'string') return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }


  const composer = globalThis.PseudoraComposer?.forHost(location.hostname);
  if (!composer) return;
  const site = {
    getText: readComposer,
    setText: writeComposer,
    getSendButton: () => composer.sendButton(document),
  };
  const { t, docOptions, docLabel, entityLabel, describeError, toolbarStatus } = globalThis.PseudoraCore;
  const UI = globalThis.PseudoraPanel;
  const guard = globalThis.PseudoraSendGuard;

  /* ── State ──────────────────────────────────────────────────────────────────*/
  let lastAnon          = null;   // { original, result, contextId, docType, mode }
  let activeTab         = 'anonymize';
  let toolbar           = null;
  let currentInput      = null;
  let anchorEl          = null;
  let posHandler        = null;
  let interceptSend     = false;
  let isAnonymizing     = false;
  let nativeSendAllowed = false;  // true only during our own post-anonymize click
  let docType           = globalThis.PseudoraCore.DEFAULT_DOC_TYPE;
  let mode              = 'tag';
  let status            = { configured: false, interceptSend: false, teamName: '', shortcuts: {} };
  let docs              = { presets: [], policies: [] };
  let lastRequest       = null;   // the last doAnonymize() options, for "Riprova"
  let view              = null;   // the open text panel: { body, foot, alert, ... }

  function applySettings(s) {
    if ('interceptSend' in s) interceptSend = !!s.interceptSend;
    if ('docType' in s && s.docType) docType = s.docType;
    if ('mode' in s) mode = s.mode || 'tag';
  }

  try {
    chrome.storage.sync.get({ interceptSend: false, docType, mode }, applySettings);
    // Without this, enabling interception in the popup left open tabs unprotected.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') applySettings(Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.newValue])));
      refreshStatus();
    });
  } catch (_) {}

  /* ── Safe message sender ────────────────────────────────────────────────────*/
  function safeSend(msg) {
    return new Promise(resolve => {
      try {
        if (!chrome.runtime?.id) { resolve({ error: 'Extension reloaded', responseCode: 'reloaded' }); return; }
        chrome.runtime.sendMessage(msg, resp => {
          if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message, responseCode: 'reloaded' }); return; }
          resolve(resp);
        });
      } catch (e) { resolve({ error: e.message, responseCode: 'reloaded' }); }
    });
  }

  const currentDocLabel = () => docLabel(docOptions(docs, docType).groups, docType);
  const modeLabel = m => t(m === 'surrogate' ? 'modeSurrogate' : 'modeTag');
  const shortcut = name => status.shortcuts?.[name] || '';

  /** <option> without the Option constructor (missing in some test DOMs). */
  function option(label, value, selected) {
    const o = document.createElement('option');
    o.textContent = label; o.value = value; o.selected = !!selected;
    return o;
  }

  /**
   * Why: the page button and panel header must follow login, team, intercept and document
   *      type changes made in the popup or another tab.
   * What: refreshes status (GET_STATUS) and the document-type list, then repaints.
   * Test: tests/composer.mjs, a status reply with interceptSend renders "Protetto · <team>".
   */
  let statusTimer = null;
  function refreshStatus() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      const [s, d] = await Promise.all([safeSend({ type: 'GET_STATUS' }), safeSend({ type: 'GET_DOC_TYPES' })]);
      if (s && !s.error) { status = s; applySettings(s); }
      if (d && !d.error) docs = d;
      paintToolbar();
      view?.setSubtitle(subtitle());
    }, 30);
  }

  const subtitle = () => t('panelSubtitle', { doc: currentDocLabel(), mode: modeLabel(mode) });

  /* ── Page button ────────────────────────────────────────────────────────────*/
  function createToolbar() {
    const bar = document.createElement('div');
    bar.className = 'pii-ui pii-toolbar';
    bar.id = 'pii-protect-toolbar';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pii-shield-btn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');

    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon48.png');
    img.width = 18; img.height = 18; img.alt = '';
    img.className = 'pii-shield-mark';
    const dot = document.createElement('span');
    dot.className = 'pii-shield-dot';
    dot.setAttribute('aria-hidden', 'true');
    const lbl = document.createElement('span');
    lbl.className = 'pii-shield-label';
    btn.append(img, dot, lbl);

    btn.addEventListener('click', togglePanel);
    bar.appendChild(btn);
    return { bar, btn, lbl };
  }

  function paintToolbar() {
    if (!toolbar) return;
    const st = toolbarStatus({ ...status, interceptSend, docLabel: currentDocLabel() });
    const busy = isAnonymizing;
    toolbar.btn.dataset.state = busy ? 'busy' : st.state;
    toolbar.lbl.textContent = busy ? t('toolbarBusy') : st.label;
    const keys = shortcut('anonymize');
    toolbar.btn.setAttribute('aria-label', busy ? t('toolbarBusy') : st.aria);
    toolbar.btn.title = keys ? `${st.aria} (${keys})` : st.aria;
    toolbar.btn.setAttribute('aria-expanded', String(UI.isOpen('text')));
    positionToolbar();
  }

  /** display:contents wrappers have no box; measure the nearest ancestor that renders. */
  function boxOf(el) {
    while (el && !el.getClientRects().length) el = el.parentElement;
    return el;
  }

  // Overlay beside the composer (never inside it): the site's pill layout is untouched.
  function positionToolbar() {
    if (!toolbar?.bar) return;
    const el = boxOf(anchorEl) || boxOf(currentInput);
    toolbar.bar.style.display = el ? '' : 'none';
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const bar = toolbar.bar.getBoundingClientRect();
    const W = bar.width || 120, H = bar.height || 36;
    let left = rect.right + 10;
    let top = rect.top + rect.height / 2 - H / 2;
    // No room on the right (narrow window, sidebar open): sit above the pill's right end.
    if (left + W > window.innerWidth - 4) { left = Math.max(4, rect.right - W); top = rect.top - H - 8; }
    top = Math.max(8, Math.min(top, window.innerHeight - H - 8));
    toolbar.bar.style.left = `${left}px`;
    toolbar.bar.style.top  = `${top}px`;
    UI.reposition();
  }

  function injectToolbar() {
    if (toolbar?.bar.isConnected) return;
    document.getElementById('pii-protect-toolbar')?.remove();
    toolbar = createToolbar();
    toolbar.bar.style.position = 'fixed';
    toolbar.bar.style.zIndex   = '2147483000';
    document.body.appendChild(toolbar.bar);
    UI.syncTheme();
    paintToolbar();
    if (!posHandler) {
      posHandler = positionToolbar;
      window.addEventListener('scroll', posHandler, true);
      window.addEventListener('resize', posHandler);
    }
  }

  /* ── Panel ──────────────────────────────────────────────────────────────────*/
  function togglePanel() {
    if (UI.close('text', 'dismissed')) { paintToolbar(); return; }
    openPanel();
  }

  /**
   * Why: text and images share one Pseudora panel (src/panel.js); this fills it for text.
   * What: opens the shell with the "Anonimizza" and "Risultato" tabs, document type and mode.
   * Test: tests/composer.mjs (dialog role, tabs, Esc returns focus to the page button).
   */
  function openPanel(tab = activeTab) {
    const shell = UI.open({
      owner: 'text', title: 'Pseudora', subtitle: subtitle(),
      returnTo: toolbar?.btn,
      onClose: () => { view = null; paintToolbar(); },
    });
    view = shell;
    const tabs = document.createElement('div');
    tabs.className = 'pii-tabs';
    tabs.setAttribute('role', 'tablist');
    const panes = {};
    const tabBtns = {};
    for (const name of ['anonymize', 'result']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pii-tab';
      b.id = `pii-tab-${name}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', `pii-pane-${name}`);
      b.textContent = t(name === 'anonymize' ? 'tabAnonymize' : 'tabResult');
      b.addEventListener('click', () => activate(name));
      b.addEventListener('keydown', e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = name === 'anonymize' ? 'result' : 'anonymize';
        activate(next); tabBtns[next].focus();
      });
      tabBtns[name] = b;
      tabs.appendChild(b);
      const pane = document.createElement('div');
      pane.className = 'pii-pane';
      pane.id = `pii-pane-${name}`;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', b.id);
      panes[name] = pane;
    }
    shell.body.append(tabs, panes.anonymize, panes.result);
    function activate(name) {
      activeTab = name;
      for (const n of Object.keys(panes)) {
        const on = n === name;
        tabBtns[n].setAttribute('aria-selected', String(on));
        tabBtns[n].tabIndex = on ? 0 : -1;
        panes[n].hidden = !on;
      }
      renderFoot(shell.foot, name);
      UI.reposition();
    }
    shell.activate = activate;
    shell.panes = panes;
    buildAnonPane(panes.anonymize);
    renderResult();
    activate(tab);
    paintToolbar();
    return shell;
  }

  function ensurePanel(tab) {
    if (!view) openPanel(tab); else view.activate(tab);
    return view;
  }

  function field(labelText, control, hint) {
    const wrap = document.createElement('div');
    wrap.className = 'pii-field';
    const label = document.createElement('label');
    label.className = 'pii-label';
    label.textContent = labelText;
    label.htmlFor = control.id;
    wrap.append(label, control);
    if (hint) {
      const h = document.createElement('p');
      h.className = 'pii-hint';
      h.id = `${control.id}-hint`;
      h.textContent = hint;
      control.setAttribute('aria-describedby', h.id);
      wrap.appendChild(h);
    }
    return wrap;
  }

  /** Shows "Salvato" next to a control for 2 s (role=status, so it is announced). */
  function saved(node) {
    let s = node.querySelector(':scope > .pii-saved');
    if (!s) {
      s = document.createElement('span');
      s.className = 'pii-saved';
      s.setAttribute('role', 'status');
      node.querySelector('.pii-label')?.after(s);
    }
    s.textContent = t('saved');
    clearTimeout(s._t);
    s._t = setTimeout(() => { s.textContent = ''; }, 2000);
  }

  function buildAnonPane(pane) {
    const state = document.createElement('p');
    state.className = `pii-state${interceptSend ? ' is-on' : ''}`;
    state.textContent = interceptSend ? t('paneInterceptOn') : t('paneInterceptOff');
    pane.appendChild(state);

    // Team (only when the account has more than one)
    safeSend({ type: 'GET_TEAMS' }).then(resp => {
      const teams = Array.isArray(resp?.teams) ? resp.teams : [];
      if (teams.length < 2 || !pane.isConnected) return;
      const sel = document.createElement('select');
      sel.id = 'pii-team';
      sel.className = 'pii-select';
      const selected = resp.selectedTeamCode || teams[0].tenant_code || '';
      teams.forEach(team => {
        const opt = option(team.name || team.tenant_code || 'Team', team.tenant_code || '');
        opt.selected = opt.value === selected;
        sel.appendChild(opt);
      });
      const f = field(t('fieldTeam'), sel);
      sel.addEventListener('change', async () => {
        await safeSend({ type: 'SELECT_TEAM', teamCode: sel.value });
        saved(f);
        refreshStatus();
      });
      pane.insertBefore(f, state.nextSibling);
    });

    // Document type: the saved value is selected, never the select's stale value (1.2.x race).
    const ct = document.createElement('select');
    ct.id = 'pii-doc-type';
    ct.className = 'pii-select';
    const docField = field(t('fieldDocType'), ct, t('fieldDocTypeHint'));
    const fill = () => {
      const { groups, selected } = docOptions(docs, docType);
      ct.replaceChildren(...groups.map(g => {
        const og = document.createElement('optgroup');
        og.label = g.label;
        g.options.forEach(o => og.appendChild(option(o.label, o.value, o.value === selected)));
        return og;
      }));
      ct.value = selected;
    };
    fill();
    ct._refill = fill;
    ct.addEventListener('change', () => {
      docType = ct.value;
      chrome.storage.sync.set({ docType });
      saved(docField);
      view?.setSubtitle(subtitle());
      paintToolbar();
    });
    pane.appendChild(docField);
    safeSend({ type: 'GET_DOC_TYPES' }).then(d => { if (d && !d.error) { docs = d; if (ct.isConnected) fill(); view?.setSubtitle(subtitle()); } });

    // Mode: a two-option segmented control with a one-line consequence.
    const modeWrap = document.createElement('div');
    modeWrap.className = 'pii-field';
    const legend = document.createElement('span');
    legend.className = 'pii-label';
    legend.id = 'pii-mode-label';
    legend.textContent = t('fieldMode');
    const seg = document.createElement('div');
    seg.className = 'pii-seg';
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-labelledby', legend.id);
    const explain = document.createElement('p');
    explain.className = 'pii-hint';
    const paintMode = () => {
      seg.querySelectorAll('button').forEach(b => {
        const on = b.dataset.mode === mode;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      explain.textContent = t(mode === 'surrogate' ? 'modeSurrogateHint' : 'modeTagHint');
    };
    for (const m of ['tag', 'surrogate']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mode = m;
      b.setAttribute('role', 'radio');
      b.textContent = modeLabel(m);
      b.addEventListener('click', () => {
        mode = m;
        chrome.storage.sync.set({ mode });
        paintMode();
        saved(modeWrap);
        view?.setSubtitle(subtitle());
      });
      b.addEventListener('keydown', e => {
        if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
        const other = seg.querySelector(`[data-mode="${m === 'tag' ? 'surrogate' : 'tag'}"]`);
        other.click(); other.focus();
      });
      seg.appendChild(b);
    }
    modeWrap.append(legend, seg, explain);
    paintMode();
    pane.appendChild(modeWrap);
  }

  function renderFoot(foot, tab) {
    foot.replaceChildren();
    const row = document.createElement('div');
    row.className = 'pii-actions';
    foot.appendChild(row);
    if (tab === 'anonymize') {
      const anon = UI.button(t('actionAnonymize'), '', () => doAnonymize({ thenSend: false, triggerButton: anon }));
      anon.classList.add('pii-anon-action');
      const send = UI.button(t('actionAnonymizeSend'), 'secondary', () => doAnonymize({ thenSend: true, triggerButton: send }));
      send.classList.add('pii-anon-action');
      row.append(anon, send);
      if (isAnonymizing) setAnonymizeLoading(true);
    } else if (lastAnon) {
      const copy = UI.button(t('actionCopyProtected'), '', () => copyText(copy, lastAnon.result.anonymized_text, t('actionCopyProtected')));
      const restore = UI.button(t('actionRestore'), 'caution', handleRestore);
      restore.title = t('actionRestoreHint');
      restore.setAttribute('aria-describedby', 'pii-restore-hint');
      const hint = document.createElement('p');
      hint.className = 'pii-hint pii-restore-hint';
      hint.id = 'pii-restore-hint';
      hint.textContent = t('actionRestoreHint');
      row.append(copy, restore);
      foot.append(hint, buildFeedbackBox());
    }
    const keys = [['anonymize', 'shortcutAnonymize'], ['restore', 'shortcutRestore']]
      .filter(([name]) => shortcut(name)).map(([name, key]) => t(key, { keys: shortcut(name) }));
    if (keys.length) {
      const k = document.createElement('p');
      k.className = 'pii-keys';
      k.textContent = keys.join(' · ');
      foot.appendChild(k);
    }
  }

  /* ── Result ─────────────────────────────────────────────────────────────────*/
  function renderResult(message) {
    const pane = view?.panes.result;
    if (!pane) return;
    pane.replaceChildren();
    if (!lastAnon) {
      const empty = document.createElement('p');
      empty.className = 'pii-empty';
      empty.textContent = message || t('resultEmpty');
      pane.appendChild(empty);
      return;
    }
    const { original, result } = lastAnon;
    const entities = Array.isArray(result.entities) ? result.entities : [];
    const surrogate = (result.mode || lastAnon.mode) === 'surrogate';

    const summary = document.createElement('p');
    summary.className = 'pii-summary';
    summary.textContent = entities.length
      ? t(entities.length === 1 ? 'resultSummaryOne' : 'resultSummaryMany', { n: entities.length })
      : t('resultSummaryNone');
    pane.appendChild(summary);

    if (entities.length) {
      const table = document.createElement('table');
      table.className = 'pii-map';
      const cap = document.createElement('caption');
      cap.textContent = t('resultMapCaption');
      const head = document.createElement('thead');
      head.innerHTML = '<tr><th scope="col"></th><th scope="col"></th><th scope="col"></th></tr>';
      const ths = head.querySelectorAll('th');
      ths[0].textContent = t('resultColSent'); ths[1].textContent = t('resultColOriginal'); ths[2].textContent = t('resultColType');
      const tbody = document.createElement('tbody');
      for (const e of entities) {
        const tr = document.createElement('tr');
        const tok = document.createElement('td');
        const chip = document.createElement('span');
        chip.className = `pii-chip ${surrogate ? 'is-surrogate' : 'is-tag'}`;
        chip.textContent = e.replacement || e.token || '';
        tok.appendChild(chip);
        const orig = document.createElement('td');
        const value = e.original_value || e.original || e.value || '';
        if (value) {
          const o = document.createElement('span');
          o.className = 'pii-chip is-original';
          o.textContent = value;
          orig.appendChild(o);
        } else {
          orig.className = 'pii-cell-muted';
          orig.textContent = t('resultValueHidden');
        }
        const typ = document.createElement('td');
        typ.className = 'pii-cell-type';
        typ.textContent = entityLabel(e.type);
        tr.append(tok, orig, typ);
        tbody.appendChild(tr);
      }
      table.append(cap, head, tbody);
      const scroll = document.createElement('div');
      scroll.className = 'pii-map-wrap';
      scroll.appendChild(table);
      pane.appendChild(scroll);
    }

    const sentLabel = document.createElement('p');
    sentLabel.className = 'pii-label';
    sentLabel.textContent = t('resultProtectedText');
    const sent = document.createElement('div');
    sent.className = 'pii-textbox';
    sent.tabIndex = 0;
    sent.setAttribute('aria-label', t('resultProtectedText'));
    highlightTokens(sent, result.anonymized_text, surrogate ? [] : entities);
    pane.append(sentLabel, sent);

    const det = document.createElement('details');
    det.className = 'pii-original';
    const sum = document.createElement('summary');
    sum.textContent = t('resultOriginalText');
    const origBox = document.createElement('div');
    origBox.className = 'pii-textbox is-original';
    origBox.textContent = original;
    const copyOrig = UI.button(t('actionCopyOriginal'), 'quiet', () => copyText(copyOrig, original, t('actionCopyOriginal')));
    det.append(sum, origBox, copyOrig);
    pane.appendChild(det);
  }

  /** Tag tokens ([PERSON_1]) as chips, built with text nodes only (no innerHTML). */
  function highlightTokens(node, text, entities) {
    const tokens = new Set(entities.map(e => e.replacement || e.token).filter(Boolean));
    const re = /(\[[A-Z_]+_\d+\])/g;
    String(text || '').split(re).forEach(part => {
      if (re.test(part) || tokens.has(part)) {
        const c = document.createElement('span');
        c.className = 'pii-chip is-tag';
        c.textContent = part;
        node.appendChild(c);
      } else if (part) node.appendChild(document.createTextNode(part));
      re.lastIndex = 0;
    });
  }

  function copyText(button, text, label) {
    navigator.clipboard.writeText(text).then(() => {
      button.textContent = t('copied');
      setTimeout(() => { button.textContent = label; }, 1600);
    }).catch(() => { button.textContent = t('copyFailed'); setTimeout(() => { button.textContent = label; }, 2400); });
  }

  function buildFeedbackBox() {
    const box = document.createElement('div');
    box.className = 'pii-feedback';
    const label = document.createElement('span');
    label.className = 'pii-feedback-label';
    label.textContent = t('feedbackQuestion');
    const yes = UI.button(t('feedbackYes'), 'quiet', () => submitInlineFeedback(box, true));
    const no = UI.button(t('feedbackNo'), 'quiet', () => submitInlineFeedback(box, false));
    box.append(label, yes, no);
    return box;
  }

  async function submitInlineFeedback(box, positive) {
    box.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const resp = await safeSend({ type: 'SUBMIT_FEEDBACK', positive });
    const label = document.createElement('span');
    label.className = 'pii-feedback-label';
    label.setAttribute('role', 'status');
    label.textContent = resp?.ok ? t('feedbackThanks') : t('feedbackFailed');
    box.replaceChildren(label);
  }

  /* ── Errors ─────────────────────────────────────────────────────────────────*/
  /**
   * Why: an intercepted Enter that fails is swallowed; without the panel the user only sees
   *      that Enter "did nothing", and each failure needs its own recovery.
   * What: opens the panel if closed and renders the typed error (core.describeError) in its
   *       role=alert region, with [Riprova] or [Accedi di nuovo] when that is the way out.
   * Test: tests/composer.mjs, a blocked intercepted send opens the panel with the policy notice.
   */
  function showError(resp) {
    const shell = ensurePanel(activeTab);
    const err = describeError(resp);
    const box = document.createElement('div');
    box.className = `pii-notice is-${err.tone}`;
    box.dataset.kind = err.kind;
    const title = document.createElement('p');
    title.className = 'pii-notice-title';
    title.textContent = err.title;
    const detail = document.createElement('p');
    detail.className = 'pii-notice-detail';
    detail.textContent = err.detail;
    box.append(title, detail);
    if (err.action) {
      const act = UI.button(t(err.action === 'retry' ? 'actionRetry' : 'actionLogin'), 'secondary', () => {
        shell.alert.replaceChildren();
        if (err.action === 'retry') doAnonymize(lastRequest || {});
        else safeSend({ type: 'OPEN_LOGIN' });
      });
      box.appendChild(act);
    }
    shell.alert.replaceChildren(box);
    UI.reposition();
  }

  function clearError() { view?.alert.replaceChildren(); }

  function setAnonymizeLoading(loading, triggerButton = null) {
    paintToolbar();
    const panel = document.getElementById('pii-main-panel');
    if (!panel) return;
    panel.querySelectorAll('.pii-anon-action').forEach(button => {
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.disabled = loading;
      button.setAttribute('aria-busy', String(loading && button === triggerButton));
      if (loading && button === triggerButton) {
        button.innerHTML = '<span class="pii-spinner" aria-hidden="true"></span>';
        button.appendChild(document.createTextNode(t('toolbarBusy')));
      } else if (!loading) button.textContent = button.dataset.label;
    });
    panel.querySelectorAll('#pii-team, #pii-doc-type, .pii-seg button').forEach(c => { c.disabled = loading; });
  }

  /* ── Core anonymize ─────────────────────────────────────────────────────────*/
  async function doAnonymize({ thenSend = false, triggerButton = null } = {}) {
    if (!currentInput || isAnonymizing) return;
    const text = site.getText(currentInput);
    if (!text.trim()) {
      ensurePanel('anonymize');
      view.alert.replaceChildren(Object.assign(document.createElement('p'), { className: 'pii-notice is-info', textContent: t('emptyComposer') }));
      return;
    }
    lastRequest = { thenSend };
    const used = { docType, mode };
    const contextId = lastAnon?.contextId || crypto.randomUUID();
    isAnonymizing = true;
    clearError();
    setAnonymizeLoading(true, triggerButton);

    try {
      const resp = await safeSend({ type: 'ANONYMIZE', text, contextId, ...used });
      if (resp?.error) { showError(resp); return; }
      if (resp?.safe !== true || typeof resp.anonymized_text !== 'string') {
        showError({ responseCode: 'unsafe' });
        return;
      }
      site.setText(currentInput, resp.anonymized_text);
      lastAnon = { original: text, result: resp, contextId, ...used };
      ensurePanel('result');
      renderResult();
      view.activate('result');

      if (thenSend) {
        const sendBtn = site.getSendButton?.();
        if (sendBtn && !sendBtn.disabled) {
          setTimeout(() => {
            // The site may have re-rendered the editor since; re-check right before sending.
            if (!guard.composerHolds(site.getText(currentInput), resp.anonymized_text)) {
              showError({ responseCode: 'editor_write_failed' });
              return;
            }
            nativeSendAllowed = true;
            try { sendBtn.click(); } finally { nativeSendAllowed = false; }
          }, 120);
        }
      }
    } finally {
      const releaseDelay = thenSend ? 550 : 0;
      setTimeout(() => {
        isAnonymizing = false;
        setAnonymizeLoading(false);
      }, releaseDelay);
    }
  }

  async function handleRestore() {
    if (!currentInput || !lastAnon) {
      ensurePanel('result');
      renderResult(t('restoreNothing'));
      return;
    }
    const text = site.getText(currentInput);
    const resp = await safeSend({ type: 'DEANONYMIZE', text, contextId: lastAnon.contextId, docType: lastAnon.docType });
    if (resp?.error || typeof resp?.restored_text !== 'string') { showError(resp?.error ? resp : { responseCode: 'failed' }); return; }
    site.setText(currentInput, resp.restored_text);
    lastAnon = null;
    if (view) { renderResult(t('restoreDone')); view.activate('result'); }
  }

  /* ── Keyboard shortcuts (manifest commands, forwarded by the service worker) ─*/
  try {
    chrome.runtime.onMessage?.addListener((msg, sender) => {
      if (sender?.id !== chrome.runtime.id || msg?.type !== 'PSEUDORA_COMMAND') return false;
      if (msg.command === 'anonymize') {
        const text = currentInput ? site.getText(currentInput) : '';
        // New text in the composer → protect it; already protected (or empty) → show the panel.
        if (text.trim() && !guard.composerHolds(text, lastAnon?.result.anonymized_text)) doAnonymize({});
        else togglePanel();
      } else if (msg.command === 'restore') handleRestore();
      return false;
    });
  } catch (_) {}

  /* ── Intercept ──────────────────────────────────────────────────────────────*/
  // A send attempt while anonymization is in flight is swallowed, not passed
  // through: the editor still holds the original text at that point.
  async function handleIntercept(e) {
    const action = guard.decide({
      interceptSend, inFlight: isAnonymizing, nativeSendAllowed,
      hasText: !!site.getText(currentInput).trim(),
    });
    if (action === 'pass') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (action === 'anonymize') await doAnonymize({ thenSend: true });
  }

  function setupInterceptors() {
    document.addEventListener('keydown', (e) => {
      if (!interceptSend) return;
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      if (!currentInput || (active !== currentInput && !currentInput.contains(active))) return;
      handleIntercept(e);
    }, true);

    document.addEventListener('click', (e) => {
      if (!interceptSend) return;
      const sendBtn = site.getSendButton?.();
      if (!sendBtn) return;
      if (e.target === sendBtn || sendBtn.contains(e.target)) handleIntercept(e);
    }, true);
  }

  /* ── Injection ──────────────────────────────────────────────────────────────
     SPA navigation (home <-> conversation) and re-renders replace the editor:
     re-resolve it on every DOM change so the toolbar and the send guard always
     follow the live element. Batched to one pass per frame. */
  function syncComposer() {
    syncQueued = false;
    const el = composer.input(document);
    if (el !== currentInput) { currentInput = el; anchorEl = el && composer.root(el); }
    if (el) injectToolbar();
    positionToolbar();
  }
  let syncQueued = false;
  new MutationObserver(() => {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(syncComposer);
  }).observe(document.documentElement, { childList: true, subtree: true });

  setupInterceptors();
  syncComposer();
  refreshStatus();
})();
