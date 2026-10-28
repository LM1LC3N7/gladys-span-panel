# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below, its tests use captures they
publish, and it runs with the library below, each distributed under its own
license.

## span-panel-api (SpanPanel/span-panel-api)

<https://github.com/SpanPanel/span-panel-api>, the Python client of the
official local API ("eBus") of SPAN panels. Version 3.7.0b1 (schema-1 parser
1.3.0b1), branch `main` at commit 93681a7 (2026-10-25). MIT License,
Copyright (c) 2025 Bill Flood.

Ported to JavaScript in `src/span/http.js`, `src/span/tls.js`,
`src/span/tree.js`, `src/span/panel.js` and `src/constants.js`: the REST
bootstrap (`/api/v2/status`, `/api/v2/certificate/ca`, `/api/v2/auth/register`
with `hopPassphrase` or proximity, the 422 "Dashboard password is not
available", the 503 of a panel starting), the pinning of the certificate
authority of the panel, the MQTTS session (port 8883, MQTT 3.1.1, the
subscription `ebus/5/#`), the Homie 5 device tree of the data model 1.x and
its reading (device types, `info/data-model-version`, the signs and directions
of circuits, lugs and power flows, the relay `switch/relay/set`). Changed here:
one registration per click, the authority trusted only once confirmed, nothing
written before the peer is verified, bounded packets and values, no shed
priority nor charger command, no secret logged.

## SpanPanel/span (Home Assistant integration)

<https://github.com/SpanPanel/span>, version 2.1.2, branch `main` at commit
a8b1b8d (2026-10-26). MIT License, Copyright (c) 2025 Bill Flood.

Read for the pairing flow (the authority checked against the certificate the
panel serves before it is pinned, the registration over HTTPS with the pin,
proximity by the door), the energy dips of a panel reset and the relay
controls. Its code is not copied.

## distribution-enclosure-simulator (electrification-bus)

`test/fixtures/main32_r202639-tree-v1.json`, the device tree a MAIN 32 panel
publishes on firmware `spanos3/r202639/03` (device ids, serial numbers and
postal code masked), byte-identical to the copy in span-panel-api, from
<https://github.com/electrification-bus/distribution-enclosure-simulator> at
tag v0.9.0. MIT License, Copyright (c) 2026 Bill Flood, Clark Communications
Corporation; its license is `test/fixtures/distribution-enclosure-simulator.LICENSE`.
`test/fixtures/flat_wire.json` (the flat schema of older firmware) comes from
span-panel-api (MIT, above). Test files only: not in the image.

## MQTT.js (mqttjs/MQTT.js)

<https://github.com/mqttjs/MQTT.js>, the npm package `mqtt` (5.x), used as a
library. MIT License, Copyright (c) 2015-2016 MQTT.js contributors.

```
MIT License

Copyright (c) 2025 Bill Flood <cayossarian@users.noreply.github.com>

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

The same MIT License text applies to SpanPanel/span (same copyright line) and,
with its own copyright lines quoted above, to distribution-enclosure-simulator
and MQTT.js.
