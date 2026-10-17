// -----------------------------------------------------------------------------
// The Nest account, read only. Ported from pynest (ha-nest-protect, MIT):
//   1. Google: GET the issue_token URL with the browser cookies -> a Google
//      access token (and sometimes rotated cookies, merged in memory);
//   2. Nest auth proxy: POST issue_jwt with that token -> a JWT;
//   3. GET home.nest.com/session with the JWT -> the Nest session (access
//      token, user id, end date, transport URL);
//   4. POST app_launch -> every bucket of the account;
//   5. POST <transport>/v6/subscribe with the revisions known -> the buckets
//      that changed, when they change (long poll, up to 10 minutes).
// No write call exists here: the integration never commands a detector.
// Every request goes through the transport of src/http.js; no cookie, token
// or URL of the account ever goes into an error message.
// -----------------------------------------------------------------------------

import {
  LIMITS,
  NEST,
  TIMINGS,
  TRUSTED_TRANSPORT_HOSTS,
  USER_AGENT,
  nestUrls,
  BUCKET_TYPES,
} from './constants.js';
import { NestError, httpRequest, transientError, tryJson } from './http.js';

/** A Google or Nest error code, kept only when it cannot carry anything personal. */
const safeCode = (value) =>
  typeof value === 'string' && /^[A-Za-z_]{1,40}$/.test(value) ? value : undefined;

/** The transport URL of a Nest answer, only on a Nest host over HTTPS (it gets the token). */
export function trustedTransport(value) {
  if (typeof value !== 'string' || value.length > 512) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return undefined;
    }
    if (!TRUSTED_TRANSPORT_HOSTS.some((re) => re.test(url.hostname))) {
      return undefined;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * New cookie values (Set-Cookie headers) merged into a cookie header: a new
 * value replaces the old one, the others stay (pynest `merge_cookies`).
 * Bounded; a cookie being deleted (empty value) is not taken.
 */
export function mergeCookies(header, setCookies = []) {
  const jar = new Map();
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  const list = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const line of list.slice(0, LIMITS.cookieCount)) {
    const first = String(line ?? '').split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) {
      continue;
    }
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || value === '' || /[\s;,]/.test(value)) {
      continue;
    }
    if (!jar.has(name) && jar.size >= LIMITS.cookieCount) {
      continue;
    }
    jar.set(name, value);
  }
  const merged = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return merged.length <= LIMITS.cookies ? merged : String(header ?? '');
}

/** "Sat, 18-Oct-2026 12:00:00 GMT" (the Nest session end) -> ms, undefined when unreadable. */
export function parseExpiry(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const time = Date.parse(value.replace(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/, '$1 $2 $3'));
  return Number.isNaN(time) ? undefined : time;
}

export class NestClient {
  constructor({ transport = httpRequest, now = Date.now, onCookies, onSession } = {}) {
    this.transport = transport;
    this.now = now;
    /** Called with the merged cookie header when Google rotated some cookies. */
    this.onCookies = onCookies;
    /** Called after the Nest session changed (made or dropped). */
    this.onSession = onSession;
    this.issueToken = '';
    this.cookies = '';
    /** { accessToken, userId, expiresAt, transportUrl } */
    this.session = null;
    /** Per-request timeout; undefined = the transport's default (shorter for the button). */
    this.timeout = undefined;
    this.signingIn = undefined;
  }

  configure({ issueToken, cookies, session = null }) {
    this.issueToken = issueToken;
    this.cookies = cookies;
    this.session = session;
  }

  get hasSession() {
    return Boolean(this.session?.accessToken);
  }

  /** The session is usable for a whole long poll. */
  get sessionFresh() {
    return this.hasSession && this.session.expiresAt - this.now() > TIMINGS.sessionMargin;
  }

  dropSession() {
    if (this.session) {
      this.session = null;
      this.onSession?.(null);
    }
  }

  async send(url, { maxBytes, timeout, ...options }) {
    return this.transport(url, {
      ...options,
      timeout: timeout ?? this.timeout ?? TIMINGS.requestTimeout,
      maxBytes,
    });
  }

