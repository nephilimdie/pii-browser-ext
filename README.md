# pii-browser-ext

Chrome/Firefox extension that injects a PII Protect toolbar into ChatGPT, Claude.ai and Gemini.
Anonymizes your text before it leaves the browser — no PII reaches the LLM.

## Features

- 🔒 **Anonymize** button: replaces PII with safe placeholders before sending
- 🔓 **Restore** button: de-anonymizes using the session context_id
- Works on: **ChatGPT** · **Claude.ai** · **Gemini**
- Supports tag mode (reversible) and surrogate mode (realistic fakes)
- Settings popup: configure API URL, API key, language, mode

## Installation (Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `pii-browser-ext` folder

## Installation (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `manifest.json`

## Configuration

Click the extension icon → fill in:
- **API URL**: `http://localhost:15500` (or your remote pii-protect instance)
- **API Key**: your pii-protect admin/service key
- **Language**: document language for detection
- **Mode**: `tag` (reversible) or `surrogate` (realistic fakes)

Click **Test connection** to verify.

## How to use

1. Open ChatGPT / Claude.ai / Gemini
2. Type your message in the prompt box
3. Click **Anonymize** — PII is replaced with `[PERSON_1]`, `[FISCAL_CODE_1]`, etc.
4. Send the anonymized message to the LLM
5. Copy the LLM response, paste it back, click **Restore** if needed

## Architecture

```
content.js     — injects toolbar, reads/writes the textarea
background.js  — makes fetch() calls to pii-protect (avoids CORS)
popup.js       — settings UI, connection test
```

The extension requires pii-protect to be running and reachable from the browser.
For production use, deploy pii-protect behind HTTPS.

## Limitations

- The toolbar injection is best-effort: SPA route changes may require a page refresh
- Restore only works within the same browser session (context_id is in memory)
- Does not intercept API calls directly — relies on manual click before sending
