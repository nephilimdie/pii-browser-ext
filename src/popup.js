const $ = id => document.getElementById(id);
const { t, apply, docOptions, migrate } = globalThis.PseudoraCore;

// piiApiKey deliberately lives in storage.local, not here — storage.sync is
// uploaded to the user's Google account. See background.js.
const SYNC_DEFAULTS = {
  piiApiUrl: '',
  piiOauthClientId: '',
  language: 'it',
  mode: 'tag',
  docType: globalThis.PseudoraCore.DEFAULT_DOC_TYPE,
  interceptSend: false,
  protectImages: true,
  faceStyle: 'blur',
};
const DEFAULT_API_URL = 'https://pseudora.cloud';
const FACE_STYLES = ['blur', 'pixelate', 'black'];

/** The saved settings, the only source the document-type list is rebuilt from (never the <select>). */
const settings = { ...SYNC_DEFAULTS };
let configured = false;
let docs = { presets: [], policies: [] };

// ── Boot ──────────────────────────────────────────────────────────────────────

function syncTheme() {
  document.body.dataset.piiTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
syncTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncTheme);
document.documentElement.lang = (chrome.i18n?.getUILanguage?.() || 'it').startsWith('it') ? 'it' : 'en';
apply(document);
// Read from the manifest so the footer can never drift out of sync with it.
$('ext-version').textContent = `v${chrome.runtime.getManifest().version}`;

const ready = boot();

async function boot() {
  const [raw, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get({ piiApiKey: '' }),
  ]);
  // The worker migrates on start; doing it here too covers a popup opened first after an update.
  const patch = migrate(raw);
  if (patch) {
    await chrome.storage.sync.set(patch.set);
    await chrome.storage.sync.remove(patch.remove);
    Object.assign(raw, patch.set);
  }
  Object.assign(settings, SYNC_DEFAULTS, pick(raw, Object.keys(SYNC_DEFAULTS)));

  $('api-url').value         = settings.piiApiUrl || DEFAULT_API_URL;
  $('api-key').value         = local.piiApiKey;
  $('oauth-client-id').value = settings.piiOauthClientId;
  $('language').value        = settings.language;
  $('intercept-send').checked = !!settings.interceptSend;
  $('protect-images').checked = settings.protectImages !== false;
  $('face-style').value      = FACE_STYLES.includes(settings.faceStyle) ? settings.faceStyle : 'blur';
  paintMode();
  paintImagesToggle();
  renderDocTypes();                                   // built-in presets right away, saved value selected
  checkHttpWarn($('api-url').value);

  if (settings.piiApiUrl && !settings.piiOauthClientId) autoDetectClientId(settings.piiApiUrl);
  await refreshAccountUI(local.piiApiKey);
  loadDocTypes();
  showShortcuts();
  if (location.hash === '#account') { selectTab('account'); $('advanced').open = !settings.piiApiUrl; }
}

/** <option> without the Option constructor (missing in some test DOMs). */
function option(label, value, selected) {
  const o = document.createElement('option');
  o.textContent = label; o.value = value; o.selected = !!selected;
  return o;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}

// ── Immediate save ────────────────────────────────────────────────────────────

/**
 * Why: 1.2.x only saved preferences on "Save" in another tab, so "Intercept send"
 *      looked on while it was off. Every control now saves on change.
 * What: writes { key: value } to storage.sync, updates `settings` and shows "Salvato"
 *       (role=status) inside the control's [data-field] row for 2 s.
 * Test: tests/popup.mjs toggles each control and reads storage + the "Salvato" text.
 */
async function save(key, value, from) {
  settings[key] = value;
  await chrome.storage.sync.set({ [key]: value });
  const row = from.closest('[data-field]');
  const note = row?.querySelector(':scope > .saved');
  if (!note) return;
  note.textContent = t('saved');
  clearTimeout(note._timer);
  note._timer = setTimeout(() => { note.textContent = ''; }, 2000);
}

