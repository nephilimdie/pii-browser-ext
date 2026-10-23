# Pseudora — browser extension

Injects a Pseudora toolbar into ChatGPT, Claude.ai and Gemini so you can
anonymize personal data **before** it leaves the browser. Names, emails, fiscal
codes and IBANs are replaced with placeholders; the model never sees the
originals.

## Install

From the Chrome Web Store, or unpacked for development:

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select this folder

Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
pick `manifest.json`.

## Configure

Click the extension icon, then either:

- **Log in with Pseudora** — OAuth 2.0 PKCE, no key to copy around; or
- paste a **customer API key** from
  [pseudora.cloud/cloud/customer-keys](https://pseudora.cloud/cloud/customer-keys)

Set **API URL** to `https://pseudora.cloud`, or to your own instance if you
self-host. Saving asks Chrome for access to that origin — the extension holds no
blanket host permission, only the three AI sites plus the endpoint you name.

**Test connection** confirms the setup.

## Use

1. Type your message in ChatGPT / Claude.ai / Gemini
2. Click **Anonymize** — the text becomes `[PERSON_1]`, `[FISCAL_CODE_1]`, …
3. Send it
4. Paste the reply back and click **Restore** to recover the real values

`tag` mode is reversible; `surrogate` mode substitutes realistic fakes instead.

## How it is put together

```
content.js     injects the toolbar, reads and writes the prompt field
send-guard.js  decides whether an intercepted send passes, is blocked or is anonymized first
background.js  the only place that touches the network (avoids CORS)
popup.js       settings, OAuth, connection test
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
- Nothing is intercepted automatically — you click before sending

## Privacy

[Privacy policy](https://pseudora.cloud/extension/privacy) ·
[Permissions](https://pseudora.cloud/extension/permissions) ·
[Data usage](https://pseudora.cloud/extension/data-usage)

## License

MIT
