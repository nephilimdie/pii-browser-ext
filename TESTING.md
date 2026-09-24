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
6. Disable interception and confirm the extension does not alter send actions.

Record browser, provider, extension version, team, context type, mode and the
result in the release evidence document. DOM injection is best effort and does
not constitute native API interception.
