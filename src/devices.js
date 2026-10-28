// -----------------------------------------------------------------------------
// The Gladys devices of the panel (one for the panel, one per circuit) and
// their states, from what src/span/panel.js read. Pure.
//
// External ids (forever): `panel:<serial>` and `circuit:<serial>_<circuit
// id>` (the circuit id is the device id the panel gives the circuit in its
// tree, 32 hex, stable while the circuit stays commissioned). Feature keys
// (forever): see PANEL_KEYS and CIRCUIT_KEYS.
//
// Energy rules of the Gladys core (server/utils/constants.js) and of this
// project:
// - the lifetime counters are `energy-sensor/index` (the consumption of a
//   circuit, what the panel drew through its main lugs) and
//   `energy-production-sensor/index` (a solar circuit), in kWh; every one goes
//   through the guard of src/guard.js (src/app.js): never 0, never a drop
//   nor a jump published without the user;
// - what the panel sent back upstream is a plain lifetime sensor (kWh in the
//   name, also guarded): it is not a consumption and not always the grid
//   (a battery may sit between the lugs and the meter);
// - the grid power is `grid-sensor/power`, signed (import positive), from
//   the power flows of the panel; the feed of the panel a signed
//   `energy-sensor/power`;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY); none on text features.
//
// The relay of a circuit is a `text/select` list (Closed, Open), NEVER a
// switch nor a binary: a "turn everything off" scene would cut the house.
// It is commandable only where the panel declares the relay settable and
// controllable, and src/app.js refuses every command unless the option
// "Allow opening and closing the circuit relays" is on (off by default).
//
// The features follow the panel and the created devices: the set only grows,
// and always holds the features of the created device, so a device published
// again never loses one (an "Update" in Discovery would drop its history).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { ENERGY_MAX, EXTERNAL_ID_TYPES, POWER_MAX, RELAY, VOLTAGE_MAX } from './constants.js';

export const PANEL_KEYS = {
  GRID_POWER: 'grid_power',
  PV_POWER: 'pv_power',
  SITE_POWER: 'site_power',
  FEED_POWER: 'feed_power',
  FEED_IMPORT_INDEX: 'feed_import_index',
  FEED_EXPORT_TOTAL: 'feed_export_total',
  BATTERY_LEVEL: 'battery_level',
  BATTERY_CHARGE: 'battery_charge_power',
  BATTERY_DISCHARGE: 'battery_discharge_power',
  BATTERY_ENERGY: 'battery_energy',
  VOLTAGE_L1: 'voltage_l1',
  VOLTAGE_L2: 'voltage_l2',
  MAIN_RELAY: 'main_relay',
  DOOR: 'door',
  GRID_STATE: 'grid_state',
};

export const CIRCUIT_KEYS = {
  POWER: 'power',
  PV_POWER: 'pv_power',
  CONSUMPTION_INDEX: 'consumption_index',
  PRODUCTION_INDEX: 'production_index',
  RELAY: 'relay',
  REQUESTER: 'relay_requester',
};

/** The relay options (a `text/select`: string values, plain string labels). */
export const RELAY_OPTIONS = [
  { value: RELAY.CLOSED, label: 'Closed (powered)' },
  { value: RELAY.OPEN, label: 'Open (circuit cut off)' },
];

export const panelIds = (gladys, serial) => gladys.externalIds(EXTERNAL_ID_TYPES.PANEL, serial);
export const circuitIds = (gladys, serial, circuitId) =>
  gladys.externalIds(EXTERNAL_ID_TYPES.CIRCUIT, `${serial}_${circuitId}`);

/**
 * `ext:<selector>:circuit:<serial>_<circuit id>:<key>` of the panel `serial`
 * → `{ circuitId, key }`; undefined for anything else (another panel, the
 * panel device, a malformed id).
 */
export function parseCircuitFeature(gladys, serial, externalId) {
  const prefix = `ext:${gladys.selector}:${EXTERNAL_ID_TYPES.CIRCUIT}:${serial}_`;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const rest = externalId.slice(prefix.length).split(':');
  if (rest.length !== 2) return undefined;
  const [circuitId, key] = rest;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(circuitId) && /^[a-z0-9_]{1,40}$/.test(key)
    ? { circuitId, key }
    : undefined;
}

const sensor = (name, category, type, extra = {}) => ({
  name,
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 0,
  ...extra,
});
const watts = (name, category, type, { signed = false } = {}) =>
  sensor(name, category, type, { unit: U.WATT, min: signed ? -POWER_MAX : 0, max: POWER_MAX });
const kwh = (name, category, type) =>
  sensor(name, category, type, { unit: U.KILOWATT_HOUR, min: 0, max: ENERGY_MAX });
const text = (name) => sensor(name, C.TEXT, T.TEXT.TEXT, { keep_history: false });

const round = (n, digits) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const within = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

/**
 * The features of the panel: `{ key, spec, when(panel), value(panel) }`;
 * `value` gives a number, `{ text }`, or undefined (unknown: nothing sent).
 * A `counter` feature takes the value its guard let through (src/app.js).
 */
