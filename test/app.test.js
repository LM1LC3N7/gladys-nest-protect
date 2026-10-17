// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake Google + Nest behind the transport. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NestProtectApp } from '../src/app.js';
import { ACTIONS, SCENE_TRIGGERS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { NestError } from '../src/http.js';
import {
  COOKIES,
  HOUR,
  ISSUE_TOKEN,
  MINUTE,
  NOW,
  SECOND,
  TRANSPORT,
  USER_ID,
  fakeNest,
  memoryStore,
  protect,
  settle,
} from './helpers/fakeNest.js';

const CONFIG = { issue_token: ISSUE_TOKEN, cookies: COOKIES };
const DEVICE = 'ext:test-integration:protect:DEV1';
const feature = (key, id = 'DEV1') => `ext:test-integration:protect:${id}:${key}`;

const mocked = new WeakSet();

async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    server = fakeNest(),
    now = NOW,
    create = true,
    logs = [],
  } = {},
) {
  if (!mocked.has(t)) {
    mocked.add(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  }
  const gladys = createFakeGladys({ config });
  const app = new NestProtectApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed <= ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, Math.max(0, ms - elapsed)));
      await settle();
    }
  };
  await advance(0);
  if (create) {
    for (const d of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(d);
    }
    await advance(2 * SECOND);
  }
  return { gladys, app, server, store, advance, logs };
}

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, key, id) => gladys.fake.lastState(feature(key, id));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};

function assertNoSecret(server, logs, extra = []) {
  const text = JSON.stringify(logs);
  for (const secret of [...server.secrets, ...extra]) {
    assert.ok(!text.includes(secret), `a secret reached the logs: ${secret.slice(0, 12)}…`);
  }
}

test('without the issue_token and cookies, the status asks for them and nothing is sent', async (t) => {
  const { gladys, server } = await setup(t, { config: { issue_token: ISSUE_TOKEN } });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /issue_token and the cookies/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /issue_token et les cookies/);
  assert.equal(server.requests.length, 0);
});

test('an issue_token that is not a Google iframerpc URL is refused before any request', async (t) => {
  const { gladys, server } = await setup(t, {
    config: {
      issue_token: 'https://evil.example.com/o/oauth2/iframerpc?action=issueToken',
      cookies: COOKIES,
    },
  });
  assert.equal(server.requests.length, 0, 'the cookies never go anywhere else');
  assert.match(message(gladys).en, /not the expected address/);
  const short = await setup(t, { config: { issue_token: ISSUE_TOKEN, cookies: 'SID=x' } });
  assert.equal(short.server.requests.length, 0);
  assert.match(message(short.gladys).fr, /ne ressemblent pas/);
});

