// -----------------------------------------------------------------------------
// The pure parts: buckets, readings (ha-nest-protect's mappings), the
// configuration checks, the cookie merge, the session date, the store.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCookies, parseExpiry, trustedTransport } from '../src/client.js';
import { configProblem, normalizeConfig, validCookies, validIssueToken } from '../src/config.js';
import {
  READINGS,
  alarmLevel,
  alarmOn,
  batteryPercent,
  daysSince,
  detectorsOf,
  mergeBuckets,
  selfTestPassed,
  subscription,
} from '../src/model.js';
import { fingerprint, normalizeMemory } from '../src/store.js';
import { COOKIES, ISSUE_TOKEN, NOW, protect, where } from './helpers/fakeNest.js';

const bucket = (key, revision, value) => ({
  object_key: key,
  object_revision: revision,
  object_timestamp: 1000 + revision,
  value,
});

test('smoke and CO: "on" for any status but 0; the level names of sensor.py', () => {
  assert.deepEqual([0, 1, 2, 3].map(alarmOn), [0, 1, 1, 1]);
  assert.deepEqual([0, 1, 2, 3, 7].map(alarmLevel), [
    'ok',
    'testing',
    'warning',
    'emergency',
    'unknown',
  ]);
  assert.equal(alarmOn(undefined), undefined, 'unknown is never "no smoke"');
  assert.equal(alarmOn('0'), undefined);
});

test('battery: the L91 curve of sensor.py, unknown outside 3000-6000 mV', () => {
  assert.equal(batteryPercent(6000), 100);
  assert.equal(batteryPercent(5000), 53);
  assert.equal(batteryPercent(4900), 44);
  assert.equal(batteryPercent(4600), 23);
  assert.equal(batteryPercent(4300), 4);
  assert.equal(batteryPercent(3000), undefined);
  assert.equal(batteryPercent(6001), undefined);
  assert.equal(batteryPercent(null), undefined);
});

test('self-test: all the component tests binary_sensor.py shows, heat left out', () => {
  assert.equal(selfTestPassed(protect()), 1, 'component_heat_test_passed false is ignored');
  assert.equal(selfTestPassed(protect({ component_co_test_passed: false })), 0);
  assert.equal(selfTestPassed({}), undefined);
});

test('days since the last manual test', () => {
  assert.equal(daysSince(NOW / 1000 - 3 * 86400 - 5, NOW), 3);
  assert.equal(daysSince(NOW / 1000 + 50, NOW), 0);
  assert.equal(daysSince(0, NOW), undefined);
});

test('buckets: checked, merged by revision; a bucket without value keeps the readings', () => {
  let buckets = mergeBuckets(new Map(), [
    bucket('topaz.DEV1', 3, protect()),
    bucket('where.S1', 1, where()),
    bucket('kryptonite.X', 1, {}),
    bucket('topaz.../etc', 1, {}),
    { object_key: 'topaz.DEV2', object_revision: 'x', object_timestamp: 1 },
  ]);
  assert.deepEqual([...buckets.keys()], ['topaz.DEV1', 'where.S1']);
  buckets = mergeBuckets(buckets, [bucket('topaz.DEV1', 2, protect({ smoke_status: 2 }))]);
  assert.equal(buckets.get('topaz.DEV1').value.smoke_status, 0, 'an older revision is ignored');
  buckets = mergeBuckets(buckets, [
    { object_key: 'topaz.DEV1', object_revision: 4, object_timestamp: 9 },
  ]);
  assert.equal(buckets.get('topaz.DEV1').object_revision, 4);
  assert.equal(buckets.get('topaz.DEV1').value.battery_level, 5000);
  assert.deepEqual(subscription(buckets)[0], {
    object_key: 'topaz.DEV1',
    object_revision: 4,
    object_timestamp: 9,
  });
});

