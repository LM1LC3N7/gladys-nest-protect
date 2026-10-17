// -----------------------------------------------------------------------------
// Detector -> Gladys device (pure). Read only: every feature is `read_only`,
// none is a `switch` (nothing an "everything off" could reach), and the
// integration has no command handler.
//
// External ids (forever): device `protect:<topaz id>` (the id of the
// `topaz.<id>` bucket, the one ha-nest-protect keys its entities on), and
// one feature per reading key below.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURE_NAMES, deviceName, word } from './i18n.js';
import { READINGS } from './model.js';

export const DEVICE_TYPE = 'protect';

/**
 * The features. `always`: published even before the detector reports the
 * value (smoke and CO are what the device is for); the others only once
 * their source field is seen. Types and units are those of the core
 * (server/utils/constants.js).
 */
export const SPECS = [
  {
    key: 'smoke',
    source: 'smoke_status',
    category: C.SMOKE_SENSOR,
    type: T.SENSOR.BINARY,
    always: true,
  },
  { key: 'co', source: 'co_status', category: C.CO_SENSOR, type: T.SENSOR.BINARY, always: true },
  { key: 'muted', source: 'hushed_state', category: C.SMOKE_SENSOR, type: T.SMOKE_SENSOR.MUTED },
  {
    key: 'battery',
    source: 'battery_level',
    category: C.BATTERY,
    type: T.BATTERY.INTEGER,
    unit: U.PERCENT,
    max: 100,
  },
  {
    key: 'battery_low',
    source: 'battery_health_state',
    category: C.BATTERY_LOW,
    type: T.BATTERY_LOW.BINARY,
  },
  { key: 'online', category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, keepHistory: true },
  { key: 'self_test', category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN },
  {
    key: 'last_test_days',
    source: 'latest_manual_test_end_utc_secs',
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.DAYS,
    max: 3650,
    keepHistory: false,
  },
  {
    key: 'night_light',
    source: 'night_light_enable',
    category: C.UNKNOWN,
    type: T.UNKNOWN.UNKNOWN,
  },
];

export const deviceIds = (gladys, id) => gladys.externalIds(DEVICE_TYPE, id);

/** Whether a feature applies to this detector (its source field seen, or always). */
function applies(spec, detector) {
  if (spec.always) {
    return true;
  }
  if (spec.key === 'online') {
    return detector.online !== undefined;
  }
  if (spec.key === 'self_test') {
    return READINGS.self_test(detector) !== undefined;
  }
  return spec.source in detector.value;
}

export function buildDevice(gladys, detector, language) {
  const ids = deviceIds(gladys, detector.id);
  const params = [
    ['model', detector.model],
    ['software_version', detector.software],
    ['power', detector.wired === undefined ? undefined : detector.wired ? 'wired' : 'battery'],
  ]
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([name, value]) => ({ name, value }));
  return {
    name: deviceName(detector.label),
    external_id: ids.device,
    should_poll: false,
    params,
    features: SPECS.filter((spec) => applies(spec, detector)).map((spec) => ({
      name: word(FEATURE_NAMES[spec.key], language),
      external_id: ids.feature(spec.key),
      category: spec.category,
      type: spec.type,
      ...(spec.unit ? { unit: spec.unit } : {}),
      min: 0,
      max: spec.max ?? 1,
      read_only: true,
      has_feedback: false,
      keep_history: spec.keepHistory ?? true,
    })),
  };
}

/** The current readings: `[{ device_feature_external_id, state }]` (unknown ones left out). */
export function deviceStates(gladys, detector, now) {
  const ids = deviceIds(gladys, detector.id);
  const states = [];
  for (const spec of SPECS) {
    const state = READINGS[spec.key](detector, now);
    if (typeof state === 'number' && Number.isFinite(state)) {
      states.push({ device_feature_external_id: ids.feature(spec.key), state });
    }
  }
  return states;
}
