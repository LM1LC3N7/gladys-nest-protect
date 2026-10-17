# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTPS goes through `node:https`). It signs in to the Nest
web app's unofficial API with the issue_token and the cookies of a browser
signed in to home.nest.com, and shows the Google Nest Protect smoke and CO
alarms **read only**, in real time (long poll), with two scene triggers.
Ported from ha-nest-protect (MIT). **Not a certified alarm system.** Never
tested with a real account, not affiliated with Google or Nest.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          NestProtectApp: the read loop (sign-in, app_launch, long poll),
                    failures, stops and pauses, devices, states, scene events, badges, button
src/client.js       the account: Google token, Nest JWT, Nest session, app_launch, subscribe
src/http.js         the only network access (node:https, bounded, cancellable), errors
src/model.js        buckets -> detectors, readings (pure)
src/devices.js      detector -> Gladys device and states (pure)
src/publisher.js    states within 300/min
src/store.js        /data/nest-protect-state.json: Nest session, stop, 429 pause
src/config.js       config_schema normalized and checked before any request
src/constants.js    hosts, paths, manifest keys, limits, timings
src/i18n.js         runtime texts and feature names (en/fr)
test/helpers/       a fake Google + Nest behind the transport; Gladys is the SDK's fake
```

## Rules

- **Read only, forever in v1**: no write call in `NestClient`, no writable
  feature, no `switch`; `onSetValue` refuses. A future command (hush, test)
  needs a decision of the maintainer, a `button/push` (never a switch) and
  an option off by default.
- **Not a certified alarm system**: every user-facing text that presents
  the alarms says so; never imply Gladys can be relied on for safety.
- **External ids are forever**: device `protect:<topaz id>`, features by
  reading key (`src/devices.js`). Manifest keys (`issue_token`, `cookies`,
  `language`, `test_connection`, `smoke_detected`, `co_detected` and their
  `device` / `level` / `room`) are frozen.
- **Secrets**: the issue_token and the cookies are sent only to
  `accounts.google.com` (checked before sending), never logged, never in
  `/data` nor in a message; the Nest session token only to `home.nest.com`
  and a `*.nest.com` transport. `/data` holds the Nest session only (the one
  token needed). A `secret` field is kept by Gladys in its database: never
  write that it is encrypted.
- **Refusals never loop**: Google refusing the cookies is a persisted stop;
  a Nest session refused right after being made gives spaced retries
  (1 h, 6 h, 24 h). Only new credentials or the button retry at once.
- Never a tight loop on the long poll (2 s minimum, one minute after quick
  empty answers); 429 pauses every path, persisted.
- The Discovery list never shrinks; status and Discovery are sent again at
  every `connected`; a reconnection keeps the session, stops and pauses.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in
  sync, both saying "never tested with a real account".
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow (0.1.0 was set by
  hand once, see TODO.md).
