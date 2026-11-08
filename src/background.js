/**
 * Service worker: ALL fetch() calls go through here to avoid CORS.
 * Popup and content scripts send messages; only the service worker hits the network.
 *
 * Auth: supports both OAuth 2.0 PKCE (Bearer token) and API Key (X-Api-Key).
 * Bearer takes priority when a valid (or refreshable) token is present.
 */

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Reject messages not from this extension (content scripts, popup, options page)
  if (sender.id !== chrome.runtime.id) return false;

  const handlers = {
    ANONYMIZE:             () => handleAnonymize(msg),
    DEANONYMIZE:           () => handleDeanonymize(msg),
    HEALTH_CHECK:          () => handleHealth(msg),
    GET_SETTINGS:          () => getSettings(),
    GET_CONTEXT_TYPES:     () => handleGetContextTypes(msg),
    GET_DOMAIN_POLICIES:   () => handleGetDomainPolicies(msg),
    GET_OAUTH_CLIENT_INFO: () => handleGetOAuthClientInfo(msg),
    OAUTH_INITIATE:        () => handleOAuthInitiate(msg),
    OAUTH_CALLBACK:        () => handleOAuthCallback(msg),
    OAUTH_LOGOUT:          () => handleOAuthLogout(),
    CLEAR_CACHE:           () => handleClearCache(),
    OAUTH_STATUS:          () => getOAuthStatus(),
    SUBMIT_FEEDBACK:       () => handleSubmitFeedback(msg),
    GET_LAST_OPERATION:    () => getLastOperation(),
    SELECT_TEAM:           () => handleSelectTeam(msg),
    GET_TEAMS:             () => getTeams(),
    REDACT_IMAGE:          () => handleRedactImage(msg),
    GET_IMAGE_OPTIONS:     () => handleImageOptions(),
    START_SCREENSHOT:      () => startScreenshot(msg.tabId, msg.windowId),
  };

  const fn = handlers[msg.type];
  if (!fn) return false;
  fn().then(sendResponse).catch(err => sendResponse({
    error: err.message,
    responseCode: err.responseCode || '',
    meta: err.meta || {},
  }));
  return true;
});

// The shortcut grants activeTab exactly like a toolbar click; errors surface on the badge.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'protected-screenshot' || tab?.id === undefined) return;
  startScreenshot(tab.id, tab.windowId).catch(err => flagError(tab.id, err.message));
});

// ── Settings ──────────────────────────────────────────────────────────────────

// Anything in SYNC_DEFAULTS is uploaded to the user's Google account and
// mirrored onto every device they sign into. Credentials belong in
// LOCAL_DEFAULTS, which never leaves the machine.
const SYNC_DEFAULTS = {
  piiApiUrl: '',
  piiOauthClientId: '',
  language: 'it',
  mode: 'tag',
  contextType: 'generic',
  autoSend: false,
  interceptSend: false,
  protectImages: true,
  imageDomain: 'generic_professional',
  faceStyle: 'blur',
  piiKeyRole: 'service',
};

const LOCAL_DEFAULTS = {
  piiApiKey: '',
  oauthAccessToken: '',
  oauthRefreshToken: '',
  oauthExpiresAt: 0,
  oauthUserName: '',
  oauthUserEmail: '',
  userTeams: [],
  selectedTeamCode: '',
};

/** @returns {Promise<typeof SYNC_DEFAULTS & typeof LOCAL_DEFAULTS>} */
async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS),
  ]);
  return /** @type {typeof SYNC_DEFAULTS & typeof LOCAL_DEFAULTS} */ ({ ...sync, ...local });
}

/**
 * Earlier versions kept piiApiKey in storage.sync, so it was uploaded to the
 * user's Google account. Pull any such copy down into local storage and delete
 * the synced one. Runs on install and on every service-worker start, since a
 * key can still arrive from another device that has not updated yet.
 */
async function migrateApiKeyOutOfSync() {
  const { piiApiKey } = await chrome.storage.sync.get({ piiApiKey: '' });
  if (!piiApiKey) return;

  const local = await chrome.storage.local.get({ piiApiKey: '' });
  if (!local.piiApiKey) {
    await chrome.storage.local.set({ piiApiKey });
  }
  await chrome.storage.sync.remove('piiApiKey');
}

