import { readFile } from 'node:fs/promises';

// Shared test environment: extension sources and a chrome.i18n stub backed by _locales.
export const src = name => readFile(new URL(`../../src/${name}`, import.meta.url), 'utf8');

/** Parsed _locales/<lang>/messages.json. */
export async function messages(lang = 'it') {
  return JSON.parse(await readFile(new URL(`../../_locales/${lang}/messages.json`, import.meta.url), 'utf8'));
}

/** chrome.i18n stand-in: getMessage(key) like Chrome (no substitutions, '' when missing). */
export async function i18n(lang = 'it') {
  const m = await messages(lang);
  return { getMessage: key => m[key]?.message ?? '', getUILanguage: () => lang };
}