test('the sign-in chain of pynest, one full read, then the long poll; nothing secret kept or logged', async (t) => {
  const logs = [];
  const { gladys, server, store } = await setup(t, { logs });
  assert.deepEqual(
    server.requests.slice(0, 5).map((r) => `${r.method} ${r.host}${r.path}`),
    [
      'GET accounts.google.com/o/oauth2/iframerpc',
      'POST nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
      'GET home.nest.com/session',
      `POST home.nest.com/api/0.1/user/${USER_ID}/app_launch`,
      `POST ${new URL(TRANSPORT).hostname}/v6/subscribe`,
    ],
  );
  const [google, jwt, session, launch, poll] = server.requests;
  assert.equal(google.url, ISSUE_TOKEN);
  assert.equal(google.headers.Cookie, COOKIES);
  assert.equal(google.headers['X-Requested-With'], 'XmlHttpRequest');
  assert.equal(google.headers.Referer, 'https://accounts.google.com/o/oauth2/iframe');
  const form = Object.fromEntries(new URLSearchParams(jwt.body));
  assert.deepEqual(form, {
    embed_google_oauth_access_token: 'true',
    expire_after: '3600s',
    google_oauth_access_token: 'ya29.google-1',
    policy_id: 'authproxy-oauth-policy',
  });
  assert.equal(jwt.headers.Authorization, 'Bearer ya29.google-1');
  assert.equal(session.headers.Authorization, 'Basic jwt-secret-1');
  assert.match(session.headers.Cookie, /cztoken=jwt-secret-1/);
  assert.equal(launch.headers.Authorization, 'Basic nest-token-secret-1');
  assert.equal(launch.headers['X-nl-protocol-version'], '1');
  assert.deepEqual(launch.json.known_bucket_types, ['topaz', 'where', 'widget_track']);
  assert.deepEqual(poll.json.objects.map((o) => [o.object_key, o.object_revision]).sort(), [
    ['topaz.DEV1', 1],
    ['where.STRUCT-1', 1],
    ['widget_track.DEV1', 1],
  ]);
  // The cookies only ever go to Google.
  for (const r of server.requests.slice(1)) {
    assert.ok(!JSON.stringify(r.headers).includes('secret-sid'), `${r.host} got the cookies`);
  }

  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'Nest Protect (Kitchen)');
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.split(':').pop(),
      f.category,
      f.type,
      f.unit ?? null,
    ]),
    [
      ['smoke', 'smoke-sensor', 'binary', null],
      ['co', 'co-sensor', 'binary', null],
      ['muted', 'smoke-sensor', 'muted', null],
      ['battery', 'battery', 'integer', 'percent'],
      ['battery_low', 'battery-low', 'binary', null],
      ['online', 'unknown', 'unknown', null],
      ['self_test', 'unknown', 'unknown', null],
      ['last_test_days', 'duration', 'integer', 'days'],
      ['night_light', 'unknown', 'unknown', null],
    ],
  );
  assert.ok(
    device.features.every((f) => f.read_only === true),
    'read only',
  );
  assert.equal(device.features[0].name, 'Fumée');
  assert.deepEqual(Object.fromEntries(device.params.map((p) => [p.name, p.value])), {
    model: 'Topaz-2.7',
    software_version: '3.6rc3',
    power: 'battery',
  });

  assert.equal(last(gladys, 'smoke'), 0);
  assert.equal(last(gladys, 'co'), 0);
  assert.equal(last(gladys, 'muted'), 0);
  assert.equal(last(gladys, 'battery'), 53);
  assert.equal(last(gladys, 'battery_low'), 0);
  assert.equal(last(gladys, 'online'), 1);
  assert.equal(last(gladys, 'self_test'), 1);
  assert.equal(last(gladys, 'last_test_days'), 10);
  assert.equal(last(gladys, 'night_light'), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /1 Nest Protect/);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.CLOUD,
  });

  // /data: the Nest session only (the strictly needed token), never the cookies, the URL, the e-mail.
  const saved = JSON.stringify(store.data);
  assert.equal(store.data.session.accessToken, 'nest-token-secret-1');
  assert.equal(store.data.session.userId, USER_ID);
  for (const secret of [
    COOKIES,
    'secret-sid',
    ISSUE_TOKEN,
    'SECRET-LOGIN-HINT',
    'ya29',
    'jwt-secret',
    'someone.secret',
  ]) {
    assert.ok(!saved.includes(secret), `/data holds ${secret.slice(0, 12)}`);
  }
  assertNoSecret(server, logs);
});

test('a change arrives by the long poll; the scene triggers fire once per rise', async (t) => {
  const { gladys, server, advance } = await setup(t);
  assert.equal(server.waiting.length, 1);
  server.change('topaz.DEV1', { smoke_status: 2 });
  await advance(3 * SECOND);
  assert.equal(last(gladys, 'smoke'), 1);
  assert.deepEqual(gladys.fake.sceneEvents, [
    { key: SCENE_TRIGGERS.SMOKE, data: { device: DEVICE, level: 'warning', room: 'Kitchen' } },
  ]);
  // The next long poll carries the new revision.
  assert.equal(
    server
      .polls()
      .at(-1)
      .json.objects.find((o) => o.object_key === 'topaz.DEV1').object_revision,
    2,
  );

  server.change('topaz.DEV1', { smoke_status: 3 });
  await advance(3 * SECOND);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'still smoke: no second event');
  server.change('topaz.DEV1', { smoke_status: 0 });
  await advance(3 * SECOND);
  assert.equal(last(gladys, 'smoke'), 0);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'never on the way back');
  server.change('topaz.DEV1', { co_status: 3, hushed_state: true });
  await advance(3 * SECOND);
  assert.equal(last(gladys, 'co'), 1);
  assert.equal(last(gladys, 'muted'), 1);
  assert.deepEqual(gladys.fake.sceneEvents.at(-1), {
    key: SCENE_TRIGGERS.CO,
    data: { device: DEVICE, level: 'emergency', room: 'Kitchen' },
  });
  server.change('topaz.DEV1', { smoke_status: 1 });
  await advance(3 * SECOND);
  assert.deepEqual(gladys.fake.sceneEvents.at(-1).data.level, 'testing', 'a test fires too');
});