migrateApiKeyOutOfSync();
chrome.runtime.onInstalled.addListener(() => { migrateApiKeyOutOfSync(); });

// ── OAuth client discovery ────────────────────────────────────────────────────

async function handleGetOAuthClientInfo({ url }) {
  if (!url) throw new Error('API URL required.');
  const r = await fetch(`${url.replace(/\/$/, '')}/oauth/client-info`, {
    headers: { Accept: 'application/json' },
  });
  if (r.status === 404) return { clientId: null };
  if (!r.ok) throw new Error(`Server returned ${r.status}`);
  const data = await r.json();
  return { clientId: data.client_id ?? null };
}

// ── OAuth PKCE ────────────────────────────────────────────────────────────────

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateVerifier() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

async function generateChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

async function handleOAuthInitiate({ url, clientId }) {
  if (!url) throw new Error('API URL not configured.');

  // Always fetch fresh client ID from server — catches rotations and new deployments
  const info = await handleGetOAuthClientInfo({ url }).catch(() => ({ clientId: null }));
  if (info.clientId) {
    clientId = info.clientId;
    await chrome.storage.sync.set({ piiOauthClientId: clientId });
  }

  if (!clientId) throw new Error('OAuth Client ID not found. Check that the server is configured correctly.');

  const verifier    = generateVerifier();
  const challenge   = await generateChallenge(verifier);
  // Encode extension ID and browser in state so the server callback page
  // can redirect back to chrome-extension://EXT_ID/src/oauth-callback.html
  const nonce       = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const browser     = navigator.userAgent.includes('Firefox') ? 'firefox' : 'chrome';
  const state       = btoa(JSON.stringify({ nonce, extId: chrome.runtime.id, browser }));
  const callbackUrl = `${url.replace(/\/$/, '')}/oauth/extension-callback`;

  await chrome.storage.local.set({ pkceVerifier: verifier, pkceState: state });

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    redirect_uri:          callbackUrl,
    scope:                 'anonymize deanonymize profile:read',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });

  return { authUrl: `${url.replace(/\/$/, '')}/oauth/authorize?${params}` };
}

