# Browser extension verification

Run these checks against a local or staging Pseudora instance. Never use a
production API key in a development browser profile.

## Authentication and storage

1. Load the unpacked extension in Chrome and Firefox.
2. Configure the API URL and complete OAuth PKCE login.
3. Confirm the extension reports the account and available teams.
4. Select each team and confirm that context types and modes reload.
5. Inspect extension storage: access and refresh tokens, API keys, PKCE state
   and verifier must be in `storage.local`; preferences may be in
   `storage.sync`, but no credential may be there.
6. Start a second login and confirm a callback with a missing or altered
   `state` is rejected.
7. Log out and confirm the token, team and PKCE values are cleared.

## Provider sites

Repeat the workflow on ChatGPT, Claude and Gemini:

1. Enter a message containing a name, email, phone and fiscal identifier.
2. Select `tag` and verify the outgoing editor contains placeholders only.
3. Restore the response using the same context.
4. Repeat with `surrogate` and verify the response is coherent but does not
   expose the original values.
5. Verify `Anonymize & Send` shows a loading state and sends only after the
   anonymization request succeeds.
6. With interception on, press Enter twice quickly: only anonymized text may
   reach the provider, and the second press must not send the original.
7. Toggle interception in the popup with a provider tab already open and
   confirm the open tab follows the new setting without a reload.
8. Disable interception and confirm the extension does not alter send actions.

Record browser, provider, extension version, team, context type, mode and the
result in the release evidence document. DOM injection is best effort and does
not constitute native API interception.

## Protezione immagini (1.1.0) — guida di test manuale

Prerequisiti: account Pseudora con crediti, Chrome desktop.

1. Scarica `pii-browser-ext-1.1.0.zip` dalla GitHub Release v1.1.0 ed estrailo in una cartella.
2. Apri `chrome://extensions`, attiva "Modalità sviluppatore", "Carica estensione non pacchettizzata" e scegli la cartella estratta (rimuovi prima eventuali versioni precedenti).
3. Apri il popup, effettua il login, attiva **Intercept send** e verifica che **Proteggi anche le immagini** sia attivo. Salva.
4. Prepara uno screenshot sintetico: un documento con dati finti (es. "Mario Rossi", `mario.rossi@example.com`, IBAN `IT60X0542811101000000123456`) e un codice QR. Non usare dati reali.
5. Su https://chatgpt.com e su https://claude.ai ripeti:
   - **Incolla** lo screenshot (Cmd/Ctrl+V) nel campo messaggio: compare il pannello "Pseudora · immagine" con "Protezione dell'immagine in corso…", poi l'anteprima oscurata e "Oscurati: N elementi: …". Nessun allegato deve comparire nel sito prima della conferma.
   - Premi **Usa immagine protetta**: il sito mostra l'allegato `immagine-protetta-1.png`; aprilo e verifica che nome, email, IBAN e QR siano coperti.
   - Ripeti trascinando il file sul campo (drop) e con il pulsante allegati del sito (selezione file).
   - Premi **Annulla** su un'altra immagine: nessun allegato viene aggiunto.
6. Fail-closed: disattiva la rete (DevTools > Network > Offline) solo dopo aver aperto la pagina, poi incolla: deve comparire un errore con "L'immagine originale non è stata inviata" e nessun allegato.
7. HEIC: incolla/allega un file `.heic`: messaggio "Le foto HEIC non sono supportate", nessun invio.
8. Toggle: disattiva **Proteggi anche le immagini** e salva: l'incolla di un'immagine torna al comportamento normale del sito (nessun pannello).
9. Se l'allegato automatico non riesce, il pannello propone "Scarica immagine-protetta-1.png": scaricala e allegala a mano.
10. In DevTools > Network della pagina (ChatGPT/Claude) verifica che nessuna richiesta di upload parta prima di "Usa immagine protetta".