export const PANEL_CATALOG = [
  {
    key: PANEL_KEYS.GRID_POWER,
    spec: watts('Grid power (+ import, - export)', C.GRID_SENSOR, T.GRID_SENSOR.POWER, {
      signed: true,
    }),
    when: () => true,
    value: (p) => p.values.gridPower,
  },
  {
    key: PANEL_KEYS.PV_POWER,
    spec: watts('Solar production', C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER),
    when: (p) => p.hasPv,
    value: (p) => p.values.pvPower,
  },
  {
    key: PANEL_KEYS.SITE_POWER,
    spec: watts('House consumption', C.HOME_OUTPUT_SENSOR, T.HOME_OUTPUT_SENSOR.POWER),
    when: () => true,
    value: (p) => p.values.sitePower,
  },
  {
    key: PANEL_KEYS.FEED_POWER,
    spec: watts('Main lugs power (+ drawn, - sent back)', C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, {
      signed: true,
    }),
    when: (p) => p.hasFeed,
    value: (p) => p.values.feedPower,
  },
  {
    key: PANEL_KEYS.FEED_IMPORT_INDEX,
    spec: kwh('Energy drawn through the main lugs', C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX),
    when: (p) => p.hasFeed,
    counter: 'feed',
    wh: (p) => p.values.feedImportWh,
  },
  {
    key: PANEL_KEYS.FEED_EXPORT_TOTAL,
    spec: sensor(
      'Energy sent back through the main lugs (kWh, lifetime, not counted)',
      C.UNKNOWN,
      T.SENSOR.DECIMAL,
      {
        max: ENERGY_MAX,
      },
    ),
    when: (p) => p.hasFeed,
    counter: 'feed',
    wh: (p) => p.values.feedExportWh,
  },
  {
    key: PANEL_KEYS.BATTERY_LEVEL,
    spec: sensor('Battery level', C.BATTERY_STORAGE, T.BATTERY_STORAGE.BATTERY_LEVEL, {
      unit: U.PERCENT,
      max: 100,
    }),
    when: (p) => p.hasBattery,
    value: (p) => p.values.batteryLevel,
  },
  {
    key: PANEL_KEYS.BATTERY_CHARGE,
    spec: watts('Battery charge power', C.BATTERY_STORAGE, T.BATTERY_STORAGE.CHARGE_POWER),
    when: (p) => p.hasBattery,
    value: (p) => p.values.batteryCharge,
  },
  {
    key: PANEL_KEYS.BATTERY_DISCHARGE,
    spec: watts('Battery discharge power', C.BATTERY_STORAGE, T.BATTERY_STORAGE.DISCHARGE_POWER),
    when: (p) => p.hasBattery,
    value: (p) => p.values.batteryDischarge,
  },
  {
    key: PANEL_KEYS.BATTERY_ENERGY,
    spec: sensor(
      'Battery energy remaining',
      C.BATTERY_STORAGE,
      T.BATTERY_STORAGE.BATTERY_ENERGY_REMAINING,
      { unit: U.KILOWATT_HOUR, max: 10_000 },
    ),
    when: (p) => p.hasBattery,
    value: (p) => p.values.batteryEnergy,
  },
  {
    key: PANEL_KEYS.VOLTAGE_L1,
    spec: sensor('Voltage L1', C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, {
      unit: U.VOLT,
      max: VOLTAGE_MAX,
    }),
    when: () => true,
    value: (p) => p.values.voltageA,
  },
  {
    key: PANEL_KEYS.VOLTAGE_L2,
    spec: sensor('Voltage L2', C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, {
      unit: U.VOLT,
      max: VOLTAGE_MAX,
    }),
    when: () => true,
    value: (p) => p.values.voltageB,
  },
  {
    key: PANEL_KEYS.MAIN_RELAY,
    spec: text('Main relay (OPEN, CLOSED)'),
    when: () => true,
    value: (p) => (p.values.mainRelay ? { text: p.values.mainRelay } : undefined),
  },
  {
    key: PANEL_KEYS.DOOR,
    spec: text('Panel door (OPEN, CLOSED)'),
    when: () => true,
    value: (p) => (p.values.door ? { text: p.values.door } : undefined),
  },
  {
    key: PANEL_KEYS.GRID_STATE,
    spec: text('Grid (ON_GRID, OFF_GRID)'),
    when: (p) => p.hasMid,
    value: (p) => (p.values.gridState ? { text: p.values.gridState } : undefined),
  },
];

