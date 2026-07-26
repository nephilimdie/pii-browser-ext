const $ = id => document.getElementById(id);

// piiApiKey deliberately lives in storage.local, not here — storage.sync is
// uploaded to the user's Google account. See background.js.
const SYNC_DEFAULTS = {
  piiApiUrl: '',
  piiOauthClientId: '',
  language: 'it',
  mode: 'tag',
  contextType: 'generic',
  autoSend: false,
  interceptSend: false,
};

// ── Boot ──────────────────────────────────────────────────────────────────────

// Read from the manifest so the footer can never drift out of sync with it.
$('ext-version').textContent = `v${chrome.runtime.getManifest().version}`;

Promise.all([
  chrome.storage.sync.get(SYNC_DEFAULTS),
  chrome.storage.local.get({ piiApiKey: '' }),
]).then(([sync, local]) => {
  const apiKey = local.piiApiKey;

  $('api-url').value         = sync.piiApiUrl;
  $('api-key').value         = apiKey;
  $('oauth-client-id').value = sync.piiOauthClientId;
  $('language').value        = sync.language;
  $('mode').value            = sync.mode;
  $('context-type').value    = sync.contextType || 'generic';
  $('auto-send').checked     = sync.autoSend;
  $('intercept-send').checked= sync.interceptSend;

  const hasUrl = !!sync.piiApiUrl;
  if (!hasUrl) {
    $('banner-unconfigured').style.display = 'flex';
  }

  if (sync.piiApiUrl) {
    checkHttpWarn(sync.piiApiUrl);
    // If no client ID yet, try to auto-detect
    if (!sync.piiOauthClientId) autoDetectClientId(sync.piiApiUrl);
    loadContextTypes(sync.piiApiUrl, apiKey, sync.contextType || 'generic');
  }

  refreshAccountUI(sync.piiApiUrl, apiKey);
});

// ── Account UI ────────────────────────────────────────────────────────────────

async function refreshAccountUI(url, apiKey) {
  const resp = await sendMsg({ type: 'OAUTH_STATUS' });

  if (resp?.loggedIn) {
    showLoggedIn(resp.name, resp.email);
    if (url) {
      setConn('idle', 'Checking…');
      checkConnection(url, null).catch(() => setConn('err', 'Error'));
    }
  } else {
    showLoggedOut();
    if (url && apiKey) {
      checkConnection(url, apiKey);
    } else if (url || apiKey) {
      $('banner-unconfigured').style.display = 'flex';
    }
  }
}

