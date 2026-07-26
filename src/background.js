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

// ── Settings ──────────────────────────────────────────────────────────────────

const SYNC_DEFAULTS = {
  piiApiUrl: '',
  piiApiKey: '',
  piiOauthClientId: '',
  language: 'it',
  mode: 'tag',
  contextType: 'generic',
  autoSend: false,
  interceptSend: false,
  piiKeyRole: 'service',
};

const LOCAL_DEFAULTS = {
  oauthAccessToken: '',
  oauthRefreshToken: '',
  oauthExpiresAt: 0,
  oauthUserName: '',
  oauthUserEmail: '',
  userTeams: [],
  selectedTeamCode: '',
};

async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS),
  ]);
  return { ...sync, ...local };
}

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
  const local = await chrome.storage.local.get(['pkceVerifier', 'pkceState']);
  const sync  = await chrome.storage.sync.get(['piiApiUrl', 'piiOauthClientId']);
  const url   = sync.piiApiUrl;
  const clientId = sync.piiOauthClientId;

  if (!local.pkceVerifier) throw new Error('PKCE verifier missing — restart the login flow.');
  if (state && local.pkceState && state !== local.pkceState) throw new Error('OAuth state mismatch — possible CSRF.');

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
  const local = await chrome.storage.local.get(LOCAL_DEFAULTS);
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
  throw new Error('Not authenticated — login with your PII Protect account or configure an API key.');
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
  console.log('[PII Protect] GET domain-policies', baseUrl, '→ HTTP', r.status, 'auth:', headers.Authorization ? 'Bearer' : (headers['X-Api-Key'] ? 'ApiKey' : 'none'));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : (data.data ?? []);
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

  const r = await fetch(`${s.piiApiUrl.replace(/\/$/, '')}/v1/anonymize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = body.error;
    // New boundary contract: error is an object { response_code, message, meta }.
    if (err && typeof err === 'object' && err.message) {
      const e = new Error(err.message);
      e.responseCode = err.response_code || '';
      e.meta = err.meta || {};
      throw e;
    }
    // Legacy string-error shapes (auth/validation handlers).
    if (r.status === 401) throw new Error(`401 — ${err ?? 'unauthorized'}`);
    if (r.status === 403) throw new Error(`403 — ${err ?? 'forbidden'}`);
    throw new Error(`pii-protect: HTTP ${r.status}`);
  }
  const data = await r.json();
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
  const r = await fetch(`${s.piiApiUrl.replace(/\/$/, '')}/v1/deanonymize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ text, context_id: tokenId, context_type: ctForDeanon }),
  });
  if (r.status === 401) throw new Error('401 — credentials invalid or expired. Please re-login.');
  if (r.status === 403) throw new Error('403 — access denied.');
  if (!r.ok) throw new Error(`pii-protect: HTTP ${r.status}`);
  const data = await r.json();
  await chrome.storage.local.set({ lastOperation: { token_id: tokenId, type: 'deanonymize', feedback_sent: false } });
  return data;
}

async function getLastOperation() {
  const { lastOperation } = await chrome.storage.local.get('lastOperation');
  return lastOperation ?? null;
}

async function handleSubmitFeedback({ positive }) {
  const op = await getLastOperation();
  if (!op || op.feedback_sent) return { ok: false, reason: 'no_pending_operation' };

  const s = await getSettings();
  if (!s.piiApiUrl) throw new Error('API URL not configured.');

  const headers = await getAuthHeaders(s);
  const r = await fetch(`${s.piiApiUrl.replace(/\/$/, '')}/v1/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ token_id: op.token_id, type: op.type, positive }),
  });

  if (!r.ok) throw new Error(`Feedback error: HTTP ${r.status}`);
  await chrome.storage.local.set({ lastOperation: { ...op, feedback_sent: true } });
  return { ok: true };
}
