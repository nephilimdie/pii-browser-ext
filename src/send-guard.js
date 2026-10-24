/**
 * Send interception decisions, kept free of DOM access so they can be tested
 * in Node. Loaded before content.js, which reads `globalThis.PseudoraSendGuard`.
 */
(function () {
  'use strict';

  /**
   * Why: the provider's own send must never run with unprotected text while
   *      interception is on, including while an anonymization is in flight.
   * What: returns 'pass' (let the site send), 'block' (swallow the event) or
   *       'anonymize' (swallow it and start anonymize-then-send).
   * Test: tests/send-guard.mjs, the in-flight case must be 'block', not 'pass'.
   */
  function decide({ interceptSend, inFlight, nativeSendAllowed, hasText }) {
    if (!interceptSend || nativeSendAllowed || !hasText) return 'pass';
    return inFlight ? 'block' : 'anonymize';
  }

  /**
   * Why: execCommand-based editor writes can fail silently; a programmatic
   *      send must not fire unless the editor really holds the protected text.
   * What: compares composer text with the expected text, ignoring whitespace
   *       differences the editors introduce.
   * Test: tests/send-guard.mjs, original text in the composer must be false.
   */
  function composerHolds(actual, expected) {
    const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    return typeof expected === 'string' && norm(actual) === norm(expected);
  }

  globalThis.PseudoraSendGuard = Object.freeze({ decide, composerHolds });
})();