test('an alarm already on at the first read fires once', async (t) => {
  const server = fakeNest();
  server.put('topaz.DEV1', protect({ co_status: 2 }));
  const { gladys, advance } = await setup(t, { server });
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => e.key),
    [SCENE_TRIGGERS.CO],
  );
  server.answerPolls({ objects: [] });
  await advance(5 * SECOND);
  assert.equal(gladys.fake.sceneEvents.length, 1);
});

test('read only: no writable feature, every command refused, nothing sent to Nest', async (t) => {
  const { gladys, server } = await setup(t);
  const device = gladys.fake.devices[0];
  const before = server.requests.length;
  const ack = await gladys.fake.setValue(device, device.features[0], 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /read only/);
  assert.equal(server.requests.length, before);
  assert.ok(
    gladys.fake.discoveredDevices.every((d) => d.features.every((f) => f.category !== 'switch')),
  );
});

test('Google refuses the cookies: a stop kept in /data, never retried by itself; new cookies retry', async (t) => {
  const server = fakeNest();
  server.loggedOut = true;
  const store = memoryStore();
  const logs = [];
  const { gladys, advance } = await setup(t, { server, store, create: false, logs });
  assert.equal(server.requests.length, 1);
  assertNoSecret(server, logs);
  assert.ok(
    logs.some((l) => /USER_LOGGED_OUT/.test(l)),
    'the reason is logged, not the cookies',
  );
  assert.match(message(gladys).en, /Google refused the cookies/);
  assert.equal(store.data.block.kind, 'refused');
  await advance(3 * HOUR, 10 * MINUTE);
  assert.equal(server.requests.length, 1, 'no loop');

  // A restart: still stopped, nothing sent.
  const again = await setup(t, { server, store, create: false });
  assert.equal(server.requests.length, 1);
  assert.match(message(again.gladys).fr, /Google a refusé les cookies/);

  // New cookies saved by the user: one new try.
  server.loggedOut = false;
  await again.gladys.fake.configUpdated({ ...CONFIG, cookies: `${COOKIES}; NID=new-one` });
  await again.advance(2 * SECOND);
  assert.equal(server.launches().length, 1);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.block, null);
});

test('the test button retries a stopped account', async (t) => {
  const server = fakeNest();
  server.loggedOut = true;
  const { gladys } = await setup(t, { server, create: false });
  server.loggedOut = false;
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /Connected to Nest/);
  assert.equal(server.launches().length, 1);
  const soon = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(soon.data.message.en, /less than 30 seconds/);
});

test('the test button cuts the long poll under way and reads again', async (t) => {
  const { gladys, server, advance } = await setup(t);
  await advance(40 * SECOND);
  assert.equal(server.waiting.length, 1);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /Connected/);
  assert.equal(server.launches().length, 2);
  await advance(3 * SECOND);
  assert.equal(server.waiting.length, 1, 'one long poll again, not two');
  assert.equal(server.google().length, 1, 'the session was still good');
});

