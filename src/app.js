// -----------------------------------------------------------------------------
// The integration, read only: the Google cookies and issue_token, the Nest
// session (kept in /data), a full read (app_launch) at start and every hour,
// and in between the long poll of the Nest web app (an answer as soon as a
// detector changes, at the latest after about 10 minutes). The Gladys devices
// and their states, the "smoke detected" and "CO detected" scene triggers,
// the transport badges, the test button. index.js only wires the SDK handlers
// to it. There is no command: nothing is ever sent to a detector.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { NestClient } from './client.js';
import { configProblem, normalizeConfig } from './config.js';
import { LIMITS, MINUTE, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import { buildDevice, deviceIds, deviceStates } from './devices.js';
import { NestError, errorReason } from './http.js';
import { T, age, join } from './i18n.js';
import {
  READINGS,
  alarmLevel,
  alarmRank,
  detectorsOf,
  mergeBuckets,
  subscription,
} from './model.js';
import { StatePublisher } from './publisher.js';
import { fileStore, fingerprint, newSalt, normalizeMemory } from './store.js';

/** The status message of a configuration that cannot be tried. */
const PROBLEM_MESSAGES = {
  no_credentials: T.noCredentials,
  bad_issue_token: T.badIssueToken,
  bad_cookies: T.badCookies,
};
/** The fields of a Gladys feature that a publication carries. */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];
/** The scene trigger of each alarm reading. */
const ALARMS = [
  { reading: 'smoke', status: 'smoke_status', trigger: SCENE_TRIGGERS.SMOKE },
  { reading: 'co', status: 'co_status', trigger: SCENE_TRIGGERS.CO },
];

