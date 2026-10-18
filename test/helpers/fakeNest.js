// -----------------------------------------------------------------------------
// A fake Google + Nest behind the transport the integration is given: the
// issueToken call (cookies), the Nest auth proxy (JWT), the Nest session,
// app_launch and the long poll (held open until the test pushes a change).
// Answers are shaped like the ones pynest (ha-nest-protect) parses. Records
// every request. No network.
// -----------------------------------------------------------------------------

import { NestError } from '../../src/http.js';

export const ISSUE_TOKEN =
  'https://accounts.google.com/o/oauth2/iframerpc?action=issueToken&response_type=token%20id_token&login_hint=SECRET-LOGIN-HINT&client_id=733249279899-1gpkq9duqmdp55a7e5lft1pr2smumdla.apps.googleusercontent.com&origin=https%3A%2F%2Fhome.nest.com&scope=openid%20profile%20email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fnest-account&ss_domain=https%3A%2F%2Fhome.nest.com';
export const COOKIES =
  'SID=secret-sid-value-0123456789abcdef; HSID=secret-hsid-AbCdEf; SSID=secret-ssid-GhIjKl; APISID=secret-apisid/MnOpQr; SAPISID=secret-sapisid/StUvWx; __Secure-1PSIDTS=sidts-OLD';
export const EMAIL = 'someone.secret@example.com';
export const USER_ID = '1234567';
export const TRANSPORT = 'https://czfe1-front01-iad01.transport.home.nest.com';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
/** 2026-10-18 10:00:00 UTC */
export const NOW = Date.UTC(2026, 9, 18, 10, 0, 0);

/** A Nest Protect bucket value, shaped like a topaz bucket of pynest. */
export const protect = (overrides = {}) => ({
  spoken_where_id: '00000000-0000-0000-0000-000100000001',
  where_id: '00000000-0000-0000-0000-000100000001',
  structure_id: 'STRUCT-1',
  serial_number: '06AA01AB12345678',
  model: 'Topaz-2.7',
  software_version: '3.6rc3',
  wired_or_battery: 1,
  smoke_status: 0,
  co_status: 0,
  heat_status: 0,
  hushed_state: false,
  battery_level: 5000,
  battery_health_state: 0,
  component_smoke_test_passed: true,
  component_co_test_passed: true,
  component_wifi_test_passed: true,
  component_led_test_passed: true,
  component_pir_test_passed: true,
  component_buzzer_test_passed: true,
  component_speaker_test_passed: true,
  component_hum_test_passed: true,
  component_heat_test_passed: false,
  latest_manual_test_end_utc_secs: Math.floor(NOW / 1000) - 10 * 86400 - 3600,
  night_light_enable: true,
  wifi_mac_address: '18b430000001',
  ...overrides,
});

export const where = () => ({
  wheres: [
    { where_id: '00000000-0000-0000-0000-000100000001', name: 'Kitchen' },
    { where_id: '00000000-0000-0000-0000-000100000002', name: 'Hallway' },
  ],
});

const answer = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
});

