// -----------------------------------------------------------------------------
// What the tree of one session says about the panel paired, read the way the
// reference parser does (span-panel-api-schema-1, MIT: panel.py, circuits.py,
// devices.py). Pure.
//
// Identity: the root device id is the serial of the pairing, its type the
// distribution enclosure, its `info/serial-number` (when published) the same
// serial. Only devices whose description names that root are read. The data
// model must be 1.x (firmware r202633 or later): the flat schema of older
// firmware is NOT read (SPAN retired it in r202633), never guessed.
//
// Current: a value counts only while the root AND its own device say `$state`
// = ready. Homie keeps every value retained, a publisher sets its `$state` to
// `lost` (last will) when it stops: a retained value of a ready device is its
// current value; nothing of a former session is here (src/span/tree.js).
//
// Signs and directions (the enclosure frame, checked against the captures of
// a real MAIN 32 on r202639 and of the eBus simulator):
// - a circuit reads NEGATIVE `meter/active-power` when it draws, and its
//   consumption accumulates in `meter/exported-energy` (the panel exported it
//   to the circuit); a solar circuit reads positive and accumulates in
//   `meter/imported-energy`. Power is negated here (consumption positive);
// - the upstream lugs (the feed of the panel) read positive while the panel
//   draws from upstream and accumulate it in `meter/imported-energy`;
// - `power-flows`: `grid` positive = exporting to the grid, `pv` negative
//   while producing, `battery` positive = charging, `site` positive =
//   consuming (catalog power-flows 0.3). The grid is negated here (import
//   positive, the Gladys `grid-sensor/power` rule).
// Energy is published only with the unit its description declares (Wh or
// kWh), power only in W or kW: anything else is unknown, never a guess.
// -----------------------------------------------------------------------------

import { DATA_MODEL_MAJOR, MAX_CIRCUITS, MAX_NAME, RELAY, TYPES } from '../constants.js';