export class NestProtectApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'nest-protect' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new NestClient({
      transport,
      now,
      onCookies: (cookies, origin) => this.saveCookies(cookies, origin),
      onSession: () => this.persistSession(),
    });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** Every bucket known: object_key -> bucket. */
    this.buckets = new Map();
    /** The detectors of the buckets: topaz id -> detector (src/model.js). */
    this.detectors = new Map();
    /** Every device published in this run, by external id: a publication never shrinks. */
    this.known = new Map();
    /** topaz id -> { smoke, co }: the last alarm ranks (0 none, 1 testing, 2 warning, 3 emergency). */
    this.alarms = new Map();
    this.sceneWindow = [];
    /** Scene events Gladys did not take: { key, data, at, detectorId, reading }, sent again later. */
    this.pendingEvents = [];
    this.published = undefined;
    this.badges = new Map();
    this.timer = undefined;
    this.running = undefined;
    this.abort = undefined;
    this.generation = 0;
    /** undefined | 'refused' | 'session_refused' */
    this.blocked = undefined;
    this.sessionRetries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.failures = 0;
    this.pausedUntil = 0;
    /** 'rate' (a 429), 'service' (502/504 of the long poll) or 'backoff'. */
    this.pauseKind = undefined;
    this.launchedAt = -Infinity;
    this.quickReturns = 0;
    /** When the last Nest session was made (see `fresh`). */
    this.signedInAt = -Infinity;
    this.lastTestAt = -Infinity;
    /** The cookies Gladys really holds (the last value read from it or saved to it). */
    this.storedCookies = undefined;
    /** Rotated cookies not saved to Gladys yet (tried again at every run and reconnection). */
    this.pendingCookies = undefined;
    /** The setConfig calls, one after the other. */
    this.cookieWrites = Promise.resolve();
    /** 502/504 of the long poll in a row. */
    this.gatewayFailures = 0;
    this.started = false;
    this.lastStatus = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.running;
    const previousToken = this.config.issueToken;
    this.config = normalizeConfig(raw);
    this.reset({ newAccount: this.config.issueToken !== previousToken });
    this.storedCookies = this.config.cookies;
    this.pendingCookies = undefined;
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    if (!this.memory.salt) {
      this.memory.salt = newSalt();
      await this.saveMemory();
    }
    // A 429 pause survives a restart and new credentials.
    if (this.memory.rateLimitedUntil > this.now()) {
      this.pausedUntil = this.memory.rateLimitedUntil;
      this.pauseKind = 'rate';
    }
    // So does the pause of an error: a restart never reads sooner.
    if (this.memory.pausedUntil > Math.max(this.now(), this.pausedUntil)) {
      this.pausedUntil = this.memory.pausedUntil;
      this.pauseKind = 'backoff';
    }
    const problem = configProblem(this.config);
    if (problem) {
      this.client.configure({ issueToken: '', cookies: '', session: null });
      await this.setStatus(false, PROBLEM_MESSAGES[problem]);
      return;
    }
    const saved = this.memory.session;
    this.client.configure({
      issueToken: this.config.issueToken,
      cookies: this.config.cookies,
      session: saved && saved.account === this.account ? withoutAccount(saved) : null,
      tag: this.generation,
    });
    this.publisher.start();
    // A stop on these very credentials survives a restart (never retried by itself).
    const block = this.memory.block;
    if (block && block.fingerprint === this.credentials) {
      this.blocked = block.kind;
      this.retryAt = block.retryAt ?? 0;
      this.sessionRetries = block.retries;
      if (block.kind === 'refused') {
        await this.setStatus(false, T.refused);
        return;
      }
      await this.setStatus(false, T.sessionRefused(age(Math.max(0, this.retryAt - this.now()))));
      this.scheduleNext();
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.connecting);
    this.scheduleNext(0);
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.abort?.abort();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Forgets the account and the failures: new credentials, or a restart. A
   * 429 pause stays. Another account (a new issue_token): its devices only.
   */
  reset({ newAccount = false } = {}) {
    if (newAccount) {
      this.known = new Map();
    }
    this.pendingEvents = [];
    this.gatewayFailures = 0;
    this.buckets = new Map();
    this.detectors = new Map();
    this.alarms = new Map();
    this.published = undefined;
    this.badges = new Map();
    this.blocked = undefined;
    this.sessionRetries = 0;
    this.retryAt = 0;
    this.offline = false;
    this.failures = 0;
    this.launchedAt = -Infinity;
    this.quickReturns = 0;
    if (this.pauseKind !== 'rate' || this.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
    }
  }

  /** Which account a persisted session belongs to: a salted hash of the issue_token. */
  get account() {
    return fingerprint(this.memory.salt ?? '', this.config.issueToken);
  }

  /** Which credentials a stop belongs to: a salted hash of the issue_token and the cookies. */
  get credentials() {
    return fingerprint(this.memory.salt ?? '', this.config.issueToken, this.config.cookies);
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges). The pauses, the stops and the session stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    await this.retryPending();
    this.published = undefined;
    this.badges = new Map();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** New credentials restart; a new language renames the devices added from now on. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    const sameAccount = next.issueToken === previous.issueToken;
    if (sameAccount && next.cookies === previous.cookies) {
      // Gladys holds what the integration uses (an echo of a saved rotation, or no change).
      this.storedCookies = next.cookies;
      if (this.pendingCookies === next.cookies) {
        this.pendingCookies = undefined;
      }
    } else if (sameAccount && next.cookies === this.storedCookies) {
      // Gladys still holds the cookies Google rotated away from (their save is
      // pending): not new credentials, the rotated ones stay.
      next.cookies = previous.cookies;
    } else {
      return this.start(raw);
    }
    this.config = next;
    if (next.language !== previous.language) {
      await this.publishDevices();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** The Nest session of the client, with its account; written only when it changed. */
  async persistSession() {
    const s = this.client.session;
    const next = s?.accessToken
      ? {
          account: this.account,
          accessToken: s.accessToken,
          userId: s.userId,
          expiresAt: s.expiresAt,
          transportUrl: s.transportUrl,
        }
      : null;
    if (JSON.stringify(next) === JSON.stringify(this.memory.session)) {
      return;
    }
    this.memory.session = next;
    await this.saveMemory();
  }

  /**
   * Google rotated some cookies: they go back to the configuration (the
   * `cookies` secret field, where they came from), never to /data nor to a
   * log, so a restart uses them (ha-nest-protect saves them the same way).
   */
  saveCookies(cookies, { sent, tag } = {}) {
    // A rotation of cookies the user has replaced since (or of another start) never wins.
    if (tag !== this.generation || this.config.cookies !== sent) {
      this.logger.info('Rotated cookies of a previous configuration: ignored');
      return Promise.resolve();
    }
    this.config = { ...this.config, cookies };
    this.pendingCookies = cookies;
    return this.writeCookies();
  }

  /** The pending cookies saved to Gladys, one setConfig at a time. */
  writeCookies() {
    this.cookieWrites = this.cookieWrites
      .then(() => this.writeCookiesNow())
      .catch((err) => this.logger.warn(`Saving the rotated cookies failed: ${err.message}`));
    return this.cookieWrites;
  }

  async writeCookiesNow() {
    const value = this.pendingCookies;
    if (value === undefined) {
      return;
    }
    if (value !== this.config.cookies) {
      // Replaced meanwhile (new credentials): nothing of this value is saved.
      this.pendingCookies = undefined;
      return;
    }
    const generation = this.generation;
    try {
      await this.gladys.setConfig({ cookies: value });
    } catch (err) {
      this.logger.warn(`Saving the rotated cookies failed (tried again later): ${err.message}`);
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.storedCookies = value;
    if (this.pendingCookies === value) {
      this.pendingCookies = undefined;
    }
    this.logger.info('Google rotated some cookies: the configuration was updated');
  }

  /** What Gladys did not take yet: the rotated cookies, the scene events. */
  async retryPending() {
    if (this.pendingCookies !== undefined) {
      await this.writeCookies();
    }
    await this.replayEvents();
  }

  /** Keeps the current stop (or none) in /data, tied to the credentials. */
  async saveBlock() {
    const block = this.blocked
      ? {
          kind: this.blocked,
          fingerprint: this.credentials,
          retryAt: this.blocked === 'session_refused' ? this.retryAt : undefined,
          retries: this.sessionRetries,
        }
      : null;
    if (JSON.stringify(block) !== JSON.stringify(this.memory.block ?? null)) {
      this.memory.block = block;
      await this.saveMemory();
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- The read loop -----------------------------------------------------------

  scheduleNext(delay = 0) {
    this.clearTimer();
    if (configProblem(this.config)) {
      return;
    }
    const now = this.now();
    let wait;
    if (this.blocked === 'session_refused') {
      wait = Math.max(this.retryAt, this.pausedUntil) - now;
    } else if (this.blocked) {
      return;
    } else {
      wait = Math.max(delay, this.pausedUntil - now);
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Nest read failed: ${err.message}`));
        }
      },
      Math.max(0, wait),
    );
  }

  /** One run at a time: a tick during a run joins it. `quick`: for the button. */
  tick({ quick = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false } = {}) {
    const generation = this.generation;
    if (configProblem(this.config)) {
      return;
    }
    await this.retryPending();
    if (this.blocked === 'session_refused' && this.now() >= this.retryAt) {
      this.logger.info('Nest: trying the session again');
      this.blocked = undefined;
      this.client.dropSession();
    }
    if (this.blocked || this.now() < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    let gap = 0;
    this.client.timeout = quick ? TIMINGS.quickTimeout : undefined;
    try {
      gap = await this.step({ quick, generation });
    } catch (err) {
      if (generation !== this.generation || err?.kind === 'aborted') {
        return;
      }
      await this.failed(err, { quick });
    } finally {
      this.client.timeout = undefined;
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadges();
    await this.flush();
    this.scheduleNext(gap ?? 0);
  }

  /**
   * One step: a session if needed, a full read when due (or for the button),
   * then one long poll. Resolves the delay before the next step.
   */
  async step({ quick, generation }) {
    // A session about to end is made again, but never sooner than 10 minutes
    // after the previous one (a refused session is made again in `authorized`).
    if (
      !this.client.hasSession ||
      (!this.client.sessionFresh && this.now() - this.signedInAt >= TIMINGS.signInSpacing)
    ) {
      await this.signIn();
    }
    if (quick || this.now() - this.launchedAt >= TIMINGS.trueUp) {
      const list = await this.authorized(() => this.client.appLaunch());
      if (generation !== this.generation) {
        return undefined;
      }
      this.launchedAt = this.now();
      await this.apply(mergeBuckets(new Map(), list));
      // The spaced retries of a refused session end on a working long poll only.
      await this.succeeded({ keepRetries: true });
      if (quick) {
        return TIMINGS.subscribeGap;
      }
    }
    if (this.detectors.size === 0) {
      // Nothing to watch: a full read again in an hour, no long poll.
      return TIMINGS.trueUp;
    }
    const started = this.now();
    const before = JSON.stringify(subscription(this.buckets));
    let objects;
    this.abort = new AbortController();
    try {
      objects = await this.authorized(() =>
        this.client.subscribe(subscription(this.buckets), { signal: this.abort.signal }),
      );
    } catch (err) {
      if (err?.kind !== 'timeout') {
        throw err;
      }
      // Nest kept the long poll open without an answer: poll again (pynest).
      objects = [];
    } finally {
      this.abort = undefined;
    }
    if (generation !== this.generation) {
      return undefined;
    }
    const merged = mergeBuckets(this.buckets, objects);
    const progressed = JSON.stringify(subscription(merged)) !== before;
    if (objects.length > 0) {
      await this.apply(merged);
    } else {
      // The day counters move without any new bucket.
      this.queueStates();
    }
    this.gatewayFailures = 0;
    await this.succeeded();
    // Never a tight loop: answers that move no revision, coming back at once, slow down.
    const quickEmpty = !progressed && this.now() - started < TIMINGS.quickReturn;
    this.quickReturns = quickEmpty ? this.quickReturns + 1 : 0;
    return this.quickReturns >= 3 ? TIMINGS.quickPause : TIMINGS.subscribeGap;
  }

  async signIn() {
    await this.client.signIn();
    this.signedInAt = this.now();
  }

  /** A session made a moment ago: refused now, making another would only loop. */
  get fresh() {
    return this.now() - this.signedInAt < TIMINGS.freshSession;
  }

  /**
   * A read with the session: a session Nest refuses (401/403) is made again
   * once (Google, then Nest) and the read tried once more. Refused again, or
   * refused right after being made: `nest_refused`, never a loop.
   */
  async authorized(read) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await read();
      } catch (err) {
        if (err?.kind !== 'unauthorized') {
          throw err;
        }
        // A session made a moment ago (or twice in this read): never another one now.
        if (this.fresh || attempt >= 2) {
          throw new NestError('nest_refused', 'Nest refused the session it had just given', {
            status: err.status,
          });
        }
      }
      this.logger.info('Nest refused the session: a new one is made');
      this.client.dropSession();
      await this.signIn();
    }
  }

  async succeeded({ keepRetries = false } = {}) {
    this.failures = 0;
    if (!keepRetries) {
      this.sessionRetries = 0;
    }
    this.offline = false;
    this.pauseKind = undefined;
    if (this.memory.pausedUntil !== undefined) {
      this.memory.pausedUntil = undefined;
      await this.saveMemory();
    }
    await this.saveBlock();
    await this.setStatus(true, T.connected(this.detectors.size));
    // Before the long poll, which may stay open for minutes.
    await this.publishBadges();
    await this.flush();
  }

  async failed(err, { quick = false } = {}) {
    const reason = errorReason(err);
    const kind = err instanceof NestError ? err.kind : 'unexpected';
    if (kind === 'refused' || kind === 'no_credentials') {
      // The cookies are dead: asking Google again would only be refused again.
      this.blocked = 'refused';
      this.clearTimer();
      this.client.dropSession();
      await this.saveBlock();
      this.logger.warn(`Nest stopped: ${reason}`);
      await this.setStatus(false, T.refused);
      return;
    }
    if (kind === 'nest_refused') {
      const wait =
        TIMINGS.sessionRetry[Math.min(this.sessionRetries, TIMINGS.sessionRetry.length - 1)];
      this.sessionRetries += 1;
      this.blocked = 'session_refused';
      this.retryAt = this.now() + wait;
      this.client.dropSession();
      await this.saveBlock();
      this.logger.warn(`Nest: ${reason}; one new try in ${Math.round(wait / MINUTE)} min`);
      await this.setStatus(false, T.sessionRefused(age(wait)));
      return;
    }
    if (kind === 'rate_limited') {
      const wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      this.pauseKind = 'rate';
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.memory.rateLimitedUntil = this.pausedUntil;
      await this.saveMemory();
      this.logger.warn(`Nest: ${reason}; paused for ${Math.round(wait / 1000)} s`);
      await this.setStatus(false, T.rateLimited(age(wait)));
      return;
    }
    if (kind === 'gateway') {
      // pynest: "Nest Service error. Updates paused for 2 minutes."
      this.gatewayFailures += 1;
      this.pauseKind = 'service';
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + TIMINGS.servicePause);
      await this.savePause();
      this.logger.info(`Nest: ${reason}; long poll again in 2 min`);
      // One is common; two in a row: the states shown may be old.
      if (this.gatewayFailures >= 2) {
        this.offline = true;
      }
      if (this.gatewayFailures >= 2 || quick) {
        await this.setStatus(false, T.unreachable(reason, age(TIMINGS.servicePause)));
      }
      return;
    }
    const wait = TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)];
    this.failures += 1;
    // Back from a failure: a full read first (it also shows the way back at once).
    this.launchedAt = -Infinity;
    // One cut long poll is common: the badges turn grey from the second failure in a row.
    this.offline = this.failures >= 2;
    this.pauseKind = 'backoff';
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    await this.savePause();
    this.logger.warn(`Nest: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    // The button always shows what happened.
    if (this.failures >= 2 || quick) {
      await this.setStatus(false, T.unreachable(reason, age(wait)));
    }
  }

  /** The end of an error's pause, kept in /data (a restart never reads sooner). */
  async savePause() {
    this.memory.pausedUntil = this.pausedUntil;
    await this.saveMemory();
  }

  // --- Gladys ----------------------------------------------------------------

  /** New buckets: the detectors, their devices and states, and the scene triggers. */
  async apply(buckets) {
    this.buckets = buckets;
    this.detectors = detectorsOf(buckets);
    await this.publishDevices();
    this.queueStates();
    await this.fireAlarms();
  }

  createdDevices() {
    return new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /**
   * The detectors of the last read, merged so that nothing ever disappears: a
   * created device keeps its features as Gladys has them (types and units
   * are fixed at creation), plus any new one; a device or a feature seen
   * earlier in this run stays published.
   */
  async publishDevices() {
    const created = this.createdDevices();
    for (const detector of this.detectors.values()) {
      const fresh = buildDevice(this.gladys, detector, this.config.language);
      const previous = this.known.get(fresh.external_id);
      const mine = created.get(fresh.external_id);
      const features = new Map();
      for (const f of mine?.features ?? []) {
        features.set(
          f.external_id,
          Object.fromEntries(
            FEATURE_FIELDS.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
          ),
        );
      }
      for (const f of [...(previous?.features ?? []), ...fresh.features]) {
        if (!features.has(f.external_id)) {
          features.set(f.external_id, f);
        }
      }
      if (!previous && this.known.size >= LIMITS.devices) {
        continue;
      }
      this.known.set(fresh.external_id, { ...fresh, features: [...features.values()] });
    }
    const list = [...this.known.values()];
    const json = JSON.stringify(list);
    if (list.length === 0 || json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  queueStates(created = this.createdFeatures()) {
    const now = this.now();
    for (const detector of this.detectors.values()) {
      for (const { device_feature_external_id: id, state } of deviceStates(
        this.gladys,
        detector,
        now,
      )) {
        if (created.has(id)) {
          this.publisher.push(id, { state });
        }
      }
    }
  }

  /**
   * "Smoke detected" / "CO detected": once per rise of the severity (testing
   * < warning < emergency), from none or from unknown (the first read after a
   * start that finds an alarm fires too, a missed alarm being worse than a
   * repeated one). Never on the way down, never again while it stays.
   */
  async fireAlarms() {
    for (const detector of this.detectors.values()) {
      const before = this.alarms.get(detector.id) ?? {};
      const after = {};
      for (const alarm of ALARMS) {
        const rank = alarmRank(detector.value[alarm.status]);
        if (rank === undefined) {
          after[alarm.reading] = before[alarm.reading];
          continue;
        }
        after[alarm.reading] = rank;
        if (rank > (before[alarm.reading] ?? 0)) {
          await this.sceneEvent(
            alarm.trigger,
            {
              device: deviceIds(this.gladys, detector.id).device,
              level: alarmLevel(detector.value[alarm.status]),
              room: detector.label ?? '',
              delayed: false,
            },
            { detectorId: detector.id, reading: alarm.reading },
          );
        }
      }
      this.alarms.set(detector.id, after);
    }
  }

  async sceneEvent(key, data, origin) {
    const now = this.now();
    this.sceneWindow = this.sceneWindow.filter((t) => now - t < MINUTE);
    if (this.sceneWindow.length >= LIMITS.sceneEventsPerMinute) {
      this.logger.warn(`Too many scene events this minute: ${key} dropped`);
      return;
    }
    this.sceneWindow.push(now);
    this.logger.info(`Scene event ${key} (${data.level})`);
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      // Sent again (with `delayed`) at the next run or reconnection, while the alarm lasts.
      this.pendingEvents.push({ key, data, at: now, ...origin });
      this.logger.warn(`Scene event ${key} not sent, kept for later: ${err.message}`);
    }
  }

  /** The scene events Gladys did not take, sent again while their alarm lasts (15 min at most). */
  async replayEvents() {
    if (this.pendingEvents.length === 0) {
      return;
    }
    const now = this.now();
    const list = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of list) {
      const detector = this.detectors.get(event.detectorId);
      if (
        now - event.at > TIMINGS.sceneEventMaxAge ||
        !detector ||
        READINGS[event.reading](detector) !== 1
      ) {
        continue;
      }
      try {
        await this.gladys.publishSceneEvent(event.key, { ...event.data, delayed: true });
        this.logger.info(`Scene event ${event.key} sent late`);
      } catch {
        this.pendingEvents.push(event);
      }
    }
  }

  /** One badge per created device: cloud, or unreachable (stopped, offline, or offline for Nest). */
  async publishBadges() {
    const entries = [];
    const sources = new Map(
      [...this.detectors.values()].map((d) => [deviceIds(this.gladys, d.id).device, d]),
    );
    for (const device of this.gladys.devices ?? []) {
      if (!this.known.has(device.external_id)) {
        continue;
      }
      const source = sources.get(device.external_id);
      const unreachable = this.blocked || this.offline || !source || source.online === false;
      const transport = unreachable ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD;
      if (this.badges.get(device.external_id) !== transport) {
        entries.push({ external_id: device.external_id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.badges.set(entry.external_id, entry.transport);
        }
      } catch (err) {
        this.logger.warn(`Transport badges failed: ${err.message}`);
      }
    }
  }

  async deviceCreated(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
    }
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the detectors of the last read (no extra request). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  /** Every Gladys command is refused: the integration is read only. */
  async setValue() {
    throw new Error('Nest Protect is read only in Gladys: no command is sent to a detector.');
  }

  // --- Configuration button --------------------------------------------------

  /** A 429 pause holds for every path, the button included. */
  pauseMessage() {
    const left = this.pausedUntil - this.now();
    return left > 0 && this.pauseKind === 'rate' ? T.rateLimited(age(left)) : undefined;
  }

  async testConnection() {
    const problem = configProblem(this.config);
    if (problem) {
      return PROBLEM_MESSAGES[problem];
    }
    const paused = this.pauseMessage();
    if (paused) {
      return paused;
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.cooldown, last) : T.cooldown;
    }
    if (this.running && !this.abort) {
      // A sign-in or a full read is under way.
      return T.busy;
    }
    this.lastTestAt = this.now();
    // One try per click: the button is how a stopped account is retried.
    this.blocked = undefined;
    this.sessionRetries = 0;
    this.pausedUntil = 0;
    this.pauseKind = undefined;
    this.memory.pausedUntil = undefined;
    await this.saveBlock();
    await this.saveMemory();
    this.clearTimer();
    // The long poll under way is cut, then one sign-in if needed and one full read.
    this.abort?.abort();
    await this.running;
    await this.tick({ quick: true });
    return this.lastMessage ?? T.connecting;
  }
}

const withoutAccount = ({ account: _account, ...session }) => session;
