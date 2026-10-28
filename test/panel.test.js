// -----------------------------------------------------------------------------
// The tree of a session and what it says of the panel (pure), on the real
// capture of a MAIN 32 (firmware r202639) and the flat capture of the
// reference: identity, data model, readiness, signs and units, bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HomieTree, parseDescription } from '../src/span/tree.js';
import { dataModelMajor, numberOf, readPanel } from '../src/span/panel.js';
import { MAX_DEVICES, MAX_PROPERTIES } from '../src/constants.js';
import { DRYER, PV_CIRCUIT, SERIAL, UPSTREAM, retainedTree } from './helpers/fakePanel.js';

function treeOf(topics) {
  const tree = new HomieTree();
  for (const [topic, payload] of topics) tree.ingest(topic, Buffer.from(payload));
  return tree;
}

test('the capture of a real MAIN 32: identity, signs, units', () => {
  const panel = readPanel(treeOf(retainedTree()), SERIAL);
  assert.equal(panel.problem, undefined);
  assert.equal(panel.model, 'MAIN_32');
  assert.equal(panel.firmware, 'spanos3/r202639/03');
  assert.equal(panel.circuits.length, 16);
  assert.ok(panel.hasPv && panel.hasBattery && panel.hasMid && panel.hasFeed);
  // power-flows: grid -1257 (positive = export) → import 1257; pv -1622 → 1622 produced.
  assert.equal(panel.values.gridPower, 1257);
  assert.equal(panel.values.pvPower, 1622);
  assert.equal(panel.values.sitePower, 2879);
  assert.equal(panel.values.batteryCharge, 0);
  assert.equal(panel.values.batteryDischarge, 0);
  assert.equal(panel.values.batteryLevel, 100);
  assert.equal(panel.values.batteryEnergy, 81);
  assert.equal(panel.values.feedPower, 1283.7);
  assert.equal(panel.values.feedImportWh, 27610149.5);
  assert.equal(panel.values.feedExportWh, 4055664.2);
  assert.equal(panel.values.voltageA, 121.8);
  assert.equal(panel.values.mainRelay, 'CLOSED');
  assert.equal(panel.values.door, undefined, 'UNKNOWN is never a state');
  assert.equal(panel.values.gridState, 'ON_GRID');
  const dryer = panel.circuits.find((c) => c.id === DRYER);
  // A load reads -4.0 W and accumulates in exported-energy (the enclosure frame).
  assert.equal(dryer.power, 4);
  assert.equal(dryer.consumedWh, 855286.5);
  assert.equal(dryer.name, 'Clothes-Dryer');
  assert.equal(dryer.spaces, '2,4');
  assert.equal(dryer.relay, 'CLOSED');
  assert.ok(dryer.settable && dryer.controllable && !dryer.feedsPv);
  const pv = panel.circuits.find((c) => c.id === PV_CIRCUIT);
  assert.ok(pv.feedsPv);
  assert.equal(pv.power, -1565.7, 'a solar circuit reads positive on the wire');
  assert.equal(pv.producedWh, 17468812);
  assert.ok(!pv.settable && !pv.controllable, 'the PV circuit cannot be commanded');
});

test('another panel, a panel not ready, a device not ready: nothing read', () => {
  const topics = retainedTree();
  assert.equal(readPanel(treeOf(topics), 'nt-0000-other').problem, 'otherPanel');
  const lost = new Map(topics);
  lost.set(`ebus/5/${SERIAL}/$state`, 'lost');
  assert.deepEqual(readPanel(treeOf(lost), SERIAL), { problem: 'notReady', state: 'lost' });
  const liar = new Map(topics);
  liar.set(`ebus/5/${SERIAL}/info/serial-number`, 'nt-1111-liar');
  assert.equal(readPanel(treeOf(liar), SERIAL).problem, 'otherPanel');
  const sleepy = new Map(topics);
  sleepy.set(`ebus/5/${DRYER}/$state`, 'init');
  const panel = readPanel(treeOf(sleepy), SERIAL);
  assert.equal(panel.circuits.length, 15);
  assert.ok(!panel.circuits.some((c) => c.id === DRYER));
  // A device of another root (another panel on the same broker) is never read.
  const foreign = new Map(topics);
  const description = JSON.parse(foreign.get(`ebus/5/${DRYER}/$description`));
  foreign.set(
    `ebus/5/${DRYER}/$description`,
    JSON.stringify({ ...description, root: 'nt-0000-x' }),
  );
  assert.ok(!readPanel(treeOf(foreign), SERIAL).circuits.some((c) => c.id === DRYER));
  const noLugs = new Map(topics);
  noLugs.set(`ebus/5/${UPSTREAM}/$state`, 'lost');
  const without = readPanel(treeOf(noLugs), SERIAL);
  assert.equal(without.hasFeed, false);
  assert.equal(without.values.feedImportWh, undefined);
});

