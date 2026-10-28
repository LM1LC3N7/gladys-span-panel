# TODO

## Before announcing

- [x] Review r1 (2026-10-28): REFUSÉ, 0 blocker, 3 important, 6 minor: fixed.
- [ ] Review r2.
- [ ] Test on a real Gladys 5.1+ with a real SPAN panel (firmware r202633 or
      later): pairing by passphrase and by proximity, device creation, the
      counters over a day, a relay opened and closed on an unimportant
      circuit.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store: `keywords` (span, panel, breaker, circuit) and `countries`
      (US) once the core accepts them for this integration.

## To confirm on a real panel (built without one)

- [ ] HTTPS on port 443 with the certificate of the panel signed by the
      authority of `/api/v2/certificate/ca` (span-panel-api 3.x and
      SpanPanel/span 2.x register this way); if a firmware serves no HTTPS, the
      pairing fails with a clear message (the passphrase never goes in plain
      HTTP).
- [ ] The certificate of the broker (8883) signed by the same authority, and
      a host name check not needed (the certificate names
      `span-<serial>.local`; the pin and the serial are checked instead).
- [ ] That the panel republishes its values (power, energy) live, not only
      on change, and keeps `$state` = ready on every device it describes.
- [ ] The signs read from the capture: a load negative with its consumption
      in `exported-energy`, the upstream lugs positive while drawing,
      `power-flows/grid` positive when exporting, `power-flows/battery`
      positive when charging.
- [ ] Whether the energy counters drop after a reboot or a firmware update
      (the guard holds a drop; the user accepts it in two clicks).
- [ ] That a panel publishes something at least every 5 minutes (power values
      move constantly); otherwise the stale alarm (review r1, m4) would trip
      on a quiet panel and STALE_AFTER must grow.
- [ ] The relay command `switch/relay/set` and the state published back
      within 3 s; the requester `USER`.

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-span-panel:0.1.0`),
  as for the sibling integrations; the Release workflow owns them from now on.
- **SDK**: `@gladysassistant/integration-sdk` 0.16.0, the latest published
  (registry checked on 2026-10-28, `dist-tags.latest`). `gladys_version:
">=5.1.0"`, category `energy`; no `keywords` nor `countries` in the manifest.
- **References**: span-panel-api (MIT, 3.7.0b1, commit 93681a7 of
  2026-10-25, LICENSE checked) and SpanPanel/span (MIT, 2.1.2, commit a8b1b8d
  of 2026-10-26, LICENSE checked), cloned read-only in `~/code/ref/lot18/`.
  Ported: the REST bootstrap, the pinned TLS, the MQTT session, the reading of
  the tree of the data model 1.x (schema-1 parser). Not ported: the flat schema
  (schema-0), the shed priorities, the dominant power source, the EV charger
  limits, the adoption of unknown devices, the passphrase rotation, the FQDN
  registration.
- **Only the data model 1.x** (firmware r202633 or later): SPAN retired the
  flat schema with r202633 (fleet rollout in September 2026). A flat panel is
  recognized (no `info/data-model-version`) and the status asks for an update;
  nothing is guessed from it.
- **Trust**: the authority of `/api/v2/certificate/ca` (plain HTTP, the only
  way to get it) is a candidate; it is pinned only when the user confirms its
  fingerprint (second click, 3 s to 5 min, or the fingerprint typed in the
  form), and only once a TLS handshake shows it signs the HTTPS certificate of
  the panel. Pinned in `/data` before any secret leaves; a failed write stops
  the pairing. A certificate the pin refuses later is never re-learnt: the
  authority now advertised is shown (fetched at most every 15 min), pinned
  only if the user types its fingerprint or pairs again. Host names are not
  checked (the pin of an authority of one panel, and the serial of the tree).
- **Secrets**: the passphrase is a `secret` field; the broker credentials the
  panel returns are kept by Gladys through `setConfig` under keys outside the
  form (`broker_username`, `broker_password`, `broker_port`, `paired_serial`),
  never in `/data`, never logged. While the broker refuses them, `/data` keeps
  an 8-bit salted fingerprint only (after gladys-openems).
- **Relays**: both directions are sensitive (opening cuts a circuit, closing
  powers one again: someone may be working on it), so there is no protective
  command: both are refused unless the option is on (off by default), decided
  on the state of the session, the option re-checked in the same turn as the
  publication, QoS 0 (never queued, nothing re-sent by mqtt.js after a
  reconnection), one command at a time per circuit, confirmed only by a state
  published back that differs from the state before (3.3 s), else "sent,
  without confirmation". A `text/select` list, never a switch nor a binary;
  read-only where the panel does not declare the relay settable and
  controllable (decided at the publication, as Gladys keeps it).
- **Freshness**: every session starts from an empty tree. Homie keeps every
  value retained and a publisher sets `$state` to `lost` (last will) when it
  stops: a retained value of a device whose `$state` and the root's are
  `ready` is its current value, so values are published only then, without
  `created_at`. The panel publishes no source time stamp to deduplicate on.
- **Energy**: indexes `energy-sensor/index` (each circuit, the main lugs) and
  `energy-production-sensor/index` (a solar circuit), in kWh; what the main
  lugs sent back is a plain sensor (not always the grid: a battery may sit
  upstream). Guard of gladys-openems (itself gladys-p1-monitor's) as it is,
  60 kW per circuit, 120 kW for the lugs, on the session clock; the
  acceptance in two clicks. The grid power from `power-flows/grid` negated
  (`grid-sensor/power`, import positive).
- **Publication**: the panel pushes; Gladys gets the values every 60 s by
  default (30 to 600 s, monotonic), the first ones as soon as a session reads
  a ready panel, within 270 states a minute with the circuits in turn; a
  relay change at once (300 ms).
- **Session**: one at a time, no reconnection by mqtt.js; 5 s, 15 s, 30 s,
  1 min, 2 min, then 5 min; credentials refused (CONNACK 4, 5): a final stop
  until a new pairing; a CONNECT closed unanswered twice: a stop said as such
  (not a refusal), one try per click of the test button or per save of the
  configuration (review r1, m3). No message for 5 min while up: values not
  published as current, status says so (m4).
- **Review r1**: an accepted drop is a floor (guard, I1); the fingerprint
  typed pins `seen` only once /data holds it, else no session and a status
  (I2); tests for the 60/120 kW margins, the bound of the acceptance, the
  budget against the 300 of the core (I3); another authority at the second
  click said plainly (m1). Packets bounded at
  256 KB before they are read (PacketGuard of gladys-pglab).
- **Structure**: app, store and guard from gladys-openems; MQTT transport from
  gladys-pglab; the test clock and certificates of `~/code/ref/gladys-testkit`
  copied in `test/kit/` and `test/fixtures/`.
- **Mutation run (jalon 1)**: 64 mutants on the guards, 59 killed by a test.
  Equivalent ones kept as defence: the topic length bound (the id and part
  patterns already bound it), writes held until the pin check in
  `pinnedStream` (Node's TLS socket also holds them until its own
  verification, which the pin `ca` restricts), `queueQoSZero: false` (a
  command is published only on a connected client), the tree created per
  session (`endClient` already drops it).
