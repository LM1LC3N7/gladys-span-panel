# gladys-span-panel

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**SPAN smart electrical panels** (United States), through their official local
API "eBus": the MQTT broker of the panel, over TLS pinned to the certificate
authority of the panel. No cloud. Not affiliated with SPAN.

**Never tested with a real device.** Built from the documentation of
span-panel-api, the Home Assistant integration SpanPanel/span and a capture of
a real MAIN 32 panel (firmware r202639). Feedback welcome.

- Power and energy per circuit, grid, solar, house, main lugs, battery,
  voltages, main relay, door and grid state.
- Energy indexes for the Gladys energy monitoring, guarded: a 0, a drop or an
  implausible jump is held until a two-click acceptance (see the user guide).
- The relay of each circuit as a list (Closed, Open), never a switch. Opening
  and closing are refused unless an option allows them (off by default), and
  confirmed only by the state the panel publishes back.
- Pairing in two clicks (passphrase or proximity), one registration per click;
  firmware r202633 or later (data model 1.x).

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules,
[TODO.md](TODO.md) for the decisions and what is left to check on a real
panel.

## License

Apache-2.0 (see `LICENSE`). Logic ported from
[span-panel-api](https://github.com/SpanPanel/span-panel-api) (MIT), with
[SpanPanel/span](https://github.com/SpanPanel/span) (MIT) as a reference; see
`THIRD_PARTY_NOTICES.md`.
