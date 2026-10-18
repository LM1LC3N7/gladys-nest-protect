// -----------------------------------------------------------------------------
// Nest buckets -> detectors (pure). A bucket is `{ object_key, object_revision,
// object_timestamp, value }`; `topaz.<id>` is a Nest Protect, `where.<structure>`
// holds the room names, `widget_track.<id>` the online flag. The readings and
// the battery curve are those of ha-nest-protect (MIT): sensor.py,
// binary_sensor.py, entity.py.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const KEY = /^(topaz|where|widget_track)\.([A-Za-z0-9_-]{1,64})$/;

/** One bucket of an answer, checked; undefined when it is not one of ours. */
export function readBucket(raw) {
  const key = raw?.object_key;
  if (typeof key !== 'string' || !KEY.test(key)) {
    return undefined;
  }
  const revision = raw.object_revision;
  const timestamp = raw.object_timestamp;
  if (!Number.isFinite(revision) || !Number.isFinite(timestamp)) {
    return undefined;
  }
  return {
    object_key: key,
    object_revision: revision,
    object_timestamp: timestamp,
    value:
      raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value)
        ? raw.value
        : undefined,
  };
}

/**
 * The buckets merged with an answer: a newer revision replaces the bucket
 * (pynest keeps the answer's `objects` over the known ones). Bounded.
 */
export function mergeBuckets(known, objects) {
  const next = new Map(known);
  for (const raw of Array.isArray(objects) ? objects : []) {
    const bucket = readBucket(raw);
    if (!bucket) {
      continue;
    }
    const current = next.get(bucket.object_key);
    if (current && current.object_revision > bucket.object_revision) {
      continue;
    }
    if (!current && next.size >= LIMITS.buckets) {
      continue;
    }
    // A bucket without a value only moves its revision: the readings stay.
    next.set(bucket.object_key, { ...bucket, value: bucket.value ?? current?.value ?? {} });
  }
  return next;
}

/** What the long poll is given: the revision of every bucket known. */
export const subscription = (buckets) =>
  [...buckets.values()].map(({ object_key, object_revision, object_timestamp }) => ({
    object_key,
    object_revision,
    object_timestamp,
  }));

/** sensor.py SMOKE_CO_STATUS_TO_STATE: an unknown code is unknown, never "ok". */
export const ALARM_LEVELS = { 0: 'ok', 1: 'testing', 2: 'warning', 3: 'emergency' };

export const alarmLevel = (status) =>
  Number.isInteger(status) ? (ALARM_LEVELS[status] ?? 'unknown') : undefined;

/**
 * The severity of a status, for the scene triggers: 0 none, 1 testing,
 * 2 warning, 3 emergency; an unknown non-zero code counts as 1 (it is "on").
 */
export const alarmRank = (status) =>
  Number.isInteger(status)
    ? status === 0
      ? 0
      : status >= 1 && status <= 3
        ? status
        : 1
    : undefined;

/** binary_sensor.py: smoke and CO are "on" for any status but 0. */
export const alarmOn = (status) => (Number.isInteger(status) ? (status !== 0 ? 1 : 0) : undefined);

/**
 * sensor.py `milli_volt_to_percentage`: the battery voltage (mV) -> %, the
 * L91 battery slopes; undefined outside 3000-6000 mV.
 */
export function batteryPercent(mv) {
  if (!Number.isFinite(mv) || mv <= 3000 || mv > 6000) {
    return undefined;
  }
  let slope;
  let yint;
  if (mv > 4950) {
    slope = 0.001816609;
    yint = -8.548096886;
  } else if (mv > 4800) {
    slope = 0.000291667;
    yint = -0.991176471;
  } else if (mv > 4500) {
    slope = 0.001077342;
    yint = -4.730392157;
  } else {
    slope = 0.000434641;
    yint = -1.825490196;
  }
  return Math.max(0, Math.min(100, Math.round((slope * mv + yint) * 100)));
}

/** The component tests binary_sensor.py shows (heat left out there: "not valid"). */
export const SELF_TEST_COMPONENTS = [
  'component_smoke_test_passed',
  'component_co_test_passed',
  'component_wifi_test_passed',
  'component_led_test_passed',
  'component_pir_test_passed',
  'component_buzzer_test_passed',
  'component_speaker_test_passed',
  'component_hum_test_passed',
];

/** 1 when every component test the detector reports passed, 0 when one failed. */
export function selfTestPassed(value) {
  const results = SELF_TEST_COMPONENTS.map((k) => value?.[k]).filter((v) => typeof v === 'boolean');
  if (results.length === 0) {
    return undefined;
  }
  return results.every(Boolean) ? 1 : 0;
}

const bool = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : undefined);

/** Whole days since a UTC time in seconds; undefined when there is none. */
export function daysSince(seconds, now) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const days = Math.floor((now - seconds * 1000) / 86_400_000);
  return days >= 0 ? Math.min(days, 3650) : 0;
}

const text = (v, max = 60) =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined;

/** The room names of the account: where_id -> name. */
export function roomsOf(buckets) {
  const rooms = new Map();
  for (const bucket of buckets.values()) {
    if (!bucket.object_key.startsWith('where.')) {
      continue;
    }
    for (const where of Array.isArray(bucket.value.wheres) ? bucket.value.wheres : []) {
      const id = text(where?.where_id, 100);
      const name = text(where?.name);
      if (id && name) {
        rooms.set(id, name);
      }
    }
  }
  return rooms;
}

/**
 * The detectors of the buckets: `{ id, value, label, online, wired }`.
 * `online`: `widget_track.<id>.online`, else `is_online` of the topaz bucket,
 * else undefined (never guessed).
 */
export function detectorsOf(buckets) {
  const rooms = roomsOf(buckets);
  const detectors = new Map();
  for (const bucket of buckets.values()) {
    const match = KEY.exec(bucket.object_key);
    if (!match || match[1] !== 'topaz') {
      continue;
    }
    const id = match[2];
    const value = bucket.value;
    const track = buckets.get(`widget_track.${id}`)?.value;
    const online =
      typeof track?.online === 'boolean'
        ? track.online
        : typeof value.is_online === 'boolean'
          ? value.is_online
          : undefined;
    detectors.set(id, {
      id,
      value,
      label: text(value.description) ?? rooms.get(value.where_id),
      online,
      wired: value.wired_or_battery === 0 ? true : value.wired_or_battery === 1 ? false : undefined,
      model: text(value.model, 40),
      software: text(value.software_version, 40),
    });
  }
  return detectors;
}

/** Each reading of a detector, a number or undefined (unknown: nothing published). */
export const READINGS = {
  smoke: (d) => alarmOn(d.value.smoke_status),
  co: (d) => alarmOn(d.value.co_status),
  muted: (d) => bool(d.value.hushed_state),
  battery: (d) => batteryPercent(d.value.battery_level),
  battery_low: (d) =>
    Number.isInteger(d.value.battery_health_state)
      ? d.value.battery_health_state !== 0
        ? 1
        : 0
      : undefined,
  online: (d) => bool(d.online),
  self_test: (d) => selfTestPassed(d.value),
  last_test_days: (d, now) => daysSince(d.value.latest_manual_test_end_utc_secs, now),
  night_light: (d) => bool(d.value.night_light_enable),
};
