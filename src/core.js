/**
 * Shared, DOM-free logic used by every extension context (service worker, popup,
 * content scripts, OAuth page). Kept pure so tests/core.mjs runs it in Node.
 * Loaded first everywhere; exposes `globalThis.PseudoraCore`.
 */
(function () {
  'use strict';
  if (globalThis.PseudoraCore) return;            // injected again by a screenshot

  /**
   * Why: one translation entry point with named substitutions that survive reordering.
   * What: chrome.i18n message for `key` with `{name}` placeholders filled; the key itself
   *       when the message is missing, so a gap is visible instead of blank.
   * Test: tests/core.mjs, t('toolbarProtectedTeam', { team: 'X' }) contains X.
   */
  function t(key, subs) {
    let msg = '';
    try { msg = globalThis.chrome?.i18n?.getMessage(key) || ''; } catch (_) {}
    if (!msg) return key;
    return subs ? msg.replace(/\{(\w+)\}/g, (m, k) => (k in subs ? String(subs[k]) : m)) : msg;
  }

  /** Fills [data-i18n], [data-i18n-aria], [data-i18n-title] and [data-i18n-placeholder] under `root`. */
  function apply(root) {
    root.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
    for (const [attr, prop] of [['i18nAria', 'aria-label'], ['i18nTitle', 'title'], ['i18nPlaceholder', 'placeholder']]) {
      root.querySelectorAll(`[data-${attr.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}]`).forEach(n => n.setAttribute(prop, t(n.dataset[attr])));
    }
  }

  /* ── Document type ──────────────────────────────────────────────────────────
     One "Tipo documento" for text and images. Values are engine domain presets
     (the list /v1/images/options returns) or "domain:<slug>" for a team policy. */
  const DEFAULT_DOC_TYPE = 'generic_professional';
  const IMAGE_DOMAINS = ['generic_professional', 'contract_analysis', 'hr_payroll', 'tax_accounting', 'real_estate_insurance', 'fine_appeal', 'condominio'];
  const LEGACY_CONTEXT = { fine_appeal: 'fine_appeal', contract: 'contract_analysis' };
  const DOC_VALUE = /^(domain:)?[a-z][a-z0-9_-]{0,63}$/;

  /**
   * Why: 1.2.x kept a text "contextType" and an image "imageDomain" that disagreed.
   * What: storage patch { docType } (+ keys to remove) from old settings; null when nothing to do.
   *       A team policy ("domain:x") and a known context type win; otherwise the image choice.
   * Test: tests/core.mjs, { contextType: 'domain:legal_it' } → docType 'domain:legal_it'.
   */
  function migrate(sync) {
    const remove = ['contextType', 'imageDomain', 'autoSend'].filter(k => k in sync);
    if (!remove.length) return null;
    let docType = sync.docType;
    if (!docType) {
      const ct = String(sync.contextType || '');
      if (ct.startsWith('domain:')) docType = IMAGE_DOMAINS.includes(ct.slice(7)) ? ct.slice(7) : ct;
      else docType = LEGACY_CONTEXT[ct] || (IMAGE_DOMAINS.includes(sync.imageDomain) ? sync.imageDomain : DEFAULT_DOC_TYPE);
    }
    return { set: { docType: DOC_VALUE.test(docType) ? docType : DEFAULT_DOC_TYPE }, remove };
  }

  /**
   * Why: the Cloud takes `context_type` or `domain` for text and only presets for images.
   * What: { text: { context_type } | { domain }, image: preset, deanonContext } for a docType.
   *       "Generico" keeps the long-standing text default (context_type generic).
   * Test: tests/core.mjs, 'domain:legal_it' → text.domain legal_it, image generic_professional.
   */
  function requestFor(docType) {
    const value = DOC_VALUE.test(docType || '') ? docType : DEFAULT_DOC_TYPE;
    const slug = value.startsWith('domain:') ? value.slice(7) : value;
    const generic = slug === DEFAULT_DOC_TYPE;
    return {
      text: generic ? { context_type: 'generic' } : { domain: slug },
      image: IMAGE_DOMAINS.includes(slug) ? slug : DEFAULT_DOC_TYPE,
      deanonContext: generic ? 'generic' : slug,
    };
  }

  /**
   * Why: the saved choice must survive the options arriving late (1.2.x reset it to Generic).
   * What: option groups [{ label, options: [{ value, label }] }] with `saved` always present
   *       (as "slug (non disponibile)" when the Cloud no longer lists it) and marked selected.
   * Test: tests/core.mjs, saved 'domain:gone' stays selected with an unavailable label.
   */
  function docOptions({ presets = [], policies = [] }, saved) {
    const presetList = presets.length ? presets : IMAGE_DOMAINS.map(v => ({ value: v, label: t(`doc_${v}`) }));
    const known = new Set(presetList.map(p => p.value));
    const team = policies.filter(p => p?.domain && !known.has(p.domain))
      .map(p => ({ value: `domain:${p.domain}`, label: p.display_name || p.domain }));
    const groups = [{ label: t('docGroupPresets'), options: presetList }];
    if (team.length) groups.push({ label: t('docGroupTeam'), options: team });
    const value = saved || DEFAULT_DOC_TYPE;
    if (!groups.some(g => g.options.some(o => o.value === value))) {
      groups.push({ label: t('docGroupOther'), options: [{ value, label: t('docUnavailable', { name: value.replace(/^domain:/, '') }) }] });
    }
    return { groups, selected: value };
  }

  /** Label of `value` inside docOptions() groups (falls back to the slug). */
  function docLabel(groups, value) {
    for (const g of groups) for (const o of g.options) if (o.value === value) return o.label;
    return String(value || '').replace(/^domain:/, '');
  }

  /** Italian (or English) name of an entity type; unknown types read as words, never as CODES. */
  function entityLabel(type) {
    const key = `entity_${String(type || '').toUpperCase()}`;
    const msg = t(key);
    return msg === key ? String(type || '').toLowerCase().replace(/_/g, ' ') : msg;
  }

  /* ── Errors ─────────────────────────────────────────────────────────────── */
  const KINDS = {
    policy_blocked: { tone: 'policy', action: null },
    auth: { tone: 'error', action: 'login' },
    not_configured: { tone: 'error', action: 'login' },
    server: { tone: 'error', action: 'retry' },
    timeout: { tone: 'error', action: 'retry' },
    network: { tone: 'error', action: 'retry' },
    rate_limited: { tone: 'error', action: 'retry' },
    quota: { tone: 'error', action: null },
    unsafe: { tone: 'error', action: 'retry' },
    editor_write_failed: { tone: 'error', action: null },
    reloaded: { tone: 'error', action: null },
    failed: { tone: 'error', action: 'retry' },
  };

  /**
   * Why: a policy block is the product working, a 500 is an outage, a 401 needs a login;
   *      1.2.x told the user to "configure the API URL" for all three.
   * What: { kind, tone: 'policy'|'error', action: 'retry'|'login'|null, title, detail } for an
   *       error reply ({ error, responseCode, meta }); every detail ends with "nothing was sent".
   * Test: tests/core.mjs maps policy, 5xx, 401, timeout, network and quota replies.
   */
  function describeError(resp) {
    const code = String(resp?.responseCode || '').toLowerCase();
    const text = String(resp?.error || '');
    let kind = 'failed';
    if (/block/.test(code)) kind = 'policy_blocked';
    else if (['auth', 'unauthorized', 'forbidden', 'unauthenticated'].includes(code)) kind = 'auth';
    else if (code === 'not_configured') kind = 'not_configured';
    else if (['server', 'engine_error', 'unavailable', 'busy', 'bad_gateway'].includes(code)) kind = 'server';
    else if (code === 'timeout') kind = 'timeout';
    else if (code === 'network') kind = 'network';
    else if (['rate_limited', 'rate_limit_exceeded', 'in_progress'].includes(code)) kind = 'rate_limited';
    else if (['quota', 'monthly_quota_exceeded', 'credits_exhausted', 'quota_exceeded'].includes(code)) kind = 'quota';
    else if (KINDS[code]) kind = code;
    else if (/extension (context invalidated|reloaded)|receiving end/i.test(text)) kind = 'reloaded';
    const types = Array.isArray(resp?.meta?.blocked_types) ? resp.meta.blocked_types.map(entityLabel) : [];
    const detail = kind === 'policy_blocked' && types.length
      ? t('errDetail_policy_types', { types: types.join(', ') })
      : t(`errDetail_${kind}`);
    return { kind, ...KINDS[kind], title: t(`errTitle_${kind}`), detail };
  }

  /* ── Toolbar status ─────────────────────────────────────────────────────── */
  /**
   * Why: the in-page button is the only always-visible sign of protection ("PII" said nothing).
   * What: { state: 'setup'|'on'|'off', label, aria } from the extension status.
   * Test: tests/core.mjs, intercept on with a team → "Protetto · <team>".
   */
  function toolbarStatus({ configured, interceptSend, teamName, docLabel: doc }) {
    if (!configured) return { state: 'setup', label: t('toolbarSetup'), aria: t('toolbarSetupAria') };
    if (!interceptSend) return { state: 'off', label: t('toolbarOff'), aria: t('toolbarOffAria', { doc: doc || '' }) };
    return {
      state: 'on',
      label: teamName ? t('toolbarProtectedTeam', { team: teamName }) : t('toolbarProtected'),
      aria: t('toolbarOnAria', { team: teamName || '—', doc: doc || '' }),
    };
  }

  globalThis.PseudoraCore = Object.freeze({
    t, apply, migrate, requestFor, docOptions, docLabel, entityLabel, describeError, toolbarStatus,
    DEFAULT_DOC_TYPE, IMAGE_DOMAINS,
  });
})();
