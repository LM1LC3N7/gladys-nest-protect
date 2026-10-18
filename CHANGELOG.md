# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Google Nest Protect smoke and CO alarms, read only, through the unofficial
  API of the Nest web app (ported from ha-nest-protect, MIT). Not a
  certified alarm system: documented in bold, never to rely on for the
  safety of people.
- Sign-in with the issue_token and the cookies of a browser signed in to
  home.nest.com (two secret fields), as ha-nest-protect: Google access
  token, Nest JWT, Nest session. The issue_token is checked to be a Google
  iframerpc URL before anything is sent. The Nest session is kept in
  `/data` (never the cookies, the issue_token or the e-mail) and renewed
  before it ends; cookies rotated by Google are written back to the
  configuration.
- Per detector: smoke, carbon monoxide, alarm hushed, battery (%), battery
  to replace, online, self-test passed, days since the last manual test,
  night light (all read only; no command, no `switch`).
- Real-time updates: a full read at start and every hour, the Nest long
  poll in between (never a tight loop).
- Scene triggers "Smoke detected" and "CO detected", once per rise, with the
  level and the room.
- Resilience: refused cookies stop (kept in `/data`, never retried by
  itself); a refused Nest session is made again once, then spaced retries
  (1 h, 6 h, 24 h); 429 pauses (1 minute to 6 hours, kept in `/data`);
  2 minutes after a 502/504 of the long poll; network and 5xx errors retried
  after 15 s to 15 minutes. Badges "unreachable" when Nest is, or says a
  detector is offline.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.
- Scene triggers: a `level` filter (testing, warning, emergency), an event
  at every rise of the level (never on the way down), and a `delayed`
  variable on events sent again after Gladys did not take them (while the
  alarm lasts, 15 minutes at most).

### Fixed

- Rotated cookies of an earlier sign-in can no longer overwrite cookies the
  user has just saved; the saves to Gladys run one at a time, and a failed
  one is tried again at every read and reconnection (the old value coming
  back from Gladys meanwhile is not taken for new credentials).
- The long poll slows down on quick answers that move no revision (not only
  empty ones); two 502/504 in a row show "Nest unreachable" and grey badges.
- Online, self-test and night light are `unknown/binary`.
- Stricter checks: the issue_token path and `action`, cookies in visible
  ASCII; a Set-Cookie deleting a cookie is not taken; an unexpected sign-in
  answer twice in a row gets the spaced retries of a refused session; a
  session ending within 30 minutes is given one hour, and no new sign-in
  comes sooner than 10 minutes after the previous one (unless refused).
- The test button always shows a failure; the pause after an error is kept
  in `/data`; another issue_token forgets the previous account's devices.
- Docs: the Nest session token kept in `/data` gives access to the whole
  Nest account; an alarm rising and falling during an outage is not seen;
  an event may come late.

[Unreleased]: https://github.com/LM1LC3N7/gladys-nest-protect/commits/main