async function handleOAuthCallback({ code, state }) {
  const local = /** @type {{ pkceVerifier?: string, pkceState?: string }} */ (
    await chrome.storage.local.get(['pkceVerifier', 'pkceState']));
  const sync  = /** @type {{ piiApiUrl: string, piiOauthClientId?: string }} */ (
    await chrome.storage.sync.get(['piiApiUrl', 'piiOauthClientId']));
  const url   = sync.piiApiUrl;
  const clientId = sync.piiOauthClientId;

  if (!local.pkceVerifier || !local.pkceState) {
    throw new Error('PKCE session missing — restart the login flow.');
  }
  if (!state || state !== local.pkceState) {
    throw new Error('OAuth state mismatch — possible CSRF.');
  }

  const callbackUrl = `${url.replace(/\/$/, '')}/oauth/extension-callback`;

  const r = await fetch(`${url.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type:    'authorization_code',
      client_id:     clientId,
      code,
      code_verifier: local.pkceVerifier,
      redirect_uri:  callbackUrl,
    }),
  });

  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Token exchange failed (${r.status})`);
  }

  const tokens = await r.json();

  // Fetch user info
  let userName = '', userEmail = '', userTeams = [], selectedTeamCode = '';
  try {
    const me = await fetch(`${url.replace(/\/$/, '')}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (me.ok) {
      const data = await me.json();
      userName  = data.name   || '';
      userEmail = data.email  || '';
      userTeams = data.teams  || [];
      // Auto-select if only one team
      if (userTeams.length === 1) {
        selectedTeamCode = userTeams[0].tenant_code || '';
      }
    }
  } catch {}

  await chrome.storage.local.set({
    oauthAccessToken:  tokens.access_token,
    oauthRefreshToken: tokens.refresh_token || '',
    oauthExpiresAt:    Date.now() + (tokens.expires_in ?? 3600) * 1000,
    oauthUserName:     userName,
    oauthUserEmail:    userEmail,
    userTeams,
    selectedTeamCode,
    pkceVerifier:      '',
    pkceState:         '',
  });

  return { ok: true, name: userName, email: userEmail, teams: userTeams, selectedTeamCode };
}

async function handleOAuthLogout() {
  await chrome.storage.local.set({
    oauthAccessToken:  '',
    oauthRefreshToken: '',
    oauthExpiresAt:    0,
    oauthUserName:     '',
    oauthUserEmail:    '',
    userTeams:         [],
    selectedTeamCode:  '',
  });
  return { ok: true };
}

async function handleClearCache() {
  await Promise.all([
    chrome.storage.local.set({
      oauthAccessToken:  '',
      oauthRefreshToken: '',
      oauthExpiresAt:    0,
      oauthUserName:     '',
      oauthUserEmail:    '',
      userTeams:         [],
      selectedTeamCode:  '',
      pkceVerifier:      '',
      pkceState:         '',
      lastOperation:     null,
    }),
    chrome.storage.sync.set({ piiOauthClientId: '' }),
  ]);
  return { ok: true };
}

async function getOAuthStatus() {
  const local = /** @type {typeof LOCAL_DEFAULTS} */ (await chrome.storage.local.get(LOCAL_DEFAULTS));
  const valid = !!local.oauthAccessToken && (
    !local.oauthExpiresAt || Date.now() < local.oauthExpiresAt - 60_000
  );
  return {
    loggedIn:         valid || (!!local.oauthRefreshToken),
    name:             local.oauthUserName,
    email:            local.oauthUserEmail,
    expiresAt:        local.oauthExpiresAt,
    teams:            local.userTeams || [],
    selectedTeamCode: local.selectedTeamCode || '',
  };
}

async function handleSelectTeam({ teamCode }) {
  await chrome.storage.local.set({ selectedTeamCode: teamCode });
  return { ok: true };
}

async function getTeams() {
  const local = await chrome.storage.local.get(['userTeams', 'selectedTeamCode']);
  return {
    teams:            local.userTeams || [],
    selectedTeamCode: local.selectedTeamCode || '',
  };
}

// ── Auth header resolution ────────────────────────────────────────────────────

async function getBearerToken(s) {
  if (!s.oauthAccessToken) return null;

  // Token still valid (with 60s buffer)?
  if (s.oauthExpiresAt && Date.now() < s.oauthExpiresAt - 60_000) {
    return s.oauthAccessToken;
  }

  // Try refresh
  if (!s.oauthRefreshToken || !s.piiApiUrl || !s.piiOauthClientId) return null;

  try {
    const r = await fetch(`${s.piiApiUrl.replace(/\/$/, '')}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type:    'refresh_token',
        client_id:     s.piiOauthClientId,
        refresh_token: s.oauthRefreshToken,
      }),
    });

    if (!r.ok) throw new Error(`refresh ${r.status}`);

    const tokens = await r.json();
    await chrome.storage.local.set({
      oauthAccessToken:  tokens.access_token,
      oauthRefreshToken: tokens.refresh_token || s.oauthRefreshToken,
      oauthExpiresAt:    Date.now() + (tokens.expires_in ?? 3600) * 1000,
    });
    return tokens.access_token;
  } catch {
    // Refresh failed — clear OAuth state so user must re-login
    await chrome.storage.local.set({ oauthAccessToken: '', oauthRefreshToken: '', oauthExpiresAt: 0 });
    return null;
  }
}

async function getAuthHeaders(s) {
  const bearer = await getBearerToken(s);
  if (bearer) {
    const headers = {
      Authorization:  `Bearer ${bearer}`,
      'X-Pii-Client': 'browser_extension',
    };
    if (s.selectedTeamCode) headers['X-Team-ID'] = s.selectedTeamCode;
    return headers;
  }
  if (s.piiApiKey) return { 'X-Api-Key': s.piiApiKey };
  throw new Error('Not authenticated — login with your Pseudora account or configure an API key.');
}

// ── Health check ──────────────────────────────────────────────────────────────