  // --- Sign-in ---------------------------------------------------------------

  /** Step 1: the Google access token, from the cookies of a signed-in browser. */
  async googleToken() {
    if (!this.issueToken || !this.cookies) {
      throw new NestError('no_credentials', 'no issue_token or cookies');
    }
    const answer = await this.send(this.issueToken, {
      method: 'GET',
      headers: {
        'Sec-Fetch-Mode': 'cors',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XmlHttpRequest',
        Referer: NEST.googleReferer,
        Cookie: this.cookies,
      },
      maxBytes: LIMITS.authBytes,
    });
    const transient = transientError(answer, this.now());
    if (transient) {
      throw transient;
    }
    const json = tryJson(answer.body);
    if (json?.error || answer.status >= 400) {
      // USER_LOGGED_OUT (pynest BadCredentialsException) and every other
      // refusal: the cookies or the URL are not accepted any more. Never
      // tried again by itself.
      const code = safeCode(json?.error);
      throw new NestError(
        'refused',
        code ? `Google refused the cookies (${code})` : 'Google refused the cookies',
        { status: answer.status },
      );
    }
    if (typeof json?.access_token !== 'string' || json.access_token === '') {
      throw new NestError('bad_response', 'Google sent no access token', {
        status: answer.status,
      });
    }
    const rotated = answer.headers?.['set-cookie'];
    if (rotated) {
      const merged = mergeCookies(this.cookies, rotated);
      if (merged !== this.cookies) {
        this.cookies = merged;
        this.onCookies?.(merged);
      }
    }
    return json.access_token;
  }