test('a session Nest refuses is made again once; refused right after: spaced retries, persisted', async (t) => {
  const store = memoryStore();
  const logs = [];
  const { gladys, server, advance } = await setup(t, { store, logs });
  await advance(3 * MINUTE, MINUTE);
  server.revokeSessions();
  server.answerPolls('unauthorized', 401, { 'content-type': 'text/plain' });
  await advance(3 * SECOND);
  assert.equal(server.google().length, 2, 'one new sign-in');
  assert.equal(server.waiting.length, 1, 'the long poll goes on');
  assert.equal(gladys.fake.connectionStatus.connected, true);

  await advance(3 * MINUTE, MINUTE);
  // Nest now refuses every session it gives.
  server.queue.push(
    ...[1, 2, 3].map(() => ({
      match: (r) => r.path === '/v6/subscribe',
      status: 401,
      body: 'unauthorized',
      headers: { 'content-type': 'text/plain' },
    })),
  );
  server.revokeSessions();
  server.answerPolls('unauthorized', 401, { 'content-type': 'text/plain' });
  await advance(3 * SECOND);
  assert.equal(server.google().length, 3);
  assert.match(
    message(gladys).en,
    /Nest refused the session it had just given: one new try in 60 min/,
  );
  assert.equal(store.data.block.kind, 'session_refused');
  const count = server.requests.length;
  await advance(59 * MINUTE, MINUTE);
  assert.equal(server.requests.length, count, 'nothing before the hour');
  await advance(2 * MINUTE, 10 * SECOND);
  assert.equal(server.google().length, 4, 'one new try after an hour');
  assert.match(message(gladys).en, /one new try in 6 h/);
  assert.equal(store.data.block.retries, 2);
  assertNoSecret(server, logs);
});

test('the persisted Nest session is used after a restart: Google is not asked again', async (t) => {
  const store = memoryStore();
  const server = fakeNest();
  await setup(t, { store, server });
  assert.equal(server.google().length, 1);
  const again = await setup(t, { store, server, create: false });
  assert.equal(server.google().length, 1);
  assert.equal(server.launches().length, 2);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
});

test('the session is renewed before it ends', async (t) => {
  const server = fakeNest();
  const { advance } = await setup(t, { server });
  // The session ends on Nov 17 at 10:00; renewed 15 minutes before, at the next long poll.
  t.mock.timers.setTime(Date.UTC(2026, 10, 17, 9, 50));
  server.answerPolls({ objects: [] });
  await advance(5 * SECOND);
  assert.equal(server.google().length, 2);
});

test('cookies rotated by Google go back to the configuration, never to /data, and do not restart', async (t) => {
  const server = fakeNest();
  server.rotate = ['__Secure-1PSIDTS=sidts-NEW; Path=/; Domain=.google.com; Secure; HttpOnly'];
  const store = memoryStore();
  const { gladys, app, advance } = await setup(t, { server, store });
  const saved = gladys.fake.bodies('POST', '/config');
  const merged = COOKIES.replace('sidts-OLD', 'sidts-NEW');
  assert.deepEqual(saved, [{ config: { cookies: merged } }], 'only the cookies field, merged');
  assert.ok(!JSON.stringify(store.data).includes('sidts'), 'never in /data');
  // Gladys echoes the change: no new sign-in.
  await gladys.fake.configUpdated({ ...CONFIG, cookies: merged });
  await advance(2 * SECOND);
  assert.equal(server.google().length, 1);
  // A save that did not reach Gladys: the old value coming back keeps the rotated one.
  await gladys.fake.configUpdated(CONFIG);
  await advance(2 * SECOND);
  assert.equal(server.google().length, 1);
  assert.equal(app.config.cookies, merged);
});

test('429: a pause bounded and kept in /data, across a restart', async (t) => {
  const server = fakeNest();
  server.queue.push({
    match: (r) => r.path.endsWith('/app_launch'),
    status: 429,
    body: '',
    headers: { 'retry-after': '1800' },
  });
  const store = memoryStore();
  const { gladys, advance } = await setup(t, { server, store, create: false });
  assert.match(message(gladys).en, /429\): paused for 30 min/);
  assert.equal(store.data.rateLimitedUntil, NOW + 30 * MINUTE);
  const count = server.requests.length;
  await setup(t, { server, store, create: false });
  assert.equal(server.requests.length, count, 'still paused after a restart');
  await advance(29 * MINUTE, MINUTE);
  assert.equal(server.requests.length, count);
});

