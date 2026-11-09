# Changelog

## [1.3.0] - 2026-11-09

### Added
- Italian-first interface through `chrome.i18n` (`_locales/it` is the default, `_locales/en` for English browsers): popup, page panel, image panel, screenshot overlay, OAuth page and the store name/description; entity types read "Persona", "Codice fiscale", "IBAN"…
- Keyboard shortcuts: Alt+Shift+A anonymizes the message (or opens the panel), Alt+Shift+R restores the original, next to Alt+Shift+S for the protected screenshot; all listed in the popup's Guida tab and in the panel
- The page button is now a status indicator ("Protetto · Studio Ferri", "Pseudora · invio libero", "Pseudora · accedi") with a full accessible name
- Image previews are full width, open a zoomed view on click and outline the doubtful areas (only their boxes come from the Cloud; the unpainted review layer never leaves the service worker)
- Screenshot overlay: Enter or the "Tutta l'area visibile" button captures the whole visible area without a mouse
- Errors explain themselves: a team policy block is an amber notice naming the blocked data, an outage offers "Riprova", an expired login "Accedi di nuovo"; all in a `role="alert"` region, all saying that nothing was sent

### Changed
- Every popup setting saves as soon as you change it ("Salvato" appears next to it); Save/Verifica remain only for the connection
- One "Tipo documento" for text and images (engine presets plus your team's policies) instead of three disagreeing pickers; shown in the panel header and in the button's accessible name
- One Pseudora panel for text and images: same header, buttons, position and dark theme (the theme follows the site), anchored above the page button so it never covers it, also in a 420px window
- The popup opens on protection status; first run shows one "Accedi con Pseudora" button with pseudora.cloud prefilled; server address, API key, OAuth client ID and reset sit under "Avanzate"
- Visual language aligned with pseudora.cloud (tokens, Inter/IBM Plex Mono stacks, original/tag/surrogate chips); no label below 12px, secondary text at 4.5:1 or more
- "Ripristina originale" is a caution action that says it puts personal data back; the feedback question comes after the actions
- Branded OAuth page with "Riprova" instead of emoji and raw error codes

### Removed
- "Auto-send after anonymization": it was saved but never read
- Dead popup code (`refreshFeedbackUI`, `#feedback-row`, `<v-icon>`), inline styles, debug logging

### Fixed
- A saved team policy (for example "Studio legale") was reset to "Generic" in the popup and in the page panel because the list was rebuilt from the not-yet-populated select (race); restore now reads the mappings of the document type actually used
- Preferences changed in the popup were lost unless Save was pressed in another tab
- After a screenshot two notifications appeared at once; now only the screenshot message does
- The image panel covered the page button

### Security
- Fail-closed paths unchanged (send guard, composer write check, image validation); no new permissions and no remote code. Settings from 1.2.x are migrated (`contextType`/`imageDomain` → `docType`, `autoSend` removed)

### Italiano
- Interfaccia tutta in italiano (inglese per i browser in inglese), etichette dei dati in italiano
- Le impostazioni del popup si salvano subito ("Salvato"); "Auto-send" rimosso perché non faceva nulla
- Un solo "Tipo documento" per testo e immagini; corretto il ritorno a "Generico" della policy di team
- Il pulsante nella pagina mostra lo stato ("Protetto · Studio Ferri"); un unico pannello per testo e immagini, che non copre più il pulsante e segue il tema scuro del sito
- Errori distinti: blocco della policy (con il dato bloccato), servizio non raggiungibile con "Riprova", accesso scaduto con "Accedi di nuovo"; sempre "Nulla è stato inviato"
- Scorciatoie Alt+Shift+A (anonimizza), Alt+Shift+R (ripristina), Alt+Shift+S (screenshot); anteprima immagini ingrandibile con le aree incerte contornate; screenshot dell'intera area visibile con Invio
- Configurazione self-hosted sotto "Avanzate"; reimpostazione con conferma; pagina di accesso con "Riprova"
- Nessun nuovo permesso

## [1.2.1] - 2026-11-08

### Added
- "Tipo documento" picker in the popup for screenshots and pasted images: the list comes from the Cloud (`GET /v1/images/options`, Italian labels) and falls back to "Generico" when it is unavailable; the choice is sent as `domain` to `POST /v1/images/redact` and stored in your Chrome settings
- "Volti" choice in the popup: Sfocatura (default), Pixel or Nero; sent as `face_style`. Blur and pixel are irreversible (at most 8x8 noisy colour cells of a face remain)

### Changed
- Faces are blurred by default instead of covered with a black box
- Paste guard, popup screenshot and the Alt+Shift+S shortcut all use the same document type and face style
- The redacted image is requested as JSON (`Accept: application/json`), the same reply shape the desktop app uses; the vendored Cloud OpenAPI contract is updated to 1.4.0

### Fixed
- "Screenshot protetto" failed with "could not confirm safe processing" on development builds that parsed JSON without asking the Cloud for it (missing `Accept: application/json`)

### Security
- Fail closed: the image is used only when the Cloud reply is a 200 with `safe: true`, a supported format, a well-formed base64 image with intact signature and valid counts; anything else is refused and the original is never sent
- Stored settings are validated before use: an unknown document type is not sent, an unknown face style falls back to blur
- No new permissions

### Italiano
- Nuovo menu "Tipo documento" nel popup (elenco dal Cloud, ripiega su "Generico") e scelta "Volti": Sfocatura (predefinita), Pixel o Nero
- I volti ora vengono sfocati in modo irreversibile invece che coperti da un riquadro nero
- Corretto "Screenshot protetto" che falliva con "impossibile confermare l'elaborazione sicura"
- Nessun nuovo permesso

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