test('the flat schema of older firmware is recognized and never read', () => {
  const flat = JSON.parse(
    readFileSync(new URL('./fixtures/flat_wire.json', import.meta.url), 'utf8'),
  );
  const [id, props] = Object.entries(flat)[0];
  const tree = new HomieTree();
  for (const [key, value] of Object.entries(props)) {
    tree.ingest(`ebus/5/${id}/${key}`, Buffer.from(String(value)));
  }
  assert.deepEqual(readPanel(tree, id), { problem: 'dataModel', version: undefined });
  assert.ok(tree.dropped > 0, 'its 500+ properties of one device are bounded');
  // A data model 2 is not read either.
  const topics = retainedTree();
  topics.set(`ebus/5/${SERIAL}/info/data-model-version`, '2.0');
  assert.deepEqual(readPanel(treeOf(topics), SERIAL), { problem: 'dataModel', version: '2.0' });
});

test('values: strict numbers, declared units only, unknown never 0', () => {
  for (const bad of ['', ' ', 'NaN', 'true', '1,5', '0x10', 'Infinity', '1e999', undefined]) {
    assert.equal(numberOf(bad), undefined, String(bad));
  }
  assert.equal(numberOf('-4.0'), -4);
  assert.equal(numberOf('.5'), 0.5);
  assert.equal(dataModelMajor('1.0'), 1);
  assert.equal(dataModelMajor('1_0'), 1);
  assert.equal(dataModelMajor('v1.0'), undefined);
  const topics = retainedTree();
  topics.set(`ebus/5/${DRYER}/meter/active-power`, '');
  topics.set(`ebus/5/${DRYER}/meter/exported-energy`, 'n/a');
  let dryer = readPanel(treeOf(topics), SERIAL).circuits.find((c) => c.id === DRYER);
  assert.equal(dryer.power, undefined);
  assert.equal(dryer.consumedWh, undefined);
  // A unit the description does not declare as energy: never a counter.
  const kw = retainedTree();
  const description = JSON.parse(kw.get(`ebus/5/${DRYER}/$description`));
  description.nodes.meter.properties['exported-energy'].unit = 'MWh';
  description.nodes.meter.properties['active-power'].unit = 'kW';
  kw.set(`ebus/5/${DRYER}/$description`, JSON.stringify(description));
  dryer = readPanel(treeOf(kw), SERIAL).circuits.find((c) => c.id === DRYER);
  assert.equal(dryer.consumedWh, undefined);
  assert.equal(dryer.power, 4000, 'kW converted');
});

test('the tree is bounded and keeps no prototype', () => {
  const tree = new HomieTree();
  assert.equal(tree.ingest(`ebus/5/${'x'.repeat(300)}/a/b`, Buffer.from('1')), undefined);
  assert.equal(tree.ingest('ebus/5/../a/b', Buffer.from('1')), undefined);
  assert.equal(tree.ingest('ebus/5/dev.ice/a/b', Buffer.from('1')), undefined);
  assert.equal(tree.ingest('ebus/5/dev/__proto__/b', Buffer.from('1')), undefined);
  assert.equal(tree.ingest('ebus/5/dev/a/b/set', Buffer.from('1')), undefined);
  assert.equal(tree.ingest('other/5/dev/a/b', Buffer.from('1')), undefined);
  assert.equal(tree.ingest('ebus/5/dev/a/b', Buffer.alloc(2000, 0x31)), undefined, 'too large');
  for (let i = 0; i < MAX_DEVICES + 5; i += 1) tree.ingest(`ebus/5/d${i}/a/b`, Buffer.from('1'));
  assert.equal(tree.devices.size, MAX_DEVICES);
  for (let i = 0; i < MAX_PROPERTIES + 5; i += 1)
    tree.ingest(`ebus/5/d0/n/p${i}`, Buffer.from('1'));
  assert.equal(tree.devices.get('d0').values.size, MAX_PROPERTIES);
  assert.ok(tree.dropped > 0);
  // An empty retained payload clears the value: unknown, never 0.
  tree.ingest('ebus/5/d1/a/b', Buffer.from(''));
  assert.equal(tree.text('d1', 'a', 'b'), undefined);
  const description = parseDescription(
    JSON.stringify({
      type: 't',
      nodes: {
        __proto__: { properties: {} },
        ok: { properties: { constructor: {}, p: { settable: 'yes' } } },
      },
    }),
  );
  assert.deepEqual([...description.nodes.keys()], ['ok']);
  // A Homie id may read "constructor": a key of a Map, never of an object.
  assert.ok(description.nodes.get('ok').properties instanceof Map);
  assert.deepEqual([...description.nodes.get('ok').properties.keys()], ['constructor', 'p']);
  assert.equal(description.nodes.get('ok').properties.get('p').settable, false);
  assert.equal(parseDescription('{"nodes":{}}'), undefined, 'no type');
  assert.equal(parseDescription('[1]'), undefined);
  assert.equal({}.polluted, undefined);
});

test('kWh of a counter: only a finite reading of the range', async () => {
  const { kwhOf } = await import('../src/devices.js');
  assert.equal(kwhOf(855286.5), 855.287);
  for (const bad of [-1, Infinity, NaN, 1e18, undefined])
    assert.equal(kwhOf(bad), undefined, String(bad));
});
