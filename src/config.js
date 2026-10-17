// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized and checked
// before anything is sent: the issue_token must be a Google iframerpc URL
// (the cookies are sent to it, and nowhere else), the cookies must look like
// a Google cookie header (ha-nest-protect config_flow.py checks).
// -----------------------------------------------------------------------------

import { LIMITS, NEST } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** Cookie names of a signed-in Google session (config_flow.py `_validate_cookies`). */
const GOOGLE_MARKERS = ['APISID=', 'SAPISID=', 'HSID=', 'SSID=', 'SID='];

/** `cookie: a=b; c=d` (copied with its name from the browser) -> `a=b; c=d`. */
const stripCookieName = (value) => value.replace(/^cookie\s*:\s*/i, '');

export function normalizeConfig(raw = {}) {
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    issueToken: String(raw?.issue_token ?? '').trim(),
    cookies: stripCookieName(String(raw?.cookies ?? '').trim()),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

export function validIssueToken(value) {
  if (typeof value !== 'string' || value.length > LIMITS.issueToken || /\s/.test(value)) {
    return false;
  }
  if (!value.startsWith(NEST.issueTokenPrefix) || !value.includes('action=issueToken')) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && url.search !== '';
  } catch {
    return false;
  }
}

export function validCookies(value) {
  return (
    typeof value === 'string' &&
    value.length > 100 &&
    value.length <= LIMITS.cookies &&
    value.includes('=') &&
    !/[\r\n]/.test(value) &&
    GOOGLE_MARKERS.some((marker) => value.includes(marker))
  );
}

/** What stops the integration before any request: undefined when the configuration can be tried. */
export function configProblem(config) {
  if (!config.issueToken || !config.cookies) {
    return 'no_credentials';
  }
  if (!validIssueToken(config.issueToken)) {
    return 'bad_issue_token';
  }
  if (!validCookies(config.cookies)) {
    return 'bad_cookies';
  }
  return undefined;
}