test('502/504 of the long poll: two minutes, as pynest; network errors: 15 s, then 1 min, badge grey', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.answerPolls('', 504);
  await advance(SECOND);
  const count = server.polls().length;
  await advance(110 * SECOND, 10 * SECOND);
  assert.equal(server.polls().length, count);
  await advance(15 * SECOND);
  assert.equal(server.polls().length, count + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);

  const cut = () =>
    server.queue.push({
      match: (r) => r.path === '/v6/subscribe' || r.path.endsWith('/app_launch'),
      error: new NestError('network', 'connection reset'),
    });
  cut();
  cut();
  server.answerPolls({ objects: [] });
  await advance(3 * SECOND);
  // First cut: retried 15 s later (a full read first), still "connected".
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await advance(16 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /Nest unreachable \(connection reset\): new try in 1 min/);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  await advance(61 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.CLOUD);
});

test('empty answers coming back at once slow the long poll down', async (t) => {
  const { server, advance } = await setup(t);
  for (let i = 0; i < 3; i += 1) {
    server.answerPolls('', 200, { 'content-type': 'text/plain' });
    await advance(3 * SECOND);
  }
  const count = server.polls().length;
  await advance(50 * SECOND, 5 * SECOND);
  assert.equal(server.polls().length, count, 'a one-minute pause');
  await advance(15 * SECOND, 5 * SECOND);
  assert.equal(server.polls().length, count + 1);
});

test('a long poll that times out is simply sent again', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.queue.push({
    match: (r) => r.path === '/v6/subscribe',
    error: new NestError('timeout', 'no answer'),
  });
  server.answerPolls({ objects: [] });
  await advance(5 * SECOND);
  assert.equal(server.waiting.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a full read again every hour, on top of the long poll', async (t) => {
  const { server, advance } = await setup(t);
  t.mock.timers.setTime(NOW + HOUR + MINUTE);
  server.answerPolls({ objects: [] });
  await advance(5 * SECOND);
  assert.equal(server.launches().length, 2);
});

test('the transport URL Nest gives must be a Nest host: the token never goes elsewhere', async (t) => {
  const server = fakeNest();
  server.sessionTransport = 'https://transport.evil.example.com';
  const { gladys } = await setup(t, { server, create: false });
  assert.equal(server.polls().length, 0);
  assert.ok(server.requests.every((r) => !r.host.includes('evil')));
  assert.match(message(gladys).en, /Connecting/, 'one failure: not yet reported');
});

test('a detector offline for Nest: online 0 and a grey badge', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.change('widget_track.DEV1', { online: false });
  await advance(3 * SECOND);
  assert.equal(last(gladys, 'online'), 0);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});

test('a reconnection to Gladys resends status and Discovery, keeps the session', async (t) => {
  const { gladys, server } = await setup(t);
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(server.google().length, 1);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
});

test('a published device never loses a feature', async (t) => {
  const { gladys, server, advance } = await setup(t);
  const value = { ...server.buckets.get('topaz.DEV1').value };
  delete value.night_light_enable;
  delete value.hushed_state;
  server.put('topaz.DEV1', value);
  server.answerPolls({ objects: [server.bucket('topaz.DEV1')] });
  await advance(3 * SECOND);
  await gladys.fake.scanRequest();
  const keys = gladys.fake.discoveredDevices[0].features.map((f) => f.external_id.split(':').pop());
  assert.ok(keys.includes('night_light') && keys.includes('muted'));
});

test('an account without Nest Protect: no long poll, a full read again in an hour', async (t) => {
  const server = fakeNest();
  server.buckets.delete('topaz.DEV1');
  server.buckets.delete('widget_track.DEV1');
  const { gladys, advance } = await setup(t, { server });
  assert.equal(server.polls().length, 0);
  assert.match(message(gladys).en, /0 Nest Protect/);
  await advance(HOUR + MINUTE, 10 * MINUTE);
  assert.equal(server.launches().length, 2);
  assert.equal(server.polls().length, 0);
});