function showLoggedIn(name, email) {
  $('account-logged-in').style.display  = 'block';
  $('account-logged-out').style.display = 'none';
  $('account-name').textContent  = name  || 'User';
  $('account-email').textContent = email || '';
  const initials = (name || 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  $('account-avatar').textContent = initials;
  setConn('ok', 'OAuth');
  $('feedback-row').style.display = 'none';
  checkTeamPicker();
}

function showLoggedOut() {
  $('account-logged-in').style.display  = 'none';
  $('account-logged-out').style.display = 'block';
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab, .tab-panel').forEach(el => el.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── OAuth client auto-detection ───────────────────────────────────────────────

async function autoDetectClientId(url) {
  if (!url) return;
  const resp = await sendMsg({ type: 'GET_OAUTH_CLIENT_INFO', url });
  // Always sync from the server: a cached client_id that no longer exists on the
  // server (e.g. after a reseed) would otherwise lock the OAuth flow.
  if (resp?.clientId && $('oauth-client-id').value !== resp.clientId) {
    $('oauth-client-id').value = resp.clientId;
    chrome.storage.sync.set({ piiOauthClientId: resp.clientId });
  }
}

function checkHttpWarn(url) {
  const warn = $('url-http-warn');
  if (!warn) return;
  try {
    const { protocol, hostname } = new URL(url);
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    warn.style.display = (protocol === 'http:' && !isLocal) ? '' : 'none';
  } catch { warn.style.display = 'none'; }
}

$('api-url').addEventListener('change', () => {
  const url = $('api-url').value.trim().replace(/\/$/, '');
  checkHttpWarn(url);
  if (url) autoDetectClientId(url);
});

// ── OAuth login ───────────────────────────────────────────────────────────────

$('login-btn').addEventListener('click', async () => {
  const url      = $('api-url').value.trim().replace(/\/$/, '');
  const clientId = $('oauth-client-id').value.trim();

  if (!url) { showMsg('login-msg', 'Set the API URL first.', 'err'); return; }

  showMsg('login-msg', 'Connecting…', '');
  $('login-btn').disabled = true;

  try {
    const resp = await sendMsg({ type: 'OAUTH_INITIATE', url, clientId });
    if (resp?.error) throw new Error(resp.error);

    // Open the authorization URL in a new tab; the callback page will close itself
    await chrome.tabs.create({ url: resp.authUrl });
    showMsg('login-msg', 'Complete login in the new tab.', '');

    // Poll for login completion (callback sets oauthAccessToken in local storage)
    const interval = setInterval(async () => {
      const status = await sendMsg({ type: 'OAUTH_STATUS' });
      if (status?.loggedIn) {
        clearInterval(interval);
        showLoggedIn(status.name, status.email);
        $('banner-unconfigured').style.display = 'none';
        showMsg('login-msg', '', '');
        // Run health check to update connection badge
        checkConnection(url, null);
      }
    }, 1000);

    // Stop polling after 5 min
    setTimeout(() => clearInterval(interval), 300_000);
  } catch (err) {
    showMsg('login-msg', '✗ ' + err.message, 'err');
  } finally {
    $('login-btn').disabled = false;
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────

$('logout-btn').addEventListener('click', async () => {
  await sendMsg({ type: 'OAUTH_LOGOUT' });
  showLoggedOut();
  setConn('idle', '—');
});

$('clear-cache-btn').addEventListener('click', async () => {
  $('clear-cache-btn').disabled = true;
  await sendMsg({ type: 'CLEAR_CACHE' });
  $('oauth-client-id').value = '';
  showLoggedOut();
  setConn('idle', '—');
  showMsg('clear-cache-msg', '✓ Cache cleared. Re-enter API URL to reconnect.', 'ok');
  $('clear-cache-btn').disabled = false;
});

// ── Team picker ───────────────────────────────────────────────────────────────

async function checkTeamPicker() {
  const resp = await sendMsg({ type: 'GET_TEAMS' });
  const teams = Array.isArray(resp?.teams) ? resp.teams : [];
  if (teams.length === 0) {
    $('team-picker').style.display     = 'none';
    $('active-team-row').style.display = 'none';
    return;
  }

  if (!resp.selectedTeamCode && teams.length > 1) {
    renderTeamPicker(teams);
  } else {
    const selectedCode = resp.selectedTeamCode || teams[0].tenant_code;
    if (!resp.selectedTeamCode && selectedCode) {
      await sendMsg({ type: 'SELECT_TEAM', teamCode: selectedCode });
    }
    const team = teams.find(t => t.tenant_code === selectedCode);
    renderActiveTeam(team?.name || selectedCode, teams);
    const url = $('api-url').value.trim().replace(/\/$/, '');
    const key = $('api-key').value.trim();
    if (url) loadContextTypes(url, key, $('context-type').value || 'generic');
  }
}

function renderTeamPicker(teams) {
  $('team-picker').style.display     = 'block';
  $('active-team-row').style.display = 'none';

  const list = $('team-list');
  list.innerHTML = '';
  teams.forEach(t => {
    const btn = document.createElement('button');
    btn.className   = 'team-option-btn';
    btn.textContent = t.name || t.tenant_code;
    btn.addEventListener('click', () => selectTeam(t));
    list.appendChild(btn);
  });
}

async function selectTeam(team) {
  await sendMsg({ type: 'SELECT_TEAM', teamCode: team.tenant_code });
  const resp = await sendMsg({ type: 'GET_TEAMS' });
  renderActiveTeam(team.name || team.tenant_code, resp?.teams || []);
  const url = $('api-url').value.trim().replace(/\/$/, '');
  const key = $('api-key').value.trim();
  if (url) loadContextTypes(url, key, $('context-type').value || 'generic');
}

function renderActiveTeam(name, teams) {
  $('team-picker').style.display     = 'none';
  $('active-team-row').style.display = 'flex';
  $('active-team-name').textContent  = name;

  $('change-team-btn')._teams = teams;
  $('change-team-btn').style.display = teams.length > 1 ? '' : 'none';
}

$('change-team-btn').addEventListener('click', () => {
  const teams = $('change-team-btn')._teams || [];
  if (teams.length > 0) renderTeamPicker(teams);
});

// ── Feedback ──────────────────────────────────────────────────────────────────

async function refreshFeedbackUI() {
  const op = await sendMsg({ type: 'GET_LAST_OPERATION' });
  const row = $('feedback-row');
  if (!op || op.feedback_sent) {
    row.style.display = 'none';
    return;
  }
  const label = op.type === 'anonymize' ? 'Was this anonymization useful?' : 'Was this de-anonymization useful?';
  $('feedback-label').textContent = label;
  $('feedback-up').className   = 'feedback-btn';
  $('feedback-down').className = 'feedback-btn';
  row.style.display = 'flex';
}

async function submitFeedback(positive) {
  $('feedback-up').disabled   = true;
  $('feedback-down').disabled = true;
  $('feedback-up').className   = positive ? 'feedback-btn active-up'   : 'feedback-btn';
  $('feedback-down').className = positive ? 'feedback-btn' : 'feedback-btn active-down';

  const resp = await sendMsg({ type: 'SUBMIT_FEEDBACK', positive });
  if (!resp?.ok) {
    $('feedback-up').disabled   = false;
    $('feedback-down').disabled = false;
    return;
  }
  $('feedback-label').textContent = positive ? 'Thanks for the feedback! 👍' : 'Thanks for the feedback! 👎';
  setTimeout(() => { $('feedback-row').style.display = 'none'; }, 2000);
}

$('feedback-up').addEventListener('click',   () => submitFeedback(true));
$('feedback-down').addEventListener('click', () => submitFeedback(false));

// ── Settings save / test ──────────────────────────────────────────────────────

$('toggle-key').addEventListener('click', () => {
  const inp = $('api-key');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

/** Match pattern covering every path on the API URL's origin. */
function originPattern(url) {
  try { return `${new URL(url).origin}/*`; } catch { return null; }
}

$('save-btn').addEventListener('click', () => {
  const url      = $('api-url').value.trim().replace(/\/$/, '');
  const key      = $('api-key').value.trim();
  const clientId = $('oauth-client-id').value.trim();

  if (!url) { showMsg('settings-msg', 'API URL is required.', 'err'); return; }

  const pattern = originPattern(url);
  if (!pattern) { showMsg('settings-msg', 'API URL is not a valid URL.', 'err'); return; }

  // Must run inside the click gesture: request() resolves immediately when the
  // origin was already granted, so calling it unconditionally is safe.
  chrome.permissions.request({ origins: [pattern] }, granted => {
    if (!granted) {
      showMsg('settings-msg', 'Access to that host was denied — settings not saved.', 'err');
      return;
    }
    persistSettings(url, key, clientId);
  });
});

function persistSettings(url, key, clientId) {
  const contextType = $('context-type').value || 'generic';

  // The key goes to local storage only — storage.sync would upload it to the
  // user's Google account.
  Promise.all([
    chrome.storage.sync.set({
      piiApiUrl:        url,
      piiOauthClientId: clientId,
      language:         $('language').value,
      mode:             $('mode').value,
      contextType,
      autoSend:         $('auto-send').checked,
      interceptSend:    $('intercept-send').checked,
    }),
    chrome.storage.local.set({ piiApiKey: key }),
  ]).then(async () => {
    $('banner-unconfigured').style.display = 'none';
    showMsg('settings-msg', 'Saved.', 'ok');

    const status = await sendMsg({ type: 'OAUTH_STATUS' });
    if (status?.loggedIn) {
      checkConnection(url, null);
    } else if (key) {
      checkConnection(url, key);
    }
    if (url) loadContextTypes(url, key, contextType);
  });
}

$('test-btn').addEventListener('click', () => {
  const url = $('api-url').value.trim().replace(/\/$/, '');
  const key = $('api-key').value.trim();
  if (!url) { showMsg('settings-msg', 'Fill in the API URL first.', 'err'); return; }

  const pattern = originPattern(url);
  if (!pattern) { showMsg('settings-msg', 'API URL is not a valid URL.', 'err'); return; }

  chrome.permissions.request({ origins: [pattern] }, granted => {
    if (!granted) {
      showMsg('settings-msg', 'Access to that host was denied.', 'err');
      return;
    }
    showMsg('settings-msg', 'Testing…', '');
    checkConnection(url, key).then(ok => {
      if (ok) showMsg('settings-msg', '✓ Connection OK.', 'ok');
    });
  });
});

// ── Context types ─────────────────────────────────────────────────────────────

const BUILTIN_CONTEXT_TYPES = [
  { code: 'generic',     label: 'Generic (default)' },
  { code: 'fine_appeal', label: 'Legal — Fine appeal' },
  { code: 'contract',    label: 'Contract' },
  { code: 'medical',     label: 'Medical' },
  { code: 'embedding',   label: 'Embedding (RAG)' },
];

async function loadContextTypes(url, key, selectedValue) {
  const [ctResp, dpResp] = await Promise.all([
    sendMsg({ type: 'GET_CONTEXT_TYPES', url, key }),
    sendMsg({ type: 'GET_DOMAIN_POLICIES', url, key }),
  ]);

  const sel = $('context-type');
  const current = selectedValue || sel.value || 'generic';

  // Context types: built-ins + any extras from the engine.
  const contextTypes = Array.isArray(ctResp) ? ctResp : [];
  const builtinCodes = new Set(BUILTIN_CONTEXT_TYPES.map(b => b.code));
  const extras = contextTypes
    .filter(ct => !builtinCodes.has(ct.code))
    .map(ct => ({ value: ct.code, label: ct.name || ct.display_name || ct.code }));
  const ctxOptions = [...BUILTIN_CONTEXT_TYPES.map(b => ({ value: b.code, label: b.label })), ...extras];

  // Domain policies: callable directly as "domain:<slug>".
  const policies = Array.isArray(dpResp) ? dpResp : [];
  const domainOptions = policies
    .filter(p => p.domain)
    .map(p => ({ value: `domain:${p.domain}`, label: `${p.display_name || p.domain} (${p.default_mode || 'tag'})` }));

  sel.innerHTML = '';

  const addGroup = (label, options) => {
    if (options.length === 0) return;
    const group = document.createElement('optgroup');
    group.label = label;
    options.forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === current) opt.selected = true;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  };

  addGroup('Tipi di contesto', ctxOptions);
  addGroup('Policy di dominio', domainOptions);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function checkConnection(url, key) {
  setConn('idle', 'Checking…');
  const resp = await sendMsg({ type: 'HEALTH_CHECK', url, key });
  if (resp && !resp.error) {
    const label = resp.auth_method === 'oauth' ? `OAuth · ${resp.role}` : resp.role || 'Connected';
    setConn('ok', label);
    return true;
  }
  setConn('err', 'Error');
  showMsg('settings-msg', '✗ ' + (resp?.error || 'Connection failed.'), 'err');
  return false;
}

function setConn(state, label) {
  const dot = $('conn-dot');
  dot.className = 'conn-dot' + (state !== 'idle' ? ' ' + state : '');
  $('conn-label').textContent = label;
}

function showMsg(id, text, type) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg' + (type ? ' ' + type : '');
  if (type === 'ok' || type === 'err') {
    setTimeout(() => { el.textContent = ''; el.className = 'msg'; }, 5000);
  }
}

function sendMsg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}
