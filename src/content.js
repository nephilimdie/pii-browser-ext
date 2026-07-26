(function () {
  'use strict';

  /* ── Site adapters ──────────────────────────────────────────────────────────*/
  const ADAPTERS = {
    'chatgpt.com': {
      inputSelector: '#prompt-textarea, div[contenteditable="true"][data-lexical-editor]',
      getText(el) { return el.innerText || el.value || ''; },
      setText(el, text) {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      },
      anchorSelector: 'form',
      getSendButton() {
        return document.querySelector('button[data-testid="send-button"]')
          || document.querySelector('button[aria-label="Send prompt"]')
          || document.querySelector('button[aria-label="Send message"]');
      },
    },
    'claude.ai': {
      inputSelector: 'fieldset div[contenteditable="true"], div[contenteditable="true"][data-placeholder]',
      getText(el) { return el.innerText || ''; },
      setText(el, text) {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      },
      anchorSelector: 'fieldset, form',
      getSendButton() {
        return document.querySelector('button[aria-label="Send Message"]')
          || document.querySelector('button[data-value="send"]')
          || document.querySelector('button[aria-label="Send message"]');
      },
    },
    'gemini.google.com': {
      inputSelector: 'rich-textarea div[contenteditable="true"]',
      getText(el) { return el.innerText || ''; },
      setText(el, text) {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      },
      anchorSelector: 'form',
      getSendButton() {
        return document.querySelector('button[aria-label="Send message"]')
          || document.querySelector('button.send-button');
      },
    },
  };

  const hostname    = location.hostname.replace('www.', '');
  const adapterKey  = Object.keys(ADAPTERS).find(k => hostname.includes(k));
  if (!adapterKey) return;
  const site = ADAPTERS[adapterKey];

  /* ── State ──────────────────────────────────────────────────────────────────*/
  let contextId         = null;
  let originalText      = null;
  let lastAnonResult    = null;   // { original, anonResult }
  let mainPanel         = null;
  let activeTab         = 'anonymize';
  let toolbar           = null;
  let currentInput      = null;
  let anchorEl          = null;
  let posHandler        = null;
  let interceptSend     = false;
  let isAnonymizing     = false;
  let storedContextType = 'generic';
  let storedMode        = 'tag';
  let selectedTeamCode  = '';

  try {
    chrome.storage.sync.get(
      { interceptSend: false, contextType: 'generic', mode: 'tag' },
      s => {
        interceptSend     = s.interceptSend;
        storedContextType = s.contextType || 'generic';
        storedMode        = s.mode        || 'tag';
      }
    );
  } catch (_) {}

  /* ── Safe message sender ────────────────────────────────────────────────────*/
  function safeSend(msg) {
    return new Promise(resolve => {
      try {
        if (!chrome.runtime?.id) { resolve({ error: 'Extension reloaded — refresh the page.' }); return; }
        chrome.runtime.sendMessage(msg, resp => {
          if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message }); return; }
          resolve(resp);
        });
      } catch (e) { resolve({ error: e.message }); }
    });
  }

  /* ── Toolbar button ─────────────────────────────────────────────────────────*/
  function createToolbar() {
    const bar = document.createElement('div');
    bar.className = 'pii-toolbar';
    bar.id = 'pii-protect-toolbar';

    const btn = document.createElement('button');
    btn.className = 'pii-shield-btn';
    btn.title = 'PII Protect';

    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon48.png');
    img.width = 18; img.height = 18;
    img.style.cssText = 'border-radius:4px;flex-shrink:0;display:block;';
    btn.appendChild(img);

    const lbl = document.createElement('span');
    lbl.className = 'pii-shield-label';
    lbl.textContent = 'PII';
    btn.appendChild(lbl);

    btn.addEventListener('click', togglePanel);
    bar.appendChild(btn);
    return { bar, btn };
  }

  function positionToolbar() {
    if (!toolbar?.bar) return;
    const el = anchorEl || currentInput;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const W = 52, H = 58;
    let left = rect.right + 10;
    if (left + W > window.innerWidth - 4) left = rect.left - W - 10;
    let top = rect.top + rect.height / 2 - H / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - H - 8));
    toolbar.bar.style.left = `${left}px`;
    toolbar.bar.style.top  = `${top}px`;
  }

  function injectToolbar(inputEl) {
    if (document.getElementById('pii-protect-toolbar')) return;
    currentInput = inputEl;
    anchorEl = inputEl.closest(site.anchorSelector) || inputEl.parentElement;
    const { bar, btn } = createToolbar();
    toolbar = { bar, btn };
    bar.style.position = 'fixed';
    bar.style.zIndex   = '9998';
    document.body.appendChild(bar);
    positionToolbar();
    posHandler = positionToolbar;
    window.addEventListener('scroll', posHandler, true);
    window.addEventListener('resize', posHandler);
  }

  /* ── Context types & modes ──────────────────────────────────────────────────*/
  const CONTEXT_TYPES = [
    { code: 'generic',     label: 'Generic (default)' },
    { code: 'fine_appeal', label: 'Legal — Fine appeal' },
    { code: 'contract',    label: 'Contract' },
    { code: 'medical',     label: 'Medical' },
    { code: 'embedding',   label: 'Embedding (RAG)' },
  ];
  const MODES = [
    { code: 'tag',       label: 'Tag (reversible)' },
    { code: 'surrogate', label: 'Surrogate (fakes)' },
  ];

  /* ── Main tabbed panel ──────────────────────────────────────────────────────*/
  function togglePanel() {
    if (mainPanel) { mainPanel.remove(); mainPanel = null; return; }
    buildMainPanel();
  }

  function buildMainPanel() {
    document.getElementById('pii-main-panel')?.remove();

    const p = document.createElement('div');
    p.id = 'pii-main-panel';
    p.className = 'pii-panel';

    // ── Header
    const head = document.createElement('div');
    head.className = 'pii-panel-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'pii-panel-title';
    const hImg = document.createElement('img');
    hImg.src = chrome.runtime.getURL('icons/icon48.png');
    hImg.width = 16; hImg.height = 16;
    hImg.style.cssText = 'border-radius:3px;flex-shrink:0;';
    titleEl.appendChild(hImg);
    titleEl.appendChild(document.createTextNode(' PII Protect'));
    const closeBtn = document.createElement('button');
    closeBtn.className = 'pii-panel-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => { p.remove(); mainPanel = null; });
    head.appendChild(titleEl); head.appendChild(closeBtn);
    p.appendChild(head);

    // ── Tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'pii-tab-bar';
    const tabAnon   = makeTab('Anonymize', 'anonymize', tabBar, p);
    const tabResult = makeTab('Result',    'result',    tabBar, p);
    p.appendChild(tabBar);

    // ── Tab panes
    const paneAnon   = buildAnonPane();
    const paneResult = buildResultPane();
    paneAnon.dataset.tab   = 'anonymize';
    paneResult.dataset.tab = 'result';
    p.appendChild(paneAnon);
    p.appendChild(paneResult);

    // Activate correct tab
    function activateTab(name) {
      activeTab = name;
      [tabAnon, tabResult].forEach(t =>
        t.classList.toggle('pii-tab-active', t.dataset.tab === name)
      );
      [paneAnon, paneResult].forEach(pane =>
        pane.style.display = pane.dataset.tab === name ? '' : 'none'
      );
    }
    tabAnon._activate   = () => activateTab('anonymize');
    tabResult._activate = () => activateTab('result');
    activateTab(activeTab);

    // Expose pane updater on the panel element
    p._showResult = (orig, res) => {
      fillResultPane(paneResult, orig, res);
      activateTab('result');
    };
    p._showError = (msg) => {
      fillErrorPane(paneResult, msg);
      activateTab('result');
    };

    document.body.appendChild(p);
    mainPanel = p;
  }

  function makeTab(label, name, tabBar, panelEl) {
    const t = document.createElement('button');
    t.className = 'pii-tab';
    t.textContent = label;
    t.dataset.tab = name;
    t.addEventListener('click', () => t._activate?.());
    tabBar.appendChild(t);
    return t;
  }

  /* ── Anonymize pane ─────────────────────────────────────────────────────────*/
  function buildAnonPane() {
    const pane = document.createElement('div');
    pane.className = 'pii-pane';

    // Team
    const teamWrap = document.createElement('div');
    teamWrap.className = 'pii-field';
    teamWrap.style.display = 'none';
    const teamLabel = document.createElement('label');
    teamLabel.className = 'pii-field-label';
    teamLabel.textContent = 'Team';
    const teamSel = document.createElement('select');
    teamSel.className = 'pii-select';
    teamSel.id = 'pii-team';
    teamWrap.appendChild(teamLabel); teamWrap.appendChild(teamSel);
    pane.appendChild(teamWrap);

    // Document type
    const ctWrap = document.createElement('div');
    ctWrap.className = 'pii-field';
    const ctLabel = document.createElement('label');
    ctLabel.className = 'pii-field-label';
    ctLabel.textContent = 'Document type';
    const ctSel = document.createElement('select');
    ctSel.className = 'pii-select';
    ctSel.id = 'pii-ctx-type';
    CONTEXT_TYPES.forEach(({ code, label }) => {
      const opt = document.createElement('option');
      opt.value = code; opt.textContent = label;
      if (code === storedContextType) opt.selected = true;
      ctSel.appendChild(opt);
    });
    ctWrap.appendChild(ctLabel); ctWrap.appendChild(ctSel);
    pane.appendChild(ctWrap);
    refreshContextTypeOptions(ctSel, storedContextType);

    // Mode
    const modeWrap = document.createElement('div');
    modeWrap.className = 'pii-field';
    const modeLabel = document.createElement('label');
    modeLabel.className = 'pii-field-label';
    modeLabel.textContent = 'Mode';
    const modeSel = document.createElement('select');
    modeSel.className = 'pii-select';
    modeSel.id = 'pii-mode';
    MODES.forEach(({ code, label }) => {
      const opt = document.createElement('option');
      opt.value = code; opt.textContent = label;
      if (code === storedMode) opt.selected = true;
      modeSel.appendChild(opt);
    });
    modeWrap.appendChild(modeLabel); modeWrap.appendChild(modeSel);
    pane.appendChild(modeWrap);
    hydrateTeamSelect(teamWrap, teamSel, ctSel);

    ctSel.addEventListener('change', () => {
      storedContextType = ctSel.value || 'generic';
      chrome.storage.sync.set({ contextType: storedContextType });
    });
    modeSel.addEventListener('change', () => {
      storedMode = modeSel.value || 'tag';
      chrome.storage.sync.set({ mode: storedMode });
    });

    // Buttons
    const foot = document.createElement('div');
    foot.className = 'pii-pane-foot';

    const anonBtn = document.createElement('button');
    anonBtn.className = 'pii-btn pii-btn-outline pii-anon-action';
    anonBtn.textContent = 'Anonymize';
    anonBtn.addEventListener('click', () => {
      doAnonymize({ thenSend: false, contextType: ctSel.value, mode: modeSel.value, triggerButton: anonBtn });
    });

    const sendBtn = document.createElement('button');
    sendBtn.className = 'pii-btn pii-anon-action';
    sendBtn.innerHTML = 'Anonymize &amp; Send ➜';
    sendBtn.addEventListener('click', () => {
      doAnonymize({ thenSend: true, contextType: ctSel.value, mode: modeSel.value, triggerButton: sendBtn });
    });

    foot.appendChild(anonBtn);
    foot.appendChild(sendBtn);
    pane.appendChild(foot);
    return pane;
  }

  async function hydrateTeamSelect(teamWrap, teamSel, contextSelect) {
    const resp = await safeSend({ type: 'GET_TEAMS' });
    const teams = Array.isArray(resp?.teams) ? resp.teams : [];
    if (teams.length === 0) {
      teamWrap.style.display = 'none';
      return;
    }

    selectedTeamCode = resp.selectedTeamCode || teams[0].tenant_code || '';
    teamSel.innerHTML = '';
    teams.forEach(team => {
      const opt = document.createElement('option');
      opt.value = team.tenant_code || '';
      opt.textContent = team.name || team.tenant_code || 'Team';
      opt.selected = opt.value === selectedTeamCode;
      teamSel.appendChild(opt);
    });

    teamSel.disabled = teams.length === 1;
    teamWrap.style.display = '';

    if (!resp.selectedTeamCode && selectedTeamCode) {
      await safeSend({ type: 'SELECT_TEAM', teamCode: selectedTeamCode });
    }

    teamSel.addEventListener('change', async () => {
      selectedTeamCode = teamSel.value;
      await safeSend({ type: 'SELECT_TEAM', teamCode: selectedTeamCode });
      await refreshContextTypeOptions(contextSelect, contextSelect.value || storedContextType);
    });

    await refreshContextTypeOptions(contextSelect, contextSelect.value || storedContextType);
  }

  async function refreshContextTypeOptions(select, selectedValue = 'generic') {
    const [ctResp, dpResp] = await Promise.all([
      safeSend({ type: 'GET_CONTEXT_TYPES' }),
      safeSend({ type: 'GET_DOMAIN_POLICIES' }),
    ]);
    console.log('[PII Protect] context-types response:', ctResp);
    console.log('[PII Protect] domain-policies response:', dpResp);

    const current = selectedValue || select.value || 'generic';

    const contextTypes = Array.isArray(ctResp) ? ctResp : [];
    const builtinCodes = new Set(CONTEXT_TYPES.map(item => item.code));
    const extras = contextTypes
      .filter(item => item?.code && !builtinCodes.has(item.code))
      .map(item => ({ value: item.code, label: item.name || item.display_name || item.code }));
    const ctxOptions = [...CONTEXT_TYPES.map(c => ({ value: c.code, label: c.label })), ...extras];

    const policies = Array.isArray(dpResp) ? dpResp : [];
    const domainOptions = policies
      .filter(p => p?.domain)
      .map(p => ({ value: `domain:${p.domain}`, label: `${p.display_name || p.domain} (${p.default_mode || 'tag'})` }));

    select.innerHTML = '';

    const addGroup = (label, options) => {
      if (options.length === 0) return;
      const group = document.createElement('optgroup');
      group.label = label;
      options.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        opt.selected = value === current;
        group.appendChild(opt);
      });
      select.appendChild(group);
    };

    addGroup('Tipi di contesto', ctxOptions);
    addGroup('Policy di dominio', domainOptions);
  }

  /* ── Result pane ────────────────────────────────────────────────────────────*/
  function buildResultPane() {
    const pane = document.createElement('div');
    pane.className = 'pii-pane pii-result-pane';
    renderEmptyResult(pane);
    return pane;
  }

  function renderEmptyResult(pane) {
    pane.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'pii-empty';
    empty.textContent = 'No result yet. Use the Anonymize tab to get started.';
    pane.appendChild(empty);
  }

  function fillResultPane(pane, original, anonResult) {
    pane.innerHTML = '';
    const { anonymized_text, entities = [] } = anonResult;

    // Two-column comparison
    const cols = document.createElement('div');
    cols.className = 'pii-panel-cols';

    const origCol = document.createElement('div'); origCol.className = 'pii-panel-col';
    const origLbl = buildColumnHeader('Original', original);
    const origBody = document.createElement('div'); origBody.className = 'pii-col-body pii-col-original'; origBody.textContent = original;
    origCol.appendChild(origLbl); origCol.appendChild(origBody);

    const anonCol = document.createElement('div'); anonCol.className = 'pii-panel-col';
    const anonLbl = buildColumnHeader('Anonymized', anonymized_text);
    const anonBody = document.createElement('div'); anonBody.className = 'pii-col-body pii-col-anon';
    anonBody.innerHTML = highlightTokens(escHtml(anonymized_text));
    anonCol.appendChild(anonLbl); anonCol.appendChild(anonBody);

    cols.appendChild(origCol); cols.appendChild(anonCol);
    pane.appendChild(cols);

    // Entity list
    if (entities.length > 0) {
      const list = document.createElement('div');
      list.className = 'pii-entity-list';
      entities.forEach(e => {
        const row = document.createElement('div'); row.className = 'pii-entity-row';
        const tok = document.createElement('span'); tok.className = 'pii-entity-token'; tok.textContent = e.replacement || e.token || '';
        const typ = document.createElement('span'); typ.className = 'pii-entity-type'; typ.textContent = e.type || '';
        row.appendChild(tok);
        const origVal = e.original_value || e.original || null;
        if (origVal) {
          const arr  = document.createElement('span'); arr.className = 'pii-entity-arrow'; arr.textContent = '→';
          const orig = document.createElement('span'); orig.className = 'pii-entity-orig'; orig.textContent = origVal;
          row.appendChild(arr); row.appendChild(orig);
        }
        row.appendChild(typ);
        list.appendChild(row);
      });
      pane.appendChild(list);
    }

    pane.appendChild(buildFeedbackBox());

    // Footer
    const foot = document.createElement('div');
    foot.className = 'pii-pane-foot';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'pii-btn pii-btn-restore';
    restoreBtn.textContent = '🔓 Restore';
    restoreBtn.addEventListener('click', handleRestore);
    foot.appendChild(restoreBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'pii-btn pii-btn-outline';
    copyBtn.textContent = 'Copy anonymized';
    copyBtn.addEventListener('click', () => copyText(copyBtn, anonymized_text, 'Copy anonymized'));
    foot.appendChild(copyBtn);
    pane.appendChild(foot);
  }

  function buildColumnHeader(label, textToCopy) {
    const header = document.createElement('div');
    header.className = 'pii-col-label';

    const text = document.createElement('span');
    text.textContent = label;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'pii-copy-mini';
    copyBtn.textContent = 'Copy';
    copyBtn.title = `Copy ${label.toLowerCase()} text`;
    copyBtn.addEventListener('click', () => copyText(copyBtn, textToCopy, 'Copy'));

    header.appendChild(text);
    header.appendChild(copyBtn);
    return header;
  }

  function copyText(button, text, defaultLabel) {
    navigator.clipboard.writeText(text).then(() => {
      button.textContent = 'Copied';
      button.disabled = true;
      setTimeout(() => {
        button.textContent = defaultLabel;
        button.disabled = false;
      }, 1600);
    });
  }

  function buildFeedbackBox() {
    const box = document.createElement('div');
    box.className = 'pii-feedback-box';

    const label = document.createElement('span');
    label.className = 'pii-feedback-label';
    label.textContent = 'Was this anonymization useful?';

    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'pii-feedback-btn';
    yesBtn.textContent = 'Yes';
    yesBtn.addEventListener('click', () => submitInlineFeedback(box, true));

    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'pii-feedback-btn';
    noBtn.textContent = 'No';
    noBtn.addEventListener('click', () => submitInlineFeedback(box, false));

    box.appendChild(label);
    box.appendChild(yesBtn);
    box.appendChild(noBtn);
    return box;
  }

  async function submitInlineFeedback(box, positive) {
    box.querySelectorAll('button').forEach(button => { button.disabled = true; });
    const resp = await safeSend({ type: 'SUBMIT_FEEDBACK', positive });
    box.classList.add(positive ? 'pii-feedback-positive' : 'pii-feedback-negative');
    box.innerHTML = resp?.ok
      ? '<span class="pii-feedback-label">Thanks for the feedback.</span>'
      : '<span class="pii-feedback-label">Could not save feedback.</span>';
  }

  function fillErrorPane(pane, msg) {
    pane.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:14px 16px;font-size:13px;color:#374151;line-height:1.55;';
    const strong = document.createElement('strong'); strong.style.color = '#dc2626'; strong.textContent = msg;
    wrap.appendChild(strong);
    const hint = document.createElement('p'); hint.style.marginTop = '8px;';
    hint.textContent = 'Open the extension popup → Settings to configure API URL and login.';
    wrap.appendChild(hint);
    pane.appendChild(wrap);
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function highlightTokens(str) {
    return str.replace(/(\[[A-Z_]+_\d+\])/g, '<span class="pii-token-chip">$1</span>');
  }

  function setLoadingLabel(button, label) {
    button.innerHTML = `<span class="pii-spinner" aria-hidden="true"></span><span>${label}</span>`;
  }

  function setAnonymizeLoading(loading, { thenSend = false, triggerButton = null } = {}) {
    if (toolbar?.btn) {
      toolbar.btn.disabled = loading;
      toolbar.btn.classList.toggle('pii-is-loading', loading);
    }

    const panel = mainPanel || document.getElementById('pii-main-panel');
    if (!panel) return;

    panel.querySelectorAll('.pii-anon-action').forEach(button => {
      if (!button.dataset.defaultHtml) button.dataset.defaultHtml = button.innerHTML;
      button.disabled = loading;
      button.classList.toggle('pii-is-loading', loading && button === triggerButton);

      if (!loading) {
        button.innerHTML = button.dataset.defaultHtml;
      }
    });

    panel.querySelectorAll('#pii-team, #pii-ctx-type, #pii-mode').forEach(control => {
      control.disabled = loading;
    });

    if (loading && triggerButton) {
      setLoadingLabel(triggerButton, thenSend ? 'Anonymizing & sending...' : 'Anonymizing...');
    }
  }

  /* ── Core anonymize ─────────────────────────────────────────────────────────*/
  async function doAnonymize({ thenSend = false, contextType, mode, triggerButton = null } = {}) {
    if (!currentInput || isAnonymizing) return;
    const text = site.getText(currentInput);
    if (!text.trim()) return;

    const ct = contextType || storedContextType || 'generic';
    const md = mode        || storedMode        || 'tag';

    originalText = text;
    contextId = contextId || crypto.randomUUID();
    isAnonymizing = true;
    setAnonymizeLoading(true, { thenSend, triggerButton });

    try {
      const resp = await safeSend({ type: 'ANONYMIZE', text, contextId, contextType: ct, mode: md });

      if (resp?.error) {
        const code = resp.responseCode || '';
        // Blocked PII: the message is already user-facing and clear — show as-is.
        // Auth/config problems: append the settings hint.
        const isAuth = !code && (resp.error.includes('403') || resp.error.includes('401') || resp.error.includes('configured'));
        if (mainPanel) {
          mainPanel._showError(isAuth
            ? resp.error + '\nOpen the extension popup → Settings.'
            : resp.error);
        }
        return;
      }

      site.setText(currentInput, resp.anonymized_text);
      lastAnonResult = { original: originalText, anonResult: resp };

      if (mainPanel) {
        mainPanel._showResult(originalText, resp);
      } else {
        activeTab = 'result';
        buildMainPanel();
      }

      if (thenSend) {
        const sendBtn = site.getSendButton?.();
        if (sendBtn && !sendBtn.disabled) {
          setTimeout(() => { sendBtn.click(); }, 120);
        }
      }
    } finally {
      const releaseDelay = thenSend ? 550 : 0;
      setTimeout(() => {
        setAnonymizeLoading(false);
        isAnonymizing = false;
      }, releaseDelay);
    }
  }

  async function handleRestore() {
    if (!currentInput || !contextId) return;
    const text = site.getText(currentInput);
    const resp = await safeSend({ type: 'DEANONYMIZE', text, contextId });
    if (resp?.error) return;
    site.setText(currentInput, resp.restored_text);
    contextId = null; originalText = null; lastAnonResult = null;
    if (mainPanel) {
      const resultPane = mainPanel.querySelector('.pii-result-pane');
      if (resultPane) renderEmptyResult(resultPane);
      activeTab = 'anonymize';
      mainPanel.querySelectorAll('.pii-tab').forEach(t =>
        t.classList.toggle('pii-tab-active', t.dataset.tab === 'anonymize')
      );
      mainPanel.querySelectorAll('.pii-pane').forEach(pane =>
        pane.style.display = pane.dataset.tab === 'anonymize' ? '' : 'none'
      );
    }
  }

  /* ── Intercept ──────────────────────────────────────────────────────────────*/
  async function handleIntercept(e) {
    if (!interceptSend || isAnonymizing) return;
    const text = site.getText(currentInput);
    if (!text.trim()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    await doAnonymize({ thenSend: true });
  }

  function setupInterceptors() {
    document.addEventListener('keydown', (e) => {
      if (!interceptSend || isAnonymizing) return;
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      if (!currentInput || (active !== currentInput && !currentInput.contains(active))) return;
      handleIntercept(e);
    }, true);

    document.addEventListener('click', (e) => {
      if (!interceptSend || isAnonymizing) return;
      const sendBtn = site.getSendButton?.();
      if (!sendBtn) return;
      if (e.target === sendBtn || sendBtn.contains(e.target)) handleIntercept(e);
    }, true);
  }

  /* ── Injection ──────────────────────────────────────────────────────────────*/
  let injected = false;
  const observer = new MutationObserver(() => {
    if (injected && document.getElementById('pii-protect-toolbar')) return;
    const el = document.querySelector(site.inputSelector);
    if (el) { injected = true; injectToolbar(el); currentInput = el; }
    else { injected = false; }
  });

  setupInterceptors();
  observer.observe(document.body, { childList: true, subtree: true });
  const initEl = document.querySelector(site.inputSelector);
  if (initEl) { injected = true; injectToolbar(initEl); }
})();
