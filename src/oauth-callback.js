const params = new URLSearchParams(window.location.search);
const code   = params.get('code');
const state  = params.get('state');
const error  = params.get('error');

const icon  = document.getElementById('icon');
const title = document.getElementById('title');
const msg   = document.getElementById('msg');

if (error) {
  icon.textContent  = '❌';
  title.textContent = 'Authorization denied';
  msg.textContent   = error;
} else if (code) {
  chrome.runtime.sendMessage({ type: 'OAUTH_CALLBACK', code, state }, resp => {
    if (resp?.error) {
      icon.textContent  = '❌';
      title.textContent = 'Connection failed';
      msg.classList.add('err');
      msg.textContent = resp.error;
    } else {
      icon.textContent  = '✅';
      title.textContent = `Connected as ${resp?.name || 'user'}`;
      msg.textContent   = 'You can close this tab.';
      setTimeout(() => window.close(), 1500);
    }
  });
} else {
  icon.textContent  = '⚠️';
  title.textContent = 'No authorization code';
  msg.textContent   = 'Something went wrong. Try again from the extension popup.';
}