const READY = 'ready';
const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/** A strict number of a Homie value (empty, NaN, "true"... are unknown, never 0). */
export function numberOf(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (!NUMBER.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** The major of a data-model version (`1.0`, `1`, `1_0`), or undefined when unreadable. */
export function dataModelMajor(text) {
  const match = /^(\d{1,3})(?:[._]\d{1,3}){0,2}$/.exec(typeof text === 'string' ? text.trim() : '');
  return match ? Number(match[1]) : undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const cleanText = (text, max) =>
  typeof text === 'string' ? text.replace(CONTROL, ' ').trim().slice(0, max) : '';

/** Reads `<node>/<prop>` of a ready device as a number, converted by its declared unit. */
function measure(tree, id, node, prop, units) {
  const declared = tree.declared(id, node, prop);
  if (!declared || !['float', 'integer'].includes(declared.datatype)) return undefined;
  const factor = units[declared.unit ?? ''];
  if (factor === undefined) return undefined;
  const n = numberOf(tree.text(id, node, prop));
  return n === undefined ? undefined : n * factor;
}
const WATTS = { W: 1, kW: 1000 };
const WH = { Wh: 1, kWh: 1000 };

/** An enum value among `allowed`, or undefined. */
function enumOf(tree, id, node, prop, allowed) {
  const text = tree.text(id, node, prop);
  return allowed.includes(text) ? text : undefined;
}

const negate = (n) => (n === undefined ? undefined : n === 0 ? 0 : -n);

/**
 * The panel of `serial` in the tree: `{ problem }` when it cannot be read
 * (not described yet, not ready, another panel, another data model), else
 * its identity, its values and its circuits (each value undefined when
 * unknown).
 */
export function readPanel(tree, serial) {
  const root = tree.devices.get(serial);
  if (!root?.description) {
    // Another root on this broker (a panel answering with another serial) says so.
    for (const device of tree.devices.values()) {
      if (device.description?.type === TYPES.PANEL && device.id !== serial) {
        return { problem: 'otherPanel', seen: device.id };
      }
    }
    return { problem: 'notDescribed' };
  }
  if (root.description.type !== TYPES.PANEL) return { problem: 'notPanel' };
  const published = tree.text(serial, 'info', 'serial-number');
  if (published !== undefined && published !== serial) {
    return { problem: 'otherPanel', seen: cleanText(published, 64) };
  }
  const versionText = tree.text(serial, 'info', 'data-model-version');
  const major = dataModelMajor(versionText);
  if (major !== DATA_MODEL_MAJOR) {
    if (versionText === undefined && root.state !== READY) return { problem: 'notReady' };
    return { problem: 'dataModel', version: cleanText(versionText ?? '', 16) || undefined };
  }
  if (root.state !== READY) return { problem: 'notReady', state: cleanText(root.state, 16) };

  // The devices of this panel, ready: by type.
  const byType = new Map();
  for (const device of tree.devices.values()) {
    const d = device.description;
    if (!d || device.id === serial || d.root !== serial || device.state !== READY) continue;
    if (!byType.has(d.type)) byType.set(d.type, []);
    byType.get(d.type).push(device);
  }
  const ofType = (type) => byType.get(type) ?? [];
  const lugs = (direction) =>
    ofType(TYPES.LUGS).find((l) => tree.text(l.id, 'info', 'direction') === direction);
  const upstream = lugs('UPSTREAM');
  const bess = ofType(TYPES.BESS)[0];
  const mid = ofType(TYPES.MID)[0];

  const flows = (prop) => measure(tree, serial, 'power-flows', prop, WATTS);
  const pv = flows('pv');
  const battery = flows('battery');
  const site = flows('site');
  const values = {
    gridPower: negate(flows('grid')),
    pvPower: pv === undefined ? undefined : Math.max(0, -pv),
    sitePower: site === undefined ? undefined : Math.max(0, site),
    batteryCharge: bess && battery !== undefined ? Math.max(0, battery) : undefined,
    batteryDischarge: bess && battery !== undefined ? Math.max(0, -battery) : undefined,
    batteryLevel: bess ? measure(tree, bess.id, 'soc', 'soc', { '%': 1 }) : undefined,
    batteryEnergy: bess ? measure(tree, bess.id, 'soc', 'soe', { kWh: 1, Wh: 0.001 }) : undefined,
    feedPower: upstream ? measure(tree, upstream.id, 'meter', 'active-power', WATTS) : undefined,
    feedImportWh: upstream ? measure(tree, upstream.id, 'meter', 'imported-energy', WH) : undefined,
    feedExportWh: upstream ? measure(tree, upstream.id, 'meter', 'exported-energy', WH) : undefined,
    voltageA: measure(tree, serial, 'meter', 'voltage-a', { V: 1 }),
    voltageB: measure(tree, serial, 'meter', 'voltage-b', { V: 1 }),
    mainRelay: enumOf(tree, serial, 'status', 'relay', [RELAY.OPEN, RELAY.CLOSED]),
    door: enumOf(tree, serial, 'door', 'state', ['OPEN', 'CLOSED']),
    gridState: mid
      ? enumOf(tree, mid.id, 'grid', 'islanding-state', ['ON_GRID', 'OFF_GRID'])
      : undefined,
  };

  const circuits = [];
  for (const device of ofType(TYPES.CIRCUIT).slice(0, MAX_CIRCUITS)) {
    const id = device.id;
    const feedsPv = tree.text(id, 'connection', 'feeds-device-type') === TYPES.PV;
    const relayDeclared = tree.declared(id, 'switch', 'relay');
    circuits.push({
      id,
      name:
        cleanText(tree.text(id, 'info', 'name'), MAX_NAME) ||
        cleanText(device.description.name, MAX_NAME) ||
        id,
      spaces: /^[0-9, ]{1,32}$/.test(tree.text(id, 'info', 'spaces') ?? '')
        ? tree.text(id, 'info', 'spaces')
        : undefined,
      feedsPv,
      power: negate(measure(tree, id, 'meter', 'active-power', WATTS)),
      consumedWh: measure(tree, id, 'meter', 'exported-energy', WH),
      producedWh: measure(tree, id, 'meter', 'imported-energy', WH),
      relay: enumOf(tree, id, 'switch', 'relay', [RELAY.OPEN, RELAY.CLOSED]),
      requester: enumOf(tree, id, 'switch', 'relay-requester', [
        'NONE',
        'USER',
        'LOAD_SHED',
        'PCS',
        'CONFIGURATION',
        'FAULT',
      ]),
      controllable: tree.text(id, 'switch', 'relay-controllable') === 'true',
      settable: relayDeclared?.settable === true,
    });
  }
  circuits.sort((a, b) => a.id.localeCompare(b.id));
  return {
    serial,
    model: cleanText(tree.text(serial, 'info', 'model'), 16) || undefined,
    firmware: cleanText(tree.text(serial, 'info', 'firmware-version'), 64) || undefined,
    hasPv: ofType(TYPES.PV).length > 0 || circuits.some((c) => c.feedsPv),
    hasBattery: Boolean(bess),
    hasMid: Boolean(mid),
    hasFeed: Boolean(upstream),
    values,
    circuits,
  };
}
