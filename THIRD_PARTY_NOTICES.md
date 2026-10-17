# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below, distributed under
the MIT License, whose notice is reproduced in full as that license asks.

## ha-nest-protect

<https://github.com/iMicknl/ha-nest-protect>, by Mick Vleeshouwer (iMicknl),
the Nest Protect custom integration of Home Assistant. MIT License (`LICENSE`
of the repository, default branch read on 2026-10-18, commit `5293d61`).

Ported in `src/constants.js` and `src/client.js` (from `pynest/const.py` and
`pynest/client.py`): the hosts (`home.nest.com`,
`nestauthproxyservice-pa.googleapis.com/v1/issue_jwt`), the browser
User-Agent, the cookie sign-in (the issue_token URL called with the cookies,
its headers, `USER_LOGGED_OUT` as refused credentials, the rotated cookies
merged into the cookie header), the JWT request and its form, the `/session`
call with the `cztoken` cookie, `app_launch` and its bucket types, the
`/v6/subscribe` long poll with the known revisions, its 401 / 502 / 504 /
empty `text/plain` answers and the 2-minute pause on a service error. Ported
in `src/model.js` and `src/devices.js` (from `sensor.py`,
`binary_sensor.py`, `entity.py`): smoke and CO "on" for any status but 0,
the status names (ok, testing, warning, emergency), the battery voltage
curve (`milli_volt_to_percentage`), the component self-tests shown (heat
left out), the battery health, the room name from the `where` buckets and
the device label. In `src/config.js` (from `config_flow.py`): the checks of
the issue_token prefix and of the cookies. The setup steps of the docs
follow the README of ha-nest-protect. Changed: read only (no night light
switch nor brightness select, no Nest x Yale lock, no temperature sensor),
no refresh-token sign-in, the rotated cookies saved through the Gladys
configuration, the persisted session tied to a salted fingerprint, stops
and pauses persisted, the transport URL accepted on `*.nest.com` only, scene
triggers on the rise of smoke and CO.

```
MIT License

Copyright (c) 2022 Mick Vleeshouwer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Credited upstream, not used directly

- [homebridge-nest](https://github.com/chrisjshull/homebridge-nest), credited
  by ha-nest-protect for the research behind this API; no code of it was
  read or taken for this port.
