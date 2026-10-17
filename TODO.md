# TODO — Nest Protect v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (post #262, lot 7) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-18): cookie sign-in ported from
      ha-nest-protect (issue_token + cookies → Google token → Nest JWT →
      Nest session), session kept in `/data`, app_launch at start / after a
      failure / hourly, long poll in between, read-only detectors (smoke,
      CO, hush, battery, battery to replace, online, self-test, days since
      the last manual test, night light), scene triggers "smoke detected"
      and "CO detected", persisted stops and pauses, badges, test button,
      docs en/fr, cover. Tested against made-up answers only (Node 22 and
      24). No Docker on this PC: the image was not built here (the CI
      builds it).
- [ ] **Milestone 2 — real account**: run against a real account (see "To
      check on a real account"), turn the answers (anonymized) into
      fixtures, fix what differs.
- [ ] **Later (needs a decision)**: heat (`heat_status`, no core category),
      replacement date (`replace_by_date_utc_secs`), wired Protect
      occupancy and line power, night light brightness, Nest temperature
      sensors (`kryptonite`), the Chrome extension code of ha-nest-protect
      (one field instead of two). Commands (hush, test) only behind an
      option off by default, as `button/push`, if ever.

## To check on a real account

- The issueToken answer: `access_token`, the `Set-Cookie` headers (which
  cookies rotate, how often), and what an expired or signed-out session
  answers (`USER_LOGGED_OUT` at 200, or a 4xx?).
- The Nest session: the `expires_in` format (`Sun, 17-Nov-2026 10:00:00 GMT`
  parsed; one hour assumed otherwise) and its real lifetime.
- `app_launch` with `widget_track`: is the online flag there
  (`widget_track.<topaz id>.value.online`)? pynest's NEST_REQUEST does not
  ask it, its FULL_NEST_REQUEST does; `is_online` in the topaz bucket is the
  fallback ha-nest-protect reads. Without either, no "online" feature.
- The topaz ids: the key suffix of `topaz.<id>` (used for the external id);
  check it is stable and matches `[A-Za-z0-9_-]{1,64}`.
- The long poll: how long Nest holds it, what an empty answer looks like
  (`text/plain` at 200 handled), how often 502/504 come.
- The smoke / CO status codes: 1 is "testing" for ha-nest-protect's enum
  sensor but "on" for its binary sensor (kept: any non-zero is 1).
- The battery curve on a wired Protect (backup battery).
- Whether `setConfig` of a `secret` field is accepted by the core and does
  not echo a restart (handled: the same cookies do not restart).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-nest-protect:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **License**: ha-nest-protect is MIT (Mick Vleeshouwer, 2022), checked
  before use; its logic is ported (full notice in `THIRD_PARTY_NOTICES.md`,
  shipped in the image). `LICENSE`: the standard Apache-2.0 text, no name.
- **No duplicate**: gladys-google-nest (SDM API) does not cover the Protect
  (Google's SDM has no smoke alarm trait); checked by the brief.
- **Read only**: no write call exists in the client; `onSetValue` refuses;
  every feature `read_only`, none a `switch` (an "everything off" of a voice
  assistant or a scene can reach nothing). ha-nest-protect's night light
  switch and brightness select are not ported.
- **Categories** (core `server/utils/constants.js`): smoke
  `smoke-sensor/binary`, CO `co-sensor/binary` (no unit: `ppm` is for a
  level), hush `smoke-sensor/muted` (the core's own type for a detector
  silencing itself), battery `battery/integer` %, battery to replace
  `battery-low/binary`, days since the last manual test
  `duration/integer` days, online / self-test / night light `unknown/unknown`
  0/1 (no core category fits; never `switch`).
- **Smoke / CO = 1 for any status but 0** (ha-nest-protect's binary
  sensors), "testing" included: a test shows and fires the scene trigger, as
  documented. An unknown or missing status publishes nothing (never 0).
- **Scene triggers**: `smoke_detected`, `co_detected`, once per rise to 1
  (from 0 or from unknown: the first read after a start that finds an alarm
  fires once, a missed alarm being worse than a repeated one), never on the
  way back, never while it stays 1; `device` filter, `level` and `room`
  variables; at most 60 events a minute.
- **Credentials**: two `secret` fields (`issue_token`, `cookies`), as
  ha-nest-protect's manual method; the extension's combined code is not
  accepted (later). The issue_token must be an `https://accounts.google.com/o/oauth2/iframerpc`
  URL with `action=issueToken` and the cookies must hold a Google sign-in
  cookie, checked before any request: the cookies never go anywhere else.
  A leading `cookie:` copied from the browser is dropped. The refresh-token
  method of ha-nest-protect (dead since Google removed it) is not ported.
- **Rotated cookies**: merged in memory (pynest `merge_cookies`) and written
  back to the `cookies` field with `gladys.setConfig` (ha-nest-protect
  updates its config entry the same way), never to `/data`; the echoed
  configuration does not restart (same cookies). A failed `setConfig` is
  only logged (without the value).
- **/data** (the brief: "only the token strictly needed"): the Nest session
  (access token, user id, end, transport URL) so a restart does not ask
  Google again (ha-nest-protect's `NestSessionManager` keeps it too), tied
  to a salted fingerprint of the issue_token; the stop tied to a salted
  fingerprint of the issue_token and the cookies; the 429 end. Never the
  cookies, the issue_token, the Google token, the JWT, nor the e-mail
  (`/session` returns it: dropped).
- **Refusals** (lesson: never a loop): Google refusing the cookies
  (`USER_LOGGED_OUT`, any other error, any non-transient 4xx) → the
  `refused` stop, persisted, until new credentials or the button. Nest
  refusing the session (401/403 on app_launch or the long poll) → the
  session is made again once (Google, JWT, session) and the read retried;
  refused within 2 minutes of being made (or the JWT / session step itself
  refused) → `session_refused`: one new try after 1 h, 6 h, then every 24 h,
  persisted; the retry count is reset only by a working long poll.
  ha-nest-protect retries three times with 30–120 s backoff then asks for a
  re-auth; here no re-auth flow exists, so the spaced retries replace it.
- **Long poll** (pynest `subscribe_for_data`): the known revisions of every
  bucket, 10 min 30 s client timeout (pynest: 600 s); a timeout or an empty
  `text/plain` answer → poll again; at least 2 s between two polls, one
  minute after three quick (< 10 s) empty answers in a row (pynest has no
  floor). 502/504 → 2 minutes (pynest). Network, 5xx, unexpected answers →
  15 s, 1, 2, 5, 10, 15 min (pynest retries at once on disconnects: a floor
  added); the next try starts with a full read; status and badges
  "unreachable" from the second failure in a row (a long poll cut after
  minutes open is common). 429 → `Retry-After` bounded to 1 min – 6 h,
  10 min without it, persisted. A long poll in progress is cut (AbortSignal)
  by a stop and by the button.
- **Full read** (`app_launch`, buckets `topaz`, `where`, `widget_track`): at
  start, after any failure, every hour, and on the button; pynest also asks
  `kryptonite`, `structure`, `user` (not used). An account without a Protect
  gets no long poll, only the hourly read.
- **Transport URL**: accepted only over HTTPS on `*.nest.com` (from the
  session or app_launch), so the session token never goes elsewhere.
- **Session renewal**: 15 minutes before its end (the long poll lasts up to
  10 min); ha-nest-protect renews 5 minutes before.
- **Device ids**: `protect:<topaz id>` (the `topaz.<id>` key ha-nest-protect
  keys its entities on), not the serial number (not always present).
  Name "Nest Protect (<description or room>)". Params: model, software
  version, power (wired / battery).
- **Battery**: ha-nest-protect's L91 voltage curve (mV → %), unknown outside
  3000–6000 mV (nothing published).
- **Self-test**: 1 when every component test ha-nest-protect shows passed
  (smoke, CO, Wi-Fi, LED, PIR, buzzer, speaker, humidity; heat left out as
  there), 0 when one failed.
- **Publication never shrinks** (lot 6 lesson): a created device keeps its
  features as Gladys has them; a feature appears once its source field is
  seen (smoke and CO always).
- **Category `security`** in the store.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved
  (post #262).