/** The features of a circuit (same shape; `c` is the circuit read). */
export const CIRCUIT_CATALOG = [
  {
    key: CIRCUIT_KEYS.POWER,
    spec: watts('Power', C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, { signed: true }),
    when: (c) => !c.feedsPv,
    value: (c) => c.power,
  },
  {
    key: CIRCUIT_KEYS.PV_POWER,
    spec: watts('Solar production', C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER),
    when: (c) => c.feedsPv,
    value: (c) => (c.power === undefined ? undefined : Math.max(0, -c.power)),
  },
  {
    key: CIRCUIT_KEYS.CONSUMPTION_INDEX,
    spec: kwh('Energy consumed', C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX),
    when: (c) => !c.feedsPv,
    counter: 'circuit',
    wh: (c) => c.consumedWh,
  },
  {
    key: CIRCUIT_KEYS.PRODUCTION_INDEX,
    spec: kwh('Energy produced', C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.INDEX),
    when: (c) => c.feedsPv,
    counter: 'circuit',
    wh: (c) => c.producedWh,
  },
  {
    key: CIRCUIT_KEYS.RELAY,
    spec: {
      ...sensor('Relay', C.TEXT, T.TEXT.SELECT, { keep_history: false, has_feedback: true }),
      supported_options: RELAY_OPTIONS,
    },
    when: () => true,
    value: (c) => (c.relay ? { text: c.relay } : undefined),
  },
  {
    key: CIRCUIT_KEYS.REQUESTER,
    spec: text('Relay last set by (USER, LOAD_SHED, PCS...)'),
    when: () => true,
    value: (c) => (c.requester ? { text: c.requester } : undefined),
  },
];

/** The feature keys of a created device (its features are fixed at its creation). */
export function keysOfDevice(device) {
  return new Set(
    (device?.features ?? []).map((f) =>
      String(f.external_id ?? '')
        .split(':')
        .at(-1),
    ),
  );
}

const PANEL_BOUNDS = {
  [PANEL_KEYS.BATTERY_LEVEL]: [0, 100, 1],
  [PANEL_KEYS.BATTERY_ENERGY]: [0, 10_000, 3],
  [PANEL_KEYS.VOLTAGE_L1]: [Number.MIN_VALUE, VOLTAGE_MAX, 1],
  [PANEL_KEYS.VOLTAGE_L2]: [Number.MIN_VALUE, VOLTAGE_MAX, 1],
};

/** A number within the bounds of its feature, rounded, or undefined. */
function bounded(entry, value) {
  if (value === undefined || typeof value === 'object') return value;
  const [min, max, digits] = PANEL_BOUNDS[entry.key] ?? [
    entry.spec.min,
    entry.spec.max,
    entry.spec.unit === U.KILOWATT_HOUR ? 3 : 1,
  ];
  return within(value, min, max) ? round(value, digits) : undefined;
}

/** kWh of a counter read in Wh (3 decimals: 1 Wh), or undefined. */
export function kwhOf(wh) {
  return within(wh, 0, ENERGY_MAX * 1000) ? round(wh / 1000, 3) : undefined;
}

function device(base, entries, subject, created) {
  const createdKeys = keysOfDevice(created);
  const ids = base.ids;
  return {
    name: base.name,
    external_id: ids.device,
    selector: undefined,
    model: base.model,
    should_poll: false,
    params: base.params,
    features: entries
      .filter((e) => e.when(subject) || createdKeys.has(e.key))
      .map((e) => ({ ...e.spec, external_id: ids.feature(e.key) })),
  };
}

/** The device of the panel. `created`: the device the user created, if any. */
export function buildPanelDevice(gladys, panel, created) {
  const out = device(
    {
      ids: panelIds(gladys, panel.serial),
      name: `SPAN panel ${panel.serial}`,
      model: panel.model,
      params: [
        { name: 'SPAN_SERIAL', value: panel.serial },
        { name: 'SPAN_MODEL', value: panel.model ?? '' },
        { name: 'SPAN_FIRMWARE', value: panel.firmware ?? '' },
      ],
    },
    PANEL_CATALOG,
    panel,
    created,
  );
  delete out.selector;
  if (!out.model) delete out.model;
  return out;
}

/** The device of a circuit. */
export function buildCircuitDevice(gladys, serial, circuit, created) {
  const out = device(
    {
      ids: circuitIds(gladys, serial, circuit.id),
      name: circuit.name,
      params: [
        { name: 'SPAN_SERIAL', value: serial },
        { name: 'SPAN_CIRCUIT_ID', value: circuit.id },
        { name: 'SPAN_SPACES', value: circuit.spaces ?? '' },
      ],
    },
    CIRCUIT_CATALOG,
    circuit,
    created,
  );
  delete out.selector;
  delete out.model;
  // Commandable only where the panel declares the relay settable and
  // controllable (decided at the publication: Gladys keeps it at creation).
  const relay = out.features.find((f) => f.external_id.endsWith(`:${CIRCUIT_KEYS.RELAY}`));
  if (relay) relay.read_only = !(circuit.settable && circuit.controllable);
  return out;
}

/**
 * The states of one subject (the panel or a circuit) for the features of
 * its created device. `counters(entry)` gives the value the guard of a
 * counter let through (kWh), or undefined.
 */
export function statesOf(ids, catalog, subject, createdKeys, counters) {
  const states = [];
  for (const entry of catalog) {
    if (!createdKeys.has(entry.key)) continue;
    let value;
    if (entry.counter) value = counters(entry);
    else value = bounded(entry, entry.value(subject));
    if (value === undefined) continue;
    const id = ids.feature(entry.key);
    if (typeof value === 'object')
      states.push({ device_feature_external_id: id, text: value.text });
    else states.push({ device_feature_external_id: id, state: value });
  }
  return states;
}
