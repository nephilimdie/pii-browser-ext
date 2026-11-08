# Changelog

## [1.2.0] - 2026-11-08

### Added
- "Screenshot protetto": a button in the popup and a keyboard shortcut (Alt+Shift+S, ⌥⇧S on macOS; change it in `chrome://extensions/shortcuts`) capture the visible tab, let you drag over the area to share (Esc cancels) and redact it through Pseudora (`POST /v1/images/redact`) before it is used
- On ChatGPT and Claude the protected screenshot is attached to the message box; on Gemini and every other site it is copied to the clipboard ("Screenshot protetto copiato negli appunti") with what was hidden ("4 elementi: nomi, email, …")

### Fixed
- With Intercept send on, a send blocked because anonymization failed now opens the Pseudora panel with the reason instead of leaving Enter silently doing nothing

### Security
- Fail closed: only a Cloud-confirmed redacted image is attached or copied; on any error (not logged in, credits, network, timeout) a message is shown and the original is never used. The capture lives only in memory, is never stored and is dropped once the area is cropped
- The selection overlay runs in a closed shadow root, so the page's own scripts cannot read the capture
- New permissions `activeTab` and `scripting` show no install warning: the tab is captured only right after your click or shortcut, and no access to all websites is requested

### Italiano
- "Screenshot protetto": pulsante nel popup e scorciatoia Alt+Shift+S (⌥⇧S su macOS, modificabile in `chrome://extensions/shortcuts`). Selezioni l'area con il mouse (Esc annulla), Pseudora la oscura e su ChatGPT/Claude la allega al messaggio; altrove la copia negli appunti
- Fail-closed: si usa solo la copia oscurata confermata dal Cloud; in caso di errore compare un messaggio e l'originale non viene mai usato né salvato
- Intercetta invio: se l'anonimizzazione fallisce, si apre il pannello Pseudora con il motivo

## [1.1.1] - 2026-11-08

### Fixed
- ChatGPT: the Pseudora toolbar did not appear on the current chatgpt.com composer (a plain `textarea[name="prompt"]` replaced `#prompt-textarea`), so prompts and images could not be protected; the localized send button (`data-composer-submit`) is now recognised too
- The toolbar and the send/image guards follow the editor when the site re-renders it (home ↔ conversation) instead of holding on to the old one
- The toolbar sits above the composer when there is no room beside it, and next to Gemini's whole input pill instead of over its buttons

### Changed
- Composer selectors live in one shared module (`src/composer.js`) used by both the text and the image guard

### Italiano
- ChatGPT: la barra Pseudora non compariva più con il nuovo campo di testo di chatgpt.com; ora viene rilevato, anche dopo il passaggio tra home e conversazione
- La barra si posiziona sopra il campo quando manca spazio a destra; su Gemini non copre più i pulsanti

## [1.1.0] - 2026-11-01

### Added
- Image protection on ChatGPT and Claude ("Proteggi anche le immagini", on by default, active with Intercept send): pasted, dropped or attached PNG/JPEG/WebP images are redacted by Pseudora (`POST /v1/images/redact`: text, faces, QR/barcodes, plates) before the site can upload them
- Review panel with the redacted preview and what was hidden; "Usa immagine protetta" attaches the protected copy, "Annulla" discards it
- If the site does not accept the protected copy, the panel offers it as a download

### Security
- Fail closed: the original image is swallowed in the capture phase and never uploaded; only a 200 `image/*` reply with `X-Pii-Redacted: true` and intact image bytes is used, every error or timeout (150 s) shows a message instead
- HEIC/HEIF and other formats are refused with a hint, without any network call

### Italiano
- Protezione immagini su ChatGPT e Claude ("Proteggi anche le immagini", attiva di default insieme a Intercetta invio): le immagini PNG/JPEG/WebP incollate, trascinate o allegate vengono oscurate da Pseudora prima che il sito possa caricarle
- Pannello di revisione con anteprima oscurata e dati nascosti; "Usa immagine protetta" allega la copia protetta, "Annulla" la scarta; se l'allegato non riesce, la copia protetta si può scaricare
- Fail-closed: l'originale non viene mai inviato; qualsiasi errore o timeout mostra un messaggio. Le foto HEIC vanno convertite in JPEG/PNG

## [1.0.2] - 2026-10-24

### Security
- Send interception now fails closed: a second Enter or click while anonymization is running no longer sends the original prompt
- "Anonymize & Send" verifies the editor contains the anonymized text before sending
- Turning "intercept send" on or off now applies immediately to tabs that are already open
- Requests to Pseudora time out after 30 seconds instead of leaving the editor stuck
- Restore responses without a valid `restored_text` are rejected instead of being written into the editor

### Changed
- Cloud calls are typed against the Pseudora OpenAPI contract
- The store package excludes development tooling