$('intercept-send').addEventListener('change', e => {
  save('interceptSend', e.target.checked, e.target);
  paintImagesToggle();
  paintStatus();
});
$('protect-images').addEventListener('change', e => save('protectImages', e.target.checked, e.target));
$('face-style').addEventListener('change', e => save('faceStyle', e.target.value, e.target));
$('language').addEventListener('change', e => save('language', e.target.value, e.target));
$('doc-type').addEventListener('change', e => save('docType', e.target.value, e.target));
document.querySelectorAll('.seg [data-mode]').forEach(b => {
  b.addEventListener('click', () => { save('mode', b.dataset.mode, b); paintMode(); });
  b.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const other = document.querySelector(`.seg [data-mode="${b.dataset.mode === 'tag' ? 'surrogate' : 'tag'}"]`);
    other.click(); other.focus();
  });
});

function paintMode() {
  const surrogate = settings.mode === 'surrogate';
  document.querySelectorAll('.seg [data-mode]').forEach(b => {
    const on = b.dataset.mode === settings.mode;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const example = $('mode-example');
  example.textContent = surrogate ? 'Luca Bianchi' : '[PERSON_1]';
  example.className = `chip ${surrogate ? 'is-surrogate' : 'is-tag'}`;
  $('mode-hint-text').textContent = t(surrogate ? 'modeSurrogateShort' : 'modeTagShort');
}

/** Image protection only acts while send protection is on: say so instead of a dead switch. */
function paintImagesToggle() {
  const on = $('intercept-send').checked;
  $('protect-images').disabled = !on;
  $('protect-images').closest('.row-toggle').classList.toggle('is-disabled', !on);
  $('images-desc').textContent = t(on ? 'imagesDesc' : 'imagesNeedsIntercept');
}

// ── Document type (one list for text and images) ──────────────────────────────

/**
 * Why: 1.2.x rebuilt the list from the <select>'s current value, which was still "generic"
 *      while the team policies loaded, so a saved policy silently reset (the race).
 * What: rebuilds #doc-type from `docs` with `settings.docType` selected (core.docOptions).
 * Test: tests/popup.mjs, a saved "domain:legal_it" stays selected after the list arrives.
 */
function renderDocTypes() {
  const { groups, selected } = docOptions(docs, settings.docType);
  const sel = $('doc-type');
  sel.replaceChildren(...groups.map(g => {
    const og = document.createElement('optgroup');
    og.label = g.label;
    g.options.forEach(o => og.appendChild(option(o.label, o.value, o.value === selected)));
    return og;
  }));
  sel.value = selected;
}

async function loadDocTypes() {
  const resp = await sendMsg({ type: 'GET_DOC_TYPES' });
  if (resp && !resp.error) docs = resp;
  renderDocTypes();
}

// ── Status and account ────────────────────────────────────────────────────────

function paintStatus() {
  const pill = $('status-pill');
  const state = !configured ? 'setup' : settings.interceptSend ? 'on' : 'off';
  pill.dataset.state = state;
  $('status-label').textContent = t({ setup: 'statusSetup', on: 'statusOn', off: 'statusOff' }[state]);
  $('onboard').hidden = configured;
}

async function refreshAccountUI(apiKey = $('api-key').value.trim()) {
  const resp = await sendMsg({ type: 'OAUTH_STATUS' });
  configured = !!settings.piiApiUrl && (!!resp?.loggedIn || !!apiKey);
  if (resp?.loggedIn) showLoggedIn(resp.name, resp.email);
  else showLoggedOut();
  paintStatus();
}

function showLoggedIn(name, email) {
  $('account-logged-in').hidden = false;
  $('account-logged-out').hidden = true;
  $('account-name').textContent  = name || t('accountUser');
  $('account-email').textContent = email || '';
  $('account-avatar').textContent = (name || 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  loadTeams();
}

function showLoggedOut() {
  $('account-logged-in').hidden = true;
  $('account-logged-out').hidden = false;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function selectTab(name) {
  document.querySelectorAll('.tab').forEach(tab => {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`tab-${tab.dataset.tab}`).hidden = !on;
  });
}
document.querySelectorAll('.tab').forEach((tab, i, all) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const next = all[(i + step + all.length) % all.length];
    selectTab(next.dataset.tab); next.focus();
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

const apiUrl = () => ($('api-url').value.trim() || DEFAULT_API_URL).replace(/\/$/, '');

/** Match pattern covering every path on the API URL's origin. */
function originPattern(url) {
  try { return `${new URL(url).origin}/*`; } catch { return null; }
}

/**
 * Why: first run must be one button ("Accedi con Pseudora"), with pseudora.cloud prefilled.
 * What: inside the click gesture asks for the server's origin, saves the URL, starts OAuth in
 *       a new tab and polls until the login lands. `msgId` is the status line to narrate in.
 * Test: manual (capture harness first-run screenshot); the permission call stays synchronous.
 */
function startLogin(msgId, button) {
  const url = apiUrl();
  const pattern = originPattern(url);
  if (!pattern) { showMsg(msgId, t('errInvalidUrl'), 'err'); return; }
  button.disabled = true;
  chrome.permissions.request({ origins: [pattern] }, async granted => {
    try {
      if (!granted) { showMsg(msgId, t('errHostDenied'), 'err'); return; }
      if (settings.piiApiUrl !== url) { settings.piiApiUrl = url; await chrome.storage.sync.set({ piiApiUrl: url }); }
      showMsg(msgId, t('loginConnecting'), '');
      const resp = await sendMsg({ type: 'OAUTH_INITIATE', url, clientId: $('oauth-client-id').value.trim() });
      if (resp?.error || !resp?.authUrl) throw new Error(resp?.error || 'no auth URL');
      await chrome.tabs.create({ url: resp.authUrl });
      showMsg(msgId, t('loginContinueInTab'), '');
      const interval = setInterval(async () => {
        const status = await sendMsg({ type: 'OAUTH_STATUS' });
        if (!status?.loggedIn) return;
        clearInterval(interval);
        showMsg(msgId, '', '');
        await refreshAccountUI();
        loadDocTypes();
      }, 1000);
      setTimeout(() => clearInterval(interval), 300_000);
    } catch (_) {
      showMsg(msgId, t('errLoginFailed'), 'err');
    } finally {
      button.disabled = false;
    }
  });
}

$('login-btn').addEventListener('click', () => startLogin('login-msg', $('login-btn')));
$('onboard-login').addEventListener('click', () => startLogin('onboard-msg', $('onboard-login')));
$('onboard-advanced').addEventListener('click', () => { selectTab('account'); $('advanced').open = true; $('api-url').focus(); });

$('logout-btn').addEventListener('click', async () => {
  await sendMsg({ type: 'OAUTH_LOGOUT' });
  await refreshAccountUI();
});

// ── Teams ─────────────────────────────────────────────────────────────────────

async function loadTeams() {
  const resp = await sendMsg({ type: 'GET_TEAMS' });
  const teams = Array.isArray(resp?.teams) ? resp.teams : [];
  $('team-field').hidden = teams.length === 0;
  if (!teams.length) return;
  let selected = resp.selectedTeamCode;
  if (!selected) {
    selected = teams[0].tenant_code;
    await sendMsg({ type: 'SELECT_TEAM', teamCode: selected });
  }
  const sel = $('team-select');
  sel.replaceChildren(...teams.map(tm => option(tm.name || tm.tenant_code, tm.tenant_code, tm.tenant_code === selected)));
  sel.disabled = teams.length === 1;
}

$('team-select').addEventListener('change', async e => {
  await sendMsg({ type: 'SELECT_TEAM', teamCode: e.target.value });
  const note = e.target.closest('[data-field]').querySelector('.saved');
  note.textContent = t('saved');
  setTimeout(() => { note.textContent = ''; }, 2000);
  loadDocTypes();                                     // team policies differ per team
});

// ── Advanced: connection ──────────────────────────────────────────────────────

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
  try {
    const { protocol, hostname } = new URL(url);
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    $('url-http-warn').hidden = !(protocol === 'http:' && !isLocal);
  } catch { $('url-http-warn').hidden = true; }
}

$('api-url').addEventListener('input', () => checkHttpWarn(apiUrl()));

$('toggle-key').addEventListener('click', () => {
  const inp = $('api-key');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  $('toggle-key').setAttribute('aria-pressed', String(show));
});

/** Asks for the origin inside the click gesture, then runs `then(url)`; reports refusals. */
function withHost(then) {
  const url = apiUrl();
  const pattern = originPattern(url);
  if (!pattern) { showMsg('settings-msg', t('errInvalidUrl'), 'err'); return; }
  // Must run inside the click gesture: request() resolves immediately when the
  // origin was already granted, so calling it unconditionally is safe.
  chrome.permissions.request({ origins: [pattern] }, granted => {
    if (!granted) { showMsg('settings-msg', t('errHostDenied'), 'err'); return; }
    then(url);
  });
}

$('save-btn').addEventListener('click', () => withHost(async url => {
  const key = $('api-key').value.trim();
  const clientId = $('oauth-client-id').value.trim();
  settings.piiApiUrl = url;
  settings.piiOauthClientId = clientId;
  // The key goes to local storage only — storage.sync would upload it to the
  // user's Google account.
  await Promise.all([
    chrome.storage.sync.set({ piiApiUrl: url, piiOauthClientId: clientId }),
    chrome.storage.local.set({ piiApiKey: key }),
  ]);
  if (!clientId) autoDetectClientId(url);
  showMsg('settings-msg', t('connectionSaved'), 'ok');
  await refreshAccountUI(key);
  if (configured) checkConnection(url, key || null);
  loadDocTypes();
}));

$('test-btn').addEventListener('click', () => withHost(url => {
  showMsg('settings-msg', t('connectionTesting'), '');
  checkConnection(url, $('api-key').value.trim() || null);
}));

async function checkConnection(url, key) {
  const resp = await sendMsg({ type: 'HEALTH_CHECK', url, key });
  if (resp && !resp.error) { showMsg('settings-msg', t('connectionOk'), 'ok'); return true; }
  const kind = { auth: 'connectionAuth', network: 'connectionNetwork', server: 'connectionServer' }[resp?.responseCode];
  showMsg('settings-msg', t(kind || 'connectionFailed'), 'err');
  return false;
}

// Reset is destructive (signs out): confirm inline, never with a bare link.
$('clear-cache-btn').addEventListener('click', () => {
  $('clear-confirm').hidden = false;
  $('clear-cache-btn').hidden = true;
  $('clear-no').focus();
});
$('clear-no').addEventListener('click', () => {
  $('clear-confirm').hidden = true;
  $('clear-cache-btn').hidden = false;
  $('clear-cache-btn').focus();
});
$('clear-yes').addEventListener('click', async () => {
  await sendMsg({ type: 'CLEAR_CACHE' });
  $('oauth-client-id').value = '';
  $('clear-confirm').hidden = true;
  $('clear-cache-btn').hidden = false;
  await refreshAccountUI();
  showMsg('clear-cache-msg', t('resetDone'), 'ok');
  $('clear-cache-btn').focus();
});

// ── Shortcuts and protected screenshot ────────────────────────────────────────

const COMMAND_LABELS = { anonymize: 'cmdAnonymize', restore: 'cmdRestore', 'protected-screenshot': 'cmdScreenshot' };

function showShortcuts() {
  chrome.commands?.getAll(cmds => {
    const list = $('shortcut-list');
    list.replaceChildren();
    for (const name of Object.keys(COMMAND_LABELS)) {
      const key = cmds.find(c => c.name === name)?.shortcut;
      const dt = document.createElement('dt');
      const kbd = document.createElement('kbd');
      kbd.textContent = key || t('shortcutNotSet');
      dt.appendChild(kbd);
      const dd = document.createElement('dd');
      dd.textContent = t(COMMAND_LABELS[name]);
      list.append(dt, dd);
      if (name === 'protected-screenshot' && key) { $('shot-key').textContent = key; $('shot-key').hidden = false; }
    }
  });
}
$('edit-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// Opening the popup granted activeTab; the service worker captures, the tab shows
// the selection overlay, so the popup closes as soon as the overlay is up.
$('shot-btn').addEventListener('click', async () => {
  $('shot-btn').disabled = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const resp = tab ? await sendMsg({ type: 'START_SCREENSHOT', tabId: tab.id, windowId: tab.windowId }) : null;
  // not_configured is explained in the tab itself, like every other outcome.
  if (resp?.ok || resp?.responseCode === 'not_configured') { window.close(); return; }
  $('shot-btn').disabled = false;
  showMsg('shot-msg', resp?.error || t('errNotCapturable'), 'err');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function showMsg(id, text, type) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg' + (type ? ' ' + type : '');
  clearTimeout(el._timer);
  if (type === 'ok') el._timer = setTimeout(() => { el.textContent = ''; }, 5000);
}

function sendMsg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resp => {
    void chrome.runtime.lastError;                      // a closed worker is a null reply, not a crash
    resolve(resp);
  }));
}

globalThis.__popupReady = ready;                        // tests await the boot