  /** Step 2: the Nest JWT, from the Google access token. */
  async nestJwt(googleToken) {
    const form = new URLSearchParams({
      embed_google_oauth_access_token: 'true',
      expire_after: '3600s',
      google_oauth_access_token: googleToken,
      policy_id: 'authproxy-oauth-policy',
    }).toString();
    const answer = await this.send(NEST.jwtUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${googleToken}`,
        'User-Agent': USER_AGENT,
        Referer: NEST.host,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form),
      },
      body: form,
      maxBytes: LIMITS.authBytes,
    });
    const transient = transientError(answer, this.now());
    if (transient) {
      throw transient;
    }
    const json = tryJson(answer.body);
    if (answer.status === 401 || answer.status === 403 || json?.error) {
      throw new NestError('nest_refused', 'Nest refused the Google token', {
        status: answer.status,
      });
    }
    if (answer.status >= 400) {
      throw new NestError('http', 'unexpected answer of the Nest sign-in', {
        status: answer.status,
      });
    }
    if (typeof json?.jwt !== 'string' || json.jwt === '') {
      throw new NestError('bad_response', 'Nest sent no JWT', { status: answer.status });
    }
    return json.jwt;
  }

  /** Step 3: the Nest session, from the JWT. */
  async nestSession(jwt) {
    const answer = await this.send(nestUrls.session(), {
      method: 'GET',
      headers: {
        Authorization: `Basic ${jwt}`,
        'User-Agent': USER_AGENT,
        Cookie: `G_ENABLED_IDPS=google; eu_cookie_accepted=1; viewer-volume=0.5; cztoken=${jwt}`,
      },
      maxBytes: LIMITS.authBytes,
    });
    const transient = transientError(answer, this.now());
    if (transient) {
      throw transient;
    }
    const json = tryJson(answer.body);
    if (answer.status === 401 || answer.status === 403 || json?.error) {
      throw new NestError('nest_refused', 'Nest refused the session', { status: answer.status });
    }
    if (answer.status >= 400 || !json) {
      throw new NestError('bad_response', 'unexpected answer of the Nest session', {
        status: answer.status,
      });
    }
    const userId = json.userid;
    if (
      typeof json.access_token !== 'string' ||
      json.access_token === '' ||
      typeof userId !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(userId)
    ) {
      throw new NestError('bad_response', 'the Nest session has no token or user id');
    }
    const now = this.now();
    const end = parseExpiry(json.expires_in);
    return {
      accessToken: json.access_token,
      userId,
      expiresAt: end !== undefined && end > now ? end : now + TIMINGS.sessionDefault,
      transportUrl: trustedTransport(json.urls?.transport_url),
    };
  }

  /** The three steps; one at a time (a second caller waits for the first). */
  signIn() {
    if (!this.signingIn) {
      this.signingIn = (async () => {
        const google = await this.googleToken();
        const jwt = await this.nestJwt(google);
        this.session = await this.nestSession(jwt);
        this.onSession?.(this.session);
        return this.session;
      })().finally(() => {
        this.signingIn = undefined;
      });
    }
    return this.signingIn;
  }

  // --- Reads -----------------------------------------------------------------

  nestHeaders() {
    return {
      Authorization: `Basic ${this.session.accessToken}`,
      'X-nl-user-id': this.session.userId,
      'X-nl-protocol-version': '1',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    };
  }

  /** The errors of the two Nest reads. */
  readError(answer, what) {
    if (answer.status === 401 || answer.status === 403) {
      return new NestError('unauthorized', `Nest refused the session (${what})`, {
        status: answer.status,
      });
    }
    if (what === 'subscribe' && (answer.status === 502 || answer.status === 504)) {
      return new NestError('gateway', 'the Nest transport did not answer', {
        status: answer.status,
      });
    }
    return transientError(answer, this.now());
  }

  /** Step 4: every bucket of the account (pynest `get_first_data`). */
  async appLaunch() {
    if (!this.hasSession) {
      throw new NestError('unauthorized', 'no Nest session');
    }
    const body = JSON.stringify({ known_bucket_types: BUCKET_TYPES, known_bucket_versions: [] });
    const answer = await this.send(nestUrls.appLaunch(this.session.userId), {
      method: 'POST',
      headers: { ...this.nestHeaders(), 'Content-Length': Buffer.byteLength(body) },
      body,
      maxBytes: LIMITS.responseBytes,
    });
    const error = this.readError(answer, 'app_launch');
    if (error) {
      throw error;
    }
    const json = tryJson(answer.body);
    if (answer.status >= 400 || !json || json.error || !Array.isArray(json.updated_buckets)) {
      throw new NestError('bad_response', 'unexpected answer of app_launch', {
        status: answer.status,
      });
    }
    const transport = trustedTransport(json.service_urls?.urls?.transport_url);
    if (transport && transport !== this.session.transportUrl) {
      this.session = { ...this.session, transportUrl: transport };
      this.onSession?.(this.session);
    }
    if (!this.session.transportUrl) {
      throw new NestError('bad_response', 'Nest gave no usable transport URL');
    }
    return json.updated_buckets;
  }

  /**
   * Step 5: the long poll. Resolves the buckets that changed ([] when Nest
   * answered without any, pynest's EmptyResponseException).
   */
  async subscribe(objects, { signal } = {}) {
    if (!this.hasSession || !this.session.transportUrl) {
      throw new NestError('unauthorized', 'no Nest session');
    }
    const body = JSON.stringify({ objects });
    const answer = await this.transport(nestUrls.subscribe(this.session.transportUrl), {
      method: 'POST',
      headers: { ...this.nestHeaders(), 'Content-Length': Buffer.byteLength(body) },
      body,
      timeout: TIMINGS.subscribeTimeout,
      maxBytes: LIMITS.responseBytes,
      signal,
    });
    const error = this.readError(answer, 'subscribe');
    if (error) {
      throw error;
    }
    const type = String(answer.headers?.['content-type'] ?? '');
    if (answer.status === 200 && type.startsWith('text/plain')) {
      return [];
    }
    const json = tryJson(answer.body);
    if (answer.status >= 400 || !json || !Array.isArray(json.objects)) {
      throw new NestError('bad_response', 'unexpected answer of the long poll', {
        status: answer.status,
      });
    }
    return json.objects;
  }
}
