const { t, apply } = globalThis.PseudoraCore;
const params = new URLSearchParams(window.location.search);
const code   = params.get('code');
const state  = params.get('state');
const error  = params.get('error');
const $ = id => document.getElementById(id);

document.body.dataset.piiTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.documentElement.lang = (chrome.i18n?.getUILanguage?.() || 'it').startsWith('it') ? 'it' : 'en';
apply(document);

/** Shows a final state; errors offer [Riprova] (restart the login) and [Chiudi la scheda]. */
function show(kind, title, text) {
  $('card').dataset.state = kind;
  $('title').textContent = title;
  $('msg').textContent = text;
  $('retry').hidden = kind !== 'error';
  $('close').hidden = kind === 'working';
  if (kind === 'error') $('retry').focus();
}

/**
 * Why: a denied or expired login must offer a way back without hunting for the popup.
 * What: restarts OAuth on the saved server and navigates this tab to the authorization page.
 * Test: manual (capture harness oauth-denied screenshot, Riprova button visible).
 */
$('retry').addEventListener('click', () => {
  show('working', t('oauthWorkingTitle'), t('oauthWorkingText'));
  chrome.runtime.sendMessage({ type: 'OPEN_LOGIN_HERE' }, resp => {
    if (resp?.authUrl) window.location.href = resp.authUrl;
    else show('error', t('oauthErrorTitle'), t('oauthRetryFailed'));
  });
});
$('close').addEventListener('click', () => window.close());

if (error) {
  show('error', t(error === 'access_denied' ? 'oauthDeniedTitle' : 'oauthErrorTitle'),
    t(error === 'access_denied' ? 'oauthDeniedText' : 'oauthErrorText'));
} else if (code) {
  chrome.runtime.sendMessage({ type: 'OAUTH_CALLBACK', code, state }, resp => {
    if (!resp || resp.error) {
      show('error', t('oauthErrorTitle'), t('oauthErrorText'));
      return;
    }
    show('ok', resp.name ? t('oauthOkTitleName', { name: resp.name }) : t('oauthOkTitle'), t('oauthOkText'));
    setTimeout(() => window.close(), 1500);
  });
} else {
  show('error', t('oauthErrorTitle'), t('oauthNoCode'));
}
