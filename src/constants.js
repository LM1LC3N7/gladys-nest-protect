// -----------------------------------------------------------------------------
// Manifest keys, Nest / Google constants, limits and timings.
//
// The API is the one of the Nest web app (home.nest.com), undocumented. Hosts,
// paths, headers, the sign-in chain (Google issueToken with the browser
// cookies -> Nest JWT -> Nest session), the app_launch read and the
// long-polling subscription are those of ha-nest-protect (MIT,
// iMicknl/ha-nest-protect), pynest/const.py and pynest/client.py.
// -----------------------------------------------------------------------------

export const NEST = {
  /** NEST_ENVIRONMENTS[PRODUCTION].host of pynest. */
  host: 'https://home.nest.com',
  /** NEST_AUTH_URL_JWT of pynest. */
  jwtUrl: 'https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
  /** What a valid issue_token starts with (config_flow.py `_validate_issue_token`). */
  issueTokenPrefix: 'https://accounts.google.com/o/oauth2/iframerpc',
  /** Referer of the issueToken call (pynest `get_access_token_from_cookies`). */
  googleReferer: 'https://accounts.google.com/o/oauth2/iframe',
};

export const nestUrls = {
  session: () => `${NEST.host}/session`,
  /** APP_LAUNCH_URL_FORMAT of pynest. */
  appLaunch: (userId) => `${NEST.host}/api/0.1/user/${encodeURIComponent(userId)}/app_launch`,
  subscribe: (transportUrl) => `${transportUrl}/v6/subscribe`,
};

/**
 * The token of the Nest session is only ever sent to these hosts: the
 * transport URL comes from Nest's own answer, and is refused when it points
 * anywhere else.
 */
export const TRUSTED_TRANSPORT_HOSTS = [/^([a-z0-9-]+\.)*nest\.com$/];

/** USER_AGENT of pynest (a desktop browser: the web app's client). */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.120 Safari/537.36';

/**
 * The buckets asked at app_launch: Nest Protect (`topaz`), the room names
 * (`where`) and the online flag (`widget_track`, from FULL_NEST_REQUEST of
 * pynest). pynest also asks `kryptonite` (temperature sensors), `structure`
 * and `user`: not shown here, not asked.
 */
export const BUCKET_TYPES = ['topaz', 'where', 'widget_track'];

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** Manifest `scene_triggers` keys (forever: scenes store them). */
export const SCENE_TRIGGERS = {
  SMOKE: 'smoke_detected',
  CO: 'co_detected',
};

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** Gladys: 300 scene events per minute per integration. */
  sceneEventsPerMinute: 60,
  /** app_launch and subscribe answers. */
  responseBytes: 4 * 1024 * 1024,
  /** Google and Nest sign-in answers. */
  authBytes: 256 * 1024,
  /** Detectors published. */
  devices: 100,
  /** Buckets kept from one account. */
  buckets: 2000,
  /** The configuration values. */
  issueToken: 4096,
  cookies: 16 * 1024,
  /** Cookies kept in the cookie header. */
  cookieCount: 150,
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const TIMINGS = {
  requestTimeout: 20 * SECOND,
  /** The test button (60 s for Gladys, four requests at most): shorter requests. */
  quickTimeout: 10 * SECOND,
  /** pynest waits 600 s for an answer of the long poll; a margin on top. */
  subscribeTimeout: 10 * MINUTE + 30 * SECOND,
  /** Between two long polls: never a tight loop, even on empty answers. */
  subscribeGap: 2 * SECOND,
  /** A long poll back in less than this counts as quick... */
  quickReturn: 10 * SECOND,
  /** ...and after three quick ones in a row, this pause. */
  quickPause: MINUTE,
  /** 502 / 504 of the transport (pynest: "Updates paused for 2 minutes"). */
  servicePause: 2 * MINUTE,
  /** The Nest session is renewed when it ends within this (the long poll lasts up to 10 min). */
  sessionMargin: 15 * MINUTE,
  /** Nest session lifetime when its answer has no readable date, or one less than 30 min away. */
  sessionDefault: HOUR,
  sessionMinimum: 30 * MINUTE,
  /** No new sign-in sooner than this after the previous one, unless Nest refused the session. */
  signInSpacing: 10 * MINUTE,
  /** A full read (app_launch) again after this long, on top of the long poll. */
  trueUp: HOUR,
  /** A session refused within this long after it was made is not made again at once. */
  freshSession: 2 * MINUTE,
  /** Nest refused a session just made: one new try after 1 h, 6 h, then every 24 h. */
  sessionRetry: [HOUR, 6 * HOUR, 24 * HOUR],
  /**
   * Network, 5xx, unexpected answers: 15 s (a long poll cut after minutes
   * open is common), then 1, 2, 5, 10, and 15 minutes.
   */
  backoff: [15 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE],
  /** 429: Retry-After bounded to 1 minute .. 6 hours, 10 minutes without it. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 10 * MINUTE,
  /** A scene event Gladys did not take is sent again while the alarm lasts, this long at most. */
  sceneEventMaxAge: 15 * MINUTE,
  testCooldown: 30 * SECOND,
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
};
