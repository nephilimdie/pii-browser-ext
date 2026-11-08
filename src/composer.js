/**
 * Why: the chat sites rewrite their composer markup without notice (chatgpt.com
 * moved from #prompt-textarea to a plain textarea[name="prompt"] in Nov 2026 and
 * the toolbar silently disappeared). One ordered list of strategies per site,
 * shared by content.js and image-guard.js, keeps both guards on the same element.
 * What: PseudoraComposer.forHost(hostname) -> { input(doc), root(input), sendButton(doc), images } | null.
 * Test: tests/composer.mjs resolves the captured ChatGPT markup and the legacy ones.
 */
(function () {
  'use strict';

  // Newest markup first; the generic `form` fallbacks come last.
  const SITES = {
    'chatgpt.com': {
      input: [
        '#prompt-textarea',
        '[data-composer-editor-host] [contenteditable="true"]',
        'div[contenteditable="true"][data-lexical-editor]',
        'div.ProseMirror[contenteditable="true"]',
        '[data-composer-editor-host] textarea',
        'textarea[name="prompt"]',
        'textarea[name="prompt-textarea"]',
        'form [contenteditable="true"]',
      ],
      root: 'form',
      send: [
        'button[data-testid="send-button"]',
        'button[data-composer-submit]',
        '#composer-submit-button',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
      ],
      images: true,
    },
    'claude.ai': {
      input: ['fieldset div[contenteditable="true"]', 'div[contenteditable="true"][data-placeholder]', 'div.ProseMirror[contenteditable="true"]'],
      root: 'fieldset, form',
      send: ['button[aria-label="Send Message"]', 'button[data-value="send"]', 'button[aria-label="Send message"]'],
      images: true,
    },
    'gemini.google.com': {
      input: ['rich-textarea div[contenteditable="true"]'],
      root: 'input-area-v2, form',
      send: ['button[aria-label="Send message"]', 'button.send-button'],
      images: false,
    },
  };

  /** Rendered elements win over hidden twins (ChatGPT keeps a hidden textarea next to its editor). */
  const visible = el => typeof el.getClientRects === 'function' && el.getClientRects().length > 0;

  function pick(doc, selectors) {
    let fallback = null;
    for (const sel of selectors) {
      for (const el of doc.querySelectorAll(sel)) {
        if (visible(el)) return el;
        fallback = fallback || el;
      }
    }
    return fallback;
  }

  function forHost(hostname) {
    const key = Object.keys(SITES).find(k => hostname.replace(/^www\./, '').endsWith(k));
    if (!key) return null;
    const s = SITES[key];
    return Object.freeze({
      images: s.images,
      input: doc => pick(doc, s.input),
      root: input => input.closest(s.root) || input.parentElement,
      sendButton: doc => pick(doc, s.send),
    });
  }

  globalThis.PseudoraComposer = Object.freeze({ forHost });
})();