async function handleHealth({ url, key }) {
  const s = await getSettings();
  const baseUrl = (url || s.piiApiUrl || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('API URL not configured.');

  // Temporary settings override for test-only calls from the popup
  const testSettings = key ? { ...s, piiApiKey: key, oauthAccessToken: '', oauthRefreshToken: '' } : s;
  const headers = await getAuthHeaders(testSettings).catch(() => {
    if (key) return { 'X-Api-Key': key };
    throw new Error('Not authenticated.');
  });

  const r = await fetch(`${baseUrl}/v1/auth/me`, { headers });
  if (r.status === 401) throw new Error('401 — credentials invalid or inactive.');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (!data.can_anonymize) throw new Error(`Role "${data.role}" cannot anonymize.`);
  chrome.storage.sync.set({ piiKeyRole: data.role ?? 'service' });
  return data;
}

// ── Context types ─────────────────────────────────────────────────────────────

async function handleGetContextTypes({ url, key }) {
  const s = await getSettings();
  const baseUrl = (url || s.piiApiUrl || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('Not configured.');

  const testSettings = key ? { ...s, piiApiKey: key, oauthAccessToken: '', oauthRefreshToken: '' } : s;
  const headers = await getAuthHeaders(testSettings);

  const r = await fetch(`${baseUrl}/v1/admin/context-types`, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : (data.data ?? []);
}

async function handleGetDomainPolicies({ url, key }) {
  const s = await getSettings();
  const baseUrl = (url || s.piiApiUrl || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('Not configured.');

  const testSettings = key ? { ...s, piiApiKey: key, oauthAccessToken: '', oauthRefreshToken: '' } : s;
  const headers = await getAuthHeaders(testSettings);

  const r = await fetch(`${baseUrl}/v1/admin/domain-policies`, { headers });
  console.log('[Pseudora] GET domain-policies', baseUrl, '→ HTTP', r.status, 'auth:', headers.Authorization ? 'Bearer' : (headers['X-Api-Key'] ? 'ApiKey' : 'none'));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : (data.data ?? []);
}

// ── Pseudora Cloud API core ───────────────────────────────────────────────────
// Request and response shapes come from the vendored OpenAPI spec
// (src/generated/pseudora-api.d.ts, regenerated with `npm run generate`).

/** @typedef {import('./generated/pseudora-api').paths} Paths */
/** @typedef {import('./generated/pseudora-api').components['schemas']} Schemas */

const API_TIMEOUT_MS = 30_000;
/** OCR runs twice (analysis, then redaction); the Cloud gives each pass up to 110 s. */
const IMAGE_TIMEOUT_MS = 150_000;
const IMAGE_FORMATS = ['png', 'jpeg', 'webp'];

/**
 * Why: one place for the timeout of every POST to the Cloud, so a hung request
 *      rejects (fail closed) instead of waiting forever.
 * What: POSTs `init` to `${baseUrl}${path}`; a timeout rejects with a user-facing error.
 * Test: tests/api-core.mjs asserts the path, body, signal and timeout message.
 */
async function post(baseUrl, path, init, timeoutMs = API_TIMEOUT_MS) {
  try {
    return await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST', ...init, signal: globalThis.AbortSignal?.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw Object.assign(new Error('Pseudora did not respond in time. Nothing was sent.'), { responseCode: 'timeout' });
    throw err;
  }
}

/**
 * What: JSON POST typed against the OpenAPI contract (see post()).
 * @template {keyof Paths} P
 * @param {string} baseUrl
 * @param {P} path
 * @param {Record<string, string>} headers
 * @param {Paths[P] extends { post: { requestBody?: { content: { 'application/json': infer B } } } } ? B : never} body
 */
function postJson(baseUrl, path, headers, body) {
  return post(baseUrl, path, { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

// ── Image redaction ───────────────────────────────────────────────────────────

/**
 * Why: images pasted into a chatbot must be redacted by the Cloud before upload;
 *      only a reply the Cloud marked safe may reach the content script.
 * What: uploads the base64 image to /v1/images/redact as multipart with the user's document
 *       type (`domain`) and face style from storage.sync (one place for paste guard, popup and
 *       shortcut screenshots); asks for JSON and returns it only when it is a 200 with
 *       safe: true, a supported format, intact image bytes and sane counts; any HTTP error,
 *       timeout or malformed reply rejects with a `responseCode` (fail closed).
 * Test: tests/image-background.mjs (multipart fields, Accept, fail-closed shapes).
 * @param {{ data: string, format: string }} msg
 */
async function handleRedactImage({ data, format }) {
  const s = await getSettings();
  if (!s.piiApiUrl) throw Object.assign(new Error('API URL not configured.'), { responseCode: 'not_configured' });
  if (typeof data !== 'string' || !data || !IMAGE_FORMATS.includes(format)) {
    throw Object.assign(new Error('Unsupported image.'), { responseCode: 'image_unsupported' });
  }
  const headers = await getAuthHeaders(s).catch(() => {
    throw Object.assign(new Error('Not authenticated.'), { responseCode: 'not_configured' });
  });
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: `image/${format}` }), `image.${format === 'jpeg' ? 'jpg' : format}`);
  if (OPTION_VALUE.test(s.imageDomain)) form.append('domain', s.imageDomain);
  form.append('face_style', FACE_STYLES.includes(s.faceStyle) ? s.faceStyle : FACE_STYLES[0]);

  // The Cloud negotiates on Accept: without it the reply is raw image bytes, which this JSON parser refuses.
  const r = await post(s.piiApiUrl, '/v1/images/redact', { headers: { ...headers, Accept: 'application/json' }, body: form }, IMAGE_TIMEOUT_MS);
  if (!r.ok) {
    /** @type {{ error?: unknown, message?: string } | null} */
    const err = await r.json().catch(() => null);
    const code = typeof err?.error === 'string' ? err.error : (r.status === 401 ? 'not_configured' : r.status === 404 ? 'unavailable' : 'failed');
    throw Object.assign(new Error(err?.message || `Pseudora: HTTP ${r.status}`), { responseCode: code });
  }
  const contentType = (r.headers.get('content-type') || '').toLowerCase().split(';')[0];
  const result = contentType === 'application/json' ? await r.json().catch(() => null) : null;
  const out = result?.format;
  let protectedBytes;
  try {
    const protectedData = result?.image_base64;
    if (typeof protectedData !== 'string' || protectedData.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(protectedData)) throw new Error('bad base64');
    const decoded = atob(protectedData);
    protectedBytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  } catch {
    protectedBytes = new Uint8Array();
  }
  if (r.status !== 200 || result?.safe !== true || !IMAGE_FORMATS.includes(out) || !hasSignature(protectedBytes, out)
      || !Number.isSafeInteger(result?.entity_count) || result.entity_count < 0
      || typeof result?.type_counts !== 'object' || result.type_counts === null || Array.isArray(result.type_counts)) {
    throw Object.assign(new Error('Pseudora could not confirm safe processing. Nothing was sent.'), { responseCode: 'failed' });
  }
  const types = Object.keys(result.type_counts);
  if (!types.every(type => Number.isSafeInteger(result.type_counts[type]) && result.type_counts[type] >= 0)) {
    throw Object.assign(new Error('Pseudora returned invalid counts.'), { responseCode: 'failed' });
  }
  return {
    safe: true, format: out, image_base64: result.image_base64,
    entity_count: result.entity_count, review_regions: Number.isSafeInteger(result.review_regions) ? result.review_regions : 0,
    types,
  };
}

/** Face styles the Cloud accepts, the default (irreversible blur) first. */
const FACE_STYLES = ['blur', 'pixelate', 'black'];
/** A Cloud preset id: anything else is never sent nor shown. */
const OPTION_VALUE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Why: the popup's "Tipo documento" list must match what /v1/images/redact accepts.
 * What: GET /v1/images/options → { domains: [{ value, label }] } with the Italian label;
 *       entries with a malformed value are dropped; any error rejects (popup keeps "Generico").
 * Test: tests/image-background.mjs handleImageOptions cases.
 */
async function handleImageOptions() {
  const s = await getSettings();
  if (!s.piiApiUrl) throw Object.assign(new Error('API URL not configured.'), { responseCode: 'not_configured' });
  const r = await fetch(`${s.piiApiUrl.replace(/\/$/, '')}/v1/images/options`, {
    headers: { ...(await getAuthHeaders(s)), Accept: 'application/json' }, signal: globalThis.AbortSignal?.timeout(API_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Image options unavailable (HTTP ${r.status}).`);
  const body = await r.json();
  const domains = (Array.isArray(body?.domains) ? body.domains : [])
    .map(d => ({ value: d?.value, label: d?.labels?.it || d?.label }))
    .filter(d => typeof d.value === 'string' && OPTION_VALUE.test(d.value) && typeof d.label === 'string' && d.label);
  if (body?.mode !== 'redact' || !domains.length) throw new Error('Invalid image options.');
  return { mode: 'redact', domains };
}

// ── Protected screenshot ──────────────────────────────────────────────────────

/** Injected on demand (activeTab) where the manifest content scripts do not run. */
const SCREENSHOT_SCRIPTS = { PseudoraComposer: 'src/composer.js', PseudoraImageGuard: 'src/image-guard.js', PseudoraScreenshot: 'src/screenshot.js' };

/**
 * Why: "Screenshot protetto" (popup button or Alt+Shift+S) must work on any tab with only
 *      activeTab: no <all_urls>, no desktopCapture, nothing captured without a user gesture.
 * What: refuses early when Pseudora has no URL/credentials, otherwise captures the visible
 *       tab as PNG and hands it to src/screenshot.js (injected if missing) for the area
 *       selection. The capture is never stored: it lives only in this call and the message.
 * Test: tests/screenshot.mjs (capture + inject order, not_configured skips the capture,
 *       not_capturable on chrome:// pages).
 * @param {number} tabId
 * @param {number} windowId
 */
async function startScreenshot(tabId, windowId) {
  const s = await getSettings();
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId }, func: names => names.filter(n => !(n in globalThis)), args: [Object.keys(SCREENSHOT_SCRIPTS)],
    });
    const missing = /** @type {string[]} */ (probe?.result ?? Object.keys(SCREENSHOT_SCRIPTS));
    if (missing.length) await chrome.scripting.executeScript({ target: { tabId }, files: missing.map(n => SCREENSHOT_SCRIPTS[n]) });
  } catch {
    throw Object.assign(new Error('Pseudora non può catturare questa pagina (pagine di Chrome, Web Store, PDF).'), { responseCode: 'not_capturable' });
  }
  if (!s.piiApiUrl || !(s.oauthAccessToken || s.oauthRefreshToken || s.piiApiKey)) {
    await chrome.tabs.sendMessage(tabId, { type: 'SCREENSHOT_START', error: 'not_configured' });
    return { ok: false, responseCode: 'not_configured' };
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }).catch(() => {
    throw Object.assign(new Error('Pseudora non è riuscita a catturare la scheda.'), { responseCode: 'capture_failed' });
  });
  await chrome.tabs.sendMessage(tabId, { type: 'SCREENSHOT_START', dataUrl });
  return { ok: true };
}

/** Keyboard-shortcut failures have no popup to show them: a red "!" badge with the reason as tooltip. */
function flagError(tabId, message) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
  chrome.action.setBadgeText({ tabId, text: '!' });
  chrome.action.setTitle({ tabId, title: `Pseudora: ${message}` });
  setTimeout(() => { chrome.action.setBadgeText({ tabId, text: '' }); chrome.action.setTitle({ tabId, title: 'Pseudora' }); }, 8000);
}

/** Magic bytes of a complete PNG (with IEND), JPEG (with EOI) or WebP: a truncated or foreign body is refused. */
function hasSignature(b, format) {
  const at = (/** @type {number[]} */ sig, off = 0) => sig.every((v, i) => b[off + i] === v);
  if (format === 'png') return b.length > 20 && at([0x89, 0x50, 0x4e, 0x47]) && at([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], b.length - 8);
  if (format === 'jpeg') return b.length > 4 && at([0xff, 0xd8]) && at([0xff, 0xd9], b.length - 2);
  return b.length > 12 && at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8);
}

// ── Anonymize / deanonymize ───────────────────────────────────────────────────

async function handleAnonymize({ text, contextId, language, mode, contextType }) {
  const s = await getSettings();
  if (!s.piiApiUrl) throw new Error('API URL not configured — open the extension popup.');

  const tokenId = contextId || crypto.randomUUID();
  const headers = await getAuthHeaders(s);

  // A "domain:<slug>" selection invokes a domain policy directly (no context_type).
  // For domain calls we leave `mode` unset unless the user picked one, so the
  // policy's own default_mode applies.
  const selected = contextType || s.contextType || 'generic';
  const isDomain = selected.startsWith('domain:');
  const chosenMode = mode || s.mode || '';

  /** @type {Schemas['AnonymizeRequest']} */
  const payload = {
    text,
    context_id:            tokenId,
    language:              language || s.language || 'it',
    include_entity_values: s.piiKeyRole === 'admin',
  };
  if (isDomain) {
    payload.domain = selected.slice('domain:'.length);
    if (chosenMode) payload.mode = chosenMode;
  } else {
    payload.context_type = selected;
    payload.mode = chosenMode || 'tag';
  }

  const r = await postJson(s.piiApiUrl, '/v1/anonymize', headers, payload);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = body.error;
    // New boundary contract: error is an object { response_code, message, meta }.
    if (err && typeof err === 'object' && err.message) {
      throw Object.assign(new Error(err.message), {
        responseCode: err.response_code || '',
        meta: err.meta || {},
      });
    }
    // Legacy string-error shapes (auth/validation handlers).
    if (r.status === 401) throw new Error(`401 — ${err ?? 'unauthorized'}`);
    if (r.status === 403) throw new Error(`403 — ${err ?? 'forbidden'}`);
    throw new Error(`Pseudora: HTTP ${r.status}`);
  }
  /** @type {Partial<Schemas['AnonymizeResponse']> | null} */
  const data = await r.json();
  if (data?.safe !== true || typeof data.anonymized_text !== 'string') {
    throw new Error('Pseudora could not confirm safe processing. Nothing was sent.');
  }
  await chrome.storage.local.set({ lastOperation: { token_id: tokenId, type: 'anonymize', feedback_sent: false } });
  return data;
}

async function handleDeanonymize({ text, contextId, contextType }) {
  const s = await getSettings();
  if (!s.piiApiUrl) throw new Error('Not configured — open the extension popup.');

  const tokenId = contextId || crypto.randomUUID();
  const headers = await getAuthHeaders(s);
  // Mappings are stored under the anonymize context: for a "domain:<slug>"
  // selection that's the domain slug, so deanonymize must reuse it (sending
  // "generic" would miss the mappings and skip the restore).
  let ctForDeanon = contextType || s.contextType || 'generic';
  if (ctForDeanon.startsWith('domain:')) ctForDeanon = ctForDeanon.slice('domain:'.length);
  const r = await postJson(s.piiApiUrl, '/v1/deanonymize', headers,
    { text, context_id: tokenId, context_type: ctForDeanon });
  if (r.status === 401) throw new Error('401 — credentials invalid or expired. Please re-login.');
  if (r.status === 403) throw new Error('403 — access denied.');
  if (!r.ok) throw new Error(`Pseudora: HTTP ${r.status}`);
  /** @type {Partial<Schemas['DeanonymizeResponse']> | null} */
  const data = await r.json();
  if (typeof data?.restored_text !== 'string') throw new Error('Pseudora returned no restored text.');
  await chrome.storage.local.set({ lastOperation: { token_id: tokenId, type: 'deanonymize', feedback_sent: false } });
  return data;
}

/** @typedef {{ token_id: string, type: Schemas['FeedbackRequest']['type'], feedback_sent: boolean }} LastOperation */

/** @returns {Promise<LastOperation | null>} */
async function getLastOperation() {
  const { lastOperation } = /** @type {{ lastOperation?: LastOperation }} */ (
    await chrome.storage.local.get('lastOperation'));
  return lastOperation ?? null;
}

async function handleSubmitFeedback({ positive }) {
  const op = await getLastOperation();
  if (!op || op.feedback_sent) return { ok: false, reason: 'no_pending_operation' };

  const s = await getSettings();
  if (!s.piiApiUrl) throw new Error('API URL not configured.');

  const headers = await getAuthHeaders(s);
  const r = await postJson(s.piiApiUrl, '/v1/feedback', headers, { token_id: op.token_id, type: op.type, positive });

  if (!r.ok) throw new Error(`Feedback error: HTTP ${r.status}`);
  await chrome.storage.local.set({ lastOperation: { ...op, feedback_sent: true } });
  return { ok: true };
}
