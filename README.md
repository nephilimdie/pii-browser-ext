# Pseudora — browser extension

Adds a Pseudora status button next to the message box of ChatGPT, Claude.ai and
Gemini so you can anonymize personal data **before** it leaves the browser. Names, emails, fiscal
codes and IBANs are replaced with placeholders; the model never sees the
originals.

## Install

From the Chrome Web Store, or unpacked for development:

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select this folder

Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
pick `manifest.json`.

## Configure

The interface is in Italian (English in English-language browsers).

Click the extension icon and press **Accedi con Pseudora** (OAuth 2.0 PKCE, no
key to copy around). The server is `https://pseudora.cloud` unless you change it.
Chrome asks once for access to that origin — the extension holds no blanket host
permission, only the three AI sites plus the endpoint you sign in to.

Self-hosting or using a **customer API key** from
[pseudora.cloud/cloud/customer-keys](https://pseudora.cloud/cloud/customer-keys)?
Open **Account → Avanzate**: server address, API key, OAuth client ID,
**Salva**/**Verifica** and a reset (with confirmation) live there.

Every other setting in the popup (**Proteggi l'invio**, **Proteggi anche le
immagini**, **Tipo documento**, **Modalità**, **Volti**, **Lingua del testo**)
is saved the moment you change it.

## Use

1. Type your message in ChatGPT / Claude.ai / Gemini
2. With **Proteggi l'invio** on, just press Enter: the text becomes `[PERSON_1]`,
   `[FISCAL_CODE_1]`, … before it is sent. Otherwise click the Pseudora button
   (or press **Alt+Shift+A**) and **Anonimizza**
3. The panel shows what was replaced, with what, and the type in Italian
4. **Ripristina originale** (or **Alt+Shift+R**) puts the original text back

The button shows the state: "Protetto · <team>" when sends are protected,
"Pseudora · invio libero" when they are not, "Pseudora · accedi" before login.
A send blocked by your team's policy, an outage or an expired login each get
their own message; nothing is sent in any of those cases.

**Etichette reversibili** (`tag`) can be restored; **Dati fittizi**
(`surrogate`) substitutes realistic values. **Tipo documento** is one choice for
text and images: the engine's document presets plus your team's policies.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt+Shift+A (⌥⇧A) | Anonymize the message, or open the panel |
| Alt+Shift+R (⌥⇧R) | Restore the original text |
| Alt+Shift+S (⌥⇧S) | Protected screenshot |

Change them in `chrome://extensions/shortcuts`. The panel closes with Esc and
gives focus back to the page button.

### Screenshot protetto

Click **Screenshot protetto** in the popup or press **Alt+Shift+S** (⌥⇧S on
macOS; change it in `chrome://extensions/shortcuts`). Drag over the area you
want to share — or press Enter / **Tutta l'area visibile** for the whole visible
area — Esc cancels. Pseudora redacts the crop (faces, names, IBANs,
QR codes…) and then:

- on ChatGPT and Claude attaches the protected image to the message box;
- everywhere else (Gemini included) copies it to the clipboard.

Only the redacted copy confirmed by Pseudora is ever used; on any error you get
a message and the original is discarded. The capture is taken only after your
click or shortcut (`activeTab`) and is never stored.

**Tipo documento** and **Volti** (Sfocatura by default, Pixel or Riquadro nero)
apply to screenshots and to pasted images alike. The preview of a pasted image
opens enlarged on click, with doubtful areas outlined.

*Italiano:* premi **Screenshot protetto** o Alt+Shift+S, seleziona l'area,
Pseudora la oscura e la allega a ChatGPT/Claude oppure la copia negli appunti.

## How it is put together

```
core.js        shared pure logic: i18n, document type, error kinds, button status
_locales/      Italian (default) and English messages
tokens.css     design tokens shared by popup, OAuth page and in-page UI
panel.js       the one Pseudora panel (text and images): position, focus, Esc, theme
composer.js    finds each site's prompt field, form and send button (shared selectors)
content.js     injects the status button, reads and writes the prompt field
send-guard.js  decides whether an intercepted send passes, is blocked or is anonymized first
image-guard.js redacts images pasted, dropped or attached in ChatGPT / Claude
screenshot.js  area selection, crop and delivery of the protected screenshot
background.js  the only place that touches the network (avoids CORS)
popup.js       settings (saved on change), OAuth, connection test
```

Credentials live in `chrome.storage.local` and never leave the machine.
Preferences live in `chrome.storage.sync`, so they follow your browser profile.

## Regenerating the API types

The extension talks to the Cloud through `src/background.js`. Request and
response shapes come from the vendored OpenAPI spec `openapi/pseudora-cloud.yaml`
(pinned by `openapi/pseudora-cloud.yaml.sha256`), generated into
`src/generated/pseudora-api.d.ts` with openapi-typescript 7.13.0 and checked
with `tsc --checkJs`. There is no bundler, so only the types are used. The
tooling is dev-only and is not shipped in the store zip.

```bash
npm ci
npm run generate        # rewrite src/generated/ from the spec
npm run generate:check  # CI: spec hash matches and generated output has no diff
npm run typecheck       # JSDoc types in background.js against the schema
npm run lint && npm test
```

To update the contract, copy the new spec from the Cloud repo
(`public/api/v1/openapi.yaml`), refresh the hash with
`shasum -a 256 pseudora-cloud.yaml > pseudora-cloud.yaml.sha256` inside
`openapi/`, run `npm run generate` and commit all three files.

## Limitations

- Toolbar injection is best-effort: an SPA route change may need a page refresh
- Restore works within the session that produced the mapping
- Nothing is intercepted automatically unless you turn on **Proteggi l'invio**
- Screenshots cannot be taken of `chrome://` pages, the Chrome Web Store or the built-in PDF viewer

## Privacy

[Privacy policy](https://pseudora.cloud/extension/privacy) ·
[Permissions](https://pseudora.cloud/extension/permissions) ·
[Data usage](https://pseudora.cloud/extension/data-usage)

## License

MIT
