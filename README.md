# gladys-nest-protect

[Gladys Assistant](https://gladysassistant.com) external integration for
**Google Nest Protect** smoke and CO alarms, **read only**: smoke, carbon
monoxide, hush, battery, battery to replace, online state, self-test, days
since the last manual test, night light, and the "Smoke detected" / "CO
detected" scene triggers. Real time through the long poll of the Nest web
app.

> **This is not a certified alarm system: never rely on it for the safety of
> people.** Keep the Nest app and the detectors' own sirens.

**Unofficial API (the one of the Nest web app), fragile cookie sign-in,
never tested with a real account. Not affiliated with Google or Nest.** The
official Google Nest integration (SDM API) does not cover the Protect.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (NestProtectApp)
                                  ├─ src/client.js     Google cookies -> JWT -> Nest session, app_launch, long poll
                                  ├─ src/http.js       the only HTTPS access, errors, bounds, cancellation
                                  ├─ src/model.js      buckets -> detectors, readings (pure)
                                  ├─ src/devices.js    detector -> Gladys device and states (pure, read only)
                                  ├─ src/publisher.js  states within 300/min
                                  └─ src/store.js      /data/nest-protect-state.json
```

- **Sign-in** (as pynest, the client of ha-nest-protect): `GET` the
  issue_token URL (`accounts.google.com/o/oauth2/iframerpc?action=issueToken…`)
  with the browser cookies → a Google access token; `POST` it to
  `nestauthproxyservice-pa.googleapis.com/v1/issue_jwt` → a JWT;
  `GET home.nest.com/session` with it → the Nest session (token, user id,
  end, transport URL). The session is kept in `/data` (the one token kept)
  and renewed 15 minutes before it ends. The issue_token is checked to be a
  Google iframerpc URL before the cookies are sent; the transport URL must be
  on `*.nest.com` before the session token is sent. Cookies Google rotates
  are written back to the `cookies` secret field (`setConfig`), never to
  `/data`.
- **Reads**: `POST /api/0.1/user/<id>/app_launch` (buckets `topaz`, `where`,
  `widget_track`) at start, after a failure and every hour; in between,
  `POST <transport>/v6/subscribe` with the known revisions, answered when a
  bucket changes (up to ~10 min). At least 2 s between two long polls, one
  minute after three quick empty answers.
- **Errors**: Google refusing the cookies (`USER_LOGGED_OUT`, any 4xx):
  stop, persisted, until new credentials or the button. Nest refusing the
  session: made again once; refused again within 2 minutes of being made: a
  pause and one new try after 1 h, 6 h, then every 24 h (persisted). 429:
  `Retry-After` bounded to 1 min – 6 h, 10 min without it, persisted. 502/504
  of the long poll: 2 minutes (pynest). Network/5xx: 15 s, 1, 2, 5, 10,
  15 min.
- **Gladys side**: one device per Protect (`protect:<topaz id>`), every
  feature `read_only`, categories `smoke-sensor` (`binary`, `muted`),
  `co-sensor` (`binary`), `battery` (%), `battery-low`, `duration` (days),
  `unknown` (online, self-test, night light). No `switch`, no command
  handler (every command refused). Scene events `smoke_detected` and
  `co_detected` on the rise to 1 (`device`, `level`, `room`). The Discovery
  list never shrinks; status, Discovery and badges are sent again at every
  reconnection to Gladys.

## Credits

The sign-in, the API calls and the readings are ported from
[ha-nest-protect](https://github.com/iMicknl/ha-nest-protect) (Mick
Vleeshouwer, MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Structure modelled on the sibling cloud integration
[gladys-hubspace](https://github.com/LM1LC3N7/gladys-hubspace).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: Google and Nest are a fake behind the
injected transport (`test/helpers/fakeNest.js`, answers shaped like the ones
pynest parses, the long poll held open until a test pushes a change), Gladys
is the SDK's fake; `test/http.test.js` runs the real transport against a
loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
with its notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also
shipped in the Docker image).