export function fakeNest() {
  const server = {
    /** object_key -> { revision, timestamp, value } */
    buckets: new Map(),
    /** { method, url, host, path, headers, body, json } */
    requests: [],
    googleTokens: new Set(),
    jwts: new Set(),
    sessions: new Set(),
    issued: 0,
    loggedOut: false,
    /** Set-Cookie headers of the next issueToken answers. */
    rotate: undefined,
    sessionTransport: TRANSPORT,
    /** One-shot answers or errors: { match(request), status?, body?, headers?, error?, wait? } */
    queue: [],
    /** The long polls waiting for a change. */
    waiting: [],
    /** Every secret ever issued or configured, to check none reaches the logs. */
    secrets: [ISSUE_TOKEN, COOKIES, 'SECRET-LOGIN-HINT', 'secret-sid-value', EMAIL],
    of(path) {
      return this.requests.filter((r) => r.path.endsWith(path));
    },
    google() {
      return this.requests.filter((r) => r.host === 'accounts.google.com');
    },
    launches() {
      return this.of('/app_launch');
    },
    polls() {
      return this.of('/v6/subscribe');
    },
    put(key, value) {
      const current = this.buckets.get(key);
      const revision = (current?.revision ?? 0) + 1;
      this.buckets.set(key, { revision, timestamp: NOW + revision, value });
      return this.bucket(key);
    },
    bucket(key) {
      const b = this.buckets.get(key);
      return {
        object_key: key,
        object_revision: b.revision,
        object_timestamp: b.timestamp,
        value: structuredClone(b.value),
      };
    },
    /** A change of a detector: every waiting long poll gets it. */
    change(key, patch) {
      const value = { ...this.buckets.get(key).value, ...patch };
      const bucket = this.put(key, value);
      this.answerPolls({ objects: [bucket] });
    },
    answerPolls(body, status = 200, headers) {
      const waiting = this.waiting;
      this.waiting = [];
      for (const w of waiting) {
        w.resolve(answer(status, body, headers));
      }
    },
    revokeSessions() {
      this.sessions.clear();
    },
    transport: async (url, options = {}) => {
      const target = new URL(url);
      const json = (() => {
        try {
          return JSON.parse(options.body ?? '');
        } catch {
          return undefined;
        }
      })();
      const request = {
        method: options.method ?? 'GET',
        url,
        host: target.hostname,
        path: target.pathname,
        headers: options.headers ?? {},
        body: options.body,
        json,
        timeout: options.timeout,
      };
      server.requests.push(request);
      const i = server.queue.findIndex((q) => q.match(request));
      if (i >= 0) {
        const [one] = server.queue.splice(i, 1);
        if (one.wait) {
          await one.wait;
        }
        if (one.error) {
          throw one.error;
        }
        return answer(one.status ?? 200, one.body, one.headers);
      }
      return server.handle(request, options);
    },
    handle(request, options) {
      const { host, path, headers } = request;
      if (host === 'accounts.google.com' && path === '/o/oauth2/iframerpc') {
        if (request.url !== ISSUE_TOKEN || !String(headers.Cookie).includes('SID=secret-sid')) {
          return answer(400, { error: 'invalid_request' });
        }
        if (server.loggedOut) {
          return answer(200, { error: 'USER_LOGGED_OUT', detail: 'No active session found.' });
        }
        server.issued += 1;
        const token = `ya29.google-${server.issued}`;
        server.googleTokens.add(token);
        server.secrets.push(token);
        return answer(
          200,
          {
            token_type: 'Bearer',
            access_token: token,
            scope: 'email profile openid',
            login_hint: 'SECRET-LOGIN-HINT',
            expires_in: 3599,
            id_token: 'id-token-secret',
            session_state: { extraQueryParams: { authuser: '0' } },
          },
          server.rotate ? { 'set-cookie': server.rotate } : {},
        );
      }
      if (host === 'nestauthproxyservice-pa.googleapis.com' && path === '/v1/issue_jwt') {
        const bearer = String(headers.Authorization).replace(/^Bearer /, '');
        const form = new URLSearchParams(request.body);
        if (!server.googleTokens.has(bearer) || form.get('google_oauth_access_token') !== bearer) {
          return answer(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
        }
        const jwt = `jwt-secret-${server.issued}`;
        server.jwts.add(jwt);
        server.secrets.push(jwt);
        return answer(200, { jwt, claims: { expirationTime: '2026-10-18T11:00:00Z' } });
      }
      if (host === 'home.nest.com' && path === '/session') {
        const jwt = String(headers.Authorization).replace(/^Basic /, '');
        if (!server.jwts.has(jwt)) {
          return answer(401, { error: 'unauthorized' });
        }
        const token = `nest-token-secret-${server.issued}`;
        server.sessions.add(token);
        server.secrets.push(token);
        return answer(200, {
          access_token: token,
          email: EMAIL,
          expires_in: 'Sun, 17-Nov-2026 10:00:00 GMT',
          userid: USER_ID,
          is_superuser: false,
          language: 'fr_FR',
          weave: { service_config: 'x', authorization: 'y' },
          user: `user.${USER_ID}`,
          is_staff: false,
          urls: { transport_url: server.sessionTransport },
        });
      }
      const basic = String(headers.Authorization).replace(/^Basic /, '');
      if (host === 'home.nest.com' && path === `/api/0.1/user/${USER_ID}/app_launch`) {
        if (!server.sessions.has(basic) || headers['X-nl-user-id'] !== USER_ID) {
          return answer(401, { error: 'unauthorized' });
        }
        return answer(200, {
          updated_buckets: [...server.buckets.keys()].map((k) => server.bucket(k)),
          service_urls: { urls: { transport_url: server.sessionTransport } },
          weather_for_structures: {},
          '2fa_enabled': false,
        });
      }
      if (`https://${host}` === TRANSPORT && path === '/v6/subscribe') {
        if (!server.sessions.has(basic)) {
          return answer(401, 'unauthorized', { 'content-type': 'text/plain' });
        }
        return new Promise((resolve, reject) => {
          const entry = { resolve, objects: request.json?.objects };
          server.waiting.push(entry);
          options.signal?.addEventListener('abort', () => {
            server.waiting = server.waiting.filter((w) => w !== entry);
            reject(new NestError('aborted', 'request cancelled'));
          });
        });
      }
      return answer(404, { error: 'not found' });
    },
  };
  server.put('topaz.DEV1', protect());
  server.put('where.STRUCT-1', where());
  server.put('widget_track.DEV1', { online: true });
  return server;
}

export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
