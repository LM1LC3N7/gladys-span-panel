# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Its runtime dependencies are the SDK and `mqtt` (MQTT.js). It started from the
official JavaScript template.

It reads a **SPAN smart electrical panel** through its official local API
"eBus" (firmware r202633 or later, data model 1.x): the REST bootstrap for the
pairing (`/api/v2/status`, `/api/v2/certificate/ca` over plain HTTP,
`/api/v2/auth/register` over HTTPS pinned), then the MQTT broker of the panel
over TLS pinned to its certificate authority, the Homie 5 tree under
`ebus/5/#`. Ported from [span-panel-api](https://github.com/SpanPanel/span-panel-api)
(MIT) with [SpanPanel/span](https://github.com/SpanPanel/span) (MIT) as a
reference, see `THIRD_PARTY_NOTICES.md`. Unofficial. Siblings:
`gladys-openems` (structure, app, store, guard), `gladys-pglab` (MQTT
transport, PacketGuard), `gladys-p1-monitor` (the guard).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/e2e.test.js              # one file (a fake panel on 127.0.0.1)
node --test --test-name-pattern "relay"   # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/cover.mjs cover.png          # the store cover (800×534)
```

## Architecture

```
index.js                          SDK wiring only (src/handlers.js)
src/handlers.js                   every handler, registered before connect()
src/app.js                        SpanApp: pairing, session, publication, counters, relays, buttons
src/span/http.js                  REST bootstrap: status, authority (HTTP), registration (HTTPS pinned)
src/span/tls.js                   the pin: TLS options, peer check, handshake probe, error words
src/span/mqtt.js                  MQTTS to the panel: pinned stream, PacketGuard, mqtt.js client
src/span/tree.js                  the Homie tree of ONE session, bounded (pure)
src/span/panel.js                 what the tree says of the panel paired: identity, signs, units (pure)
src/guard.js                      plausibility of a lifetime counter (gladys-openems, as it is)
src/store.js                      what /data keeps across restarts (unreadable ≠ empty)
src/devices.js                    the devices, feature keys, catalogs, states (pure)
src/config.js                     the form and the credentials of the pairing, normalized
src/constants.js                  timings, bounds, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
test/kit/                         copied from ~/code/ref/gladys-testkit (clocks, certificates)
test/helpers/fakePanel.js         a fake panel: HTTP, HTTPS and an MQTTS broker on loopback
test/helpers/fakeMqtt.js          a fake mqtt.js client for the unit tests
```

## Rules

- **Relays are sensitive both ways**: opening cuts a circuit, closing powers it
  again. Refused unless `allow_relay_control` (off by default), re-checked in
  the same turn as the publication; decided on the tree of the current session
  only; a `text/select` list, never a `switch` nor a `binary`; QoS 0, never
  queued; one command at a time per circuit; success only on a state
  published back that differs from the state before.
- **Trust**: an authority read over plain HTTP is a candidate until the user
  confirms its fingerprint (second click or typed); nothing is written to a
  TLS socket before the peer is verified against the pin; a pin is never
  replaced without the user. One registration per click, never automatic.
- **Secrets**: the passphrase only goes into the registration over HTTPS
  pinned; the broker credentials are kept by Gladys (`setConfig`, keys outside
  the form), only sent in the CONNECT on the verified socket. Never logged,
  shown, written to `/data` nor put in an error. Never the forbidden word for
  secrets (`test/encoding.test.js`).
- **Refusal**: credentials refused by the broker, or a CONNECT left unanswered
  twice: a final stop in `/data`, lifted by a new pairing only.
- **Freshness**: every session starts from an empty tree; a value counts only
  while the root and its device say `$state` = ready.
- **Lifetime counters** (the entries with `counter` in `src/devices.js`):
  through `IndexGuard` on the session clock, never 0, never a drop nor a jump
  without the two-click action; sent only once `/data` holds their guard.
- **Clocks**: monotonic for every pace and deadline, the session clock for the
  guards, the wall clock only for what `/data` keeps. Each decision reads each
  clock once.
- **External ids are forever**: `panel:<serial>`, `circuit:<serial>_<id>`, the
  feature keys, the manifest keys, the `STORED` keys. A device published again
  never loses a feature.
- **Units**: only those of `DEVICE_FEATURE_UNITS_BY_CATEGORY` in the core.
- **The container rootfs is read-only.** Write only `/data/span-panel-state.json`.
- **Versions belong to the Release workflow.** Never edit `version` by hand.
- **Changelog** under `## [Unreleased]`; **manifest** texts `{ en, fr }`; no
  `default` on a secret; UTF-8 without BOM nor control byte.
- **Tests never leave the machine** (127.0.0.1 only); `mkdtemp` folders are
  removed in `t.after`.
