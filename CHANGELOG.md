# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- SPAN smart electrical panels through their official local API (eBus, the
  MQTT broker of the panel over TLS, firmware r202633 or later): a device for
  the panel (grid, solar, house, main lugs, battery, voltages, main relay,
  door, grid state) and one per circuit (power, energy, relay).
- Pairing in two clicks: the certificate authority of the panel is shown,
  then pinned, then Gladys registers over HTTPS checked against it (passphrase
  or proximity); the broker credentials are kept by Gladys.
- Opening and closing the circuit relays, off by default, confirmed by the
  state the panel publishes back.
- Energy indexes per circuit and through the main lugs, guarded: a 0, a drop
  or an implausible jump is held until a two-click acceptance.

[Unreleased]: https://github.com/LM1LC3N7/gladys-span-panel/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-span-panel/releases/tag/v0.1.1