test('detectors: room name, online flag from widget_track, never guessed', () => {
  const buckets = mergeBuckets(new Map(), [
    bucket('topaz.DEV1', 1, protect()),
    bucket(
      'topaz.DEV2',
      1,
      protect({ where_id: 'nowhere', description: 'Upstairs', wired_or_battery: 0 }),
    ),
    bucket('topaz.DEV3', 1, protect({ is_online: false })),
    bucket('where.S1', 1, where()),
    bucket('widget_track.DEV1', 1, { online: true }),
  ]);
  const detectors = detectorsOf(buckets);
  assert.equal(detectors.get('DEV1').label, 'Kitchen');
  assert.equal(detectors.get('DEV1').online, true);
  assert.equal(detectors.get('DEV2').label, 'Upstairs');
  assert.equal(detectors.get('DEV2').online, undefined);
  assert.equal(detectors.get('DEV2').wired, true);
  assert.equal(detectors.get('DEV3').online, false);
  assert.equal(READINGS.online(detectors.get('DEV2')), undefined);
  assert.equal(READINGS.battery_low({ value: { battery_health_state: 1 } }), 1);
});

test('configuration: the issue_token must be a Google iframerpc URL, the cookies a Google header', () => {
  assert.ok(validIssueToken(ISSUE_TOKEN));
  for (const bad of [
    'http://accounts.google.com/o/oauth2/iframerpc?action=issueToken',
    'https://accounts.google.com.evil.example/o/oauth2/iframerpc?action=issueToken',
    'https://accounts.google.com/o/oauth2/iframerpc?action=other',
    `${ISSUE_TOKEN} x`,
    'x'.repeat(5000),
  ]) {
    assert.equal(validIssueToken(bad), false, bad.slice(0, 60));
  }
  assert.ok(validCookies(COOKIES));
  assert.equal(validCookies('NID=1; '.repeat(30)), false, 'no Google sign-in cookie');
  assert.equal(validCookies(`${COOKIES}\r\nX: y`), false);
  const config = normalizeConfig({
    issue_token: ` ${ISSUE_TOKEN} `,
    cookies: `cookie: ${COOKIES}`,
  });
  assert.equal(config.issueToken, ISSUE_TOKEN);
  assert.equal(config.cookies, COOKIES, 'the "cookie:" name copied with the value is dropped');
  assert.equal(config.language, 'fr');
  assert.equal(configProblem(config), undefined);
  assert.equal(configProblem(normalizeConfig({})), 'no_credentials');
});

test('cookies rotated by Google: merged, bounded, a deletion not taken', () => {
  assert.equal(
    mergeCookies('A=1; B=2', [
      'B=3; Path=/; Secure',
      'C=4; Domain=.google.com',
      'D=; Max-Age=0',
      'bad name=1',
    ]),
    'A=1; B=3; C=4',
  );
  assert.equal(mergeCookies('A=1', undefined), 'A=1');
  assert.equal(mergeCookies('A=1', 'A=2'), 'A=2');
});

test('the Nest session end and the transport URL', () => {
  assert.equal(parseExpiry('Sun, 17-Nov-2026 10:00:00 GMT'), Date.UTC(2026, 10, 17, 10));
  assert.equal(parseExpiry('soon'), undefined);
  assert.equal(
    trustedTransport('https://czfe1-front01-iad01.transport.home.nest.com/'),
    'https://czfe1-front01-iad01.transport.home.nest.com',
  );
  assert.equal(trustedTransport('https://transport.nest.com.evil.example'), undefined);
  assert.equal(trustedTransport('http://transport.home.nest.com'), undefined);
  assert.equal(trustedTransport('https://user:pw@transport.home.nest.com'), undefined);
});

test('the persisted state is repaired and capped', () => {
  const salt = 'a'.repeat(32);
  const memory = normalizeMemory(
    {
      salt,
      session: {
        account: fingerprint(salt, 'x'),
        accessToken: 't',
        userId: '1',
        expiresAt: 5,
        transportUrl: 'https://evil.example',
        cookies: 'never kept',
      },
      rateLimitedUntil: NOW + 100 * 3600_000,
      block: {
        kind: 'session_refused',
        fingerprint: fingerprint(salt, 'x', 'y'),
        retryAt: NOW + 1e12,
        retries: 99,
      },
    },
    NOW,
  );
  assert.equal(memory.session.transportUrl, undefined);
  assert.ok(!('cookies' in memory.session));
  assert.equal(memory.rateLimitedUntil, NOW + 6 * 3600_000);
  assert.equal(memory.block.retryAt, NOW + 24 * 3600_000);
  assert.equal(memory.block.retries, 10);
  assert.equal(
    normalizeMemory({ block: { kind: 'other', fingerprint: '0'.repeat(16) } }).block,
    null,
  );
});
