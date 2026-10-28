// -----------------------------------------------------------------------------
// The app on a fake mqtt.js client and the virtual clock: the session, the
// devices, the publication (interval, budget, freshness), the lifetime
// counters and their guards, /data, the status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, STATES_PER_MINUTE, STORED } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { certs } from './kit/index.mjs';
import { C, MINUTE, P, PIN, SECOND, createdDevices, settle, unit } from './helpers/app.js';
import { BROKER_PASSWORD, DRYER, PV_CIRCUIT, SERIAL, retainedTree } from './helpers/fakePanel.js';

const text = (m) => (m && typeof m === 'object' ? `${m.en} ${m.fr}` : String(m));
const status = (gladys) => text(gladys.fake.connectionStatus?.message);

/** Opens the session and delivers the retained tree; waits for the first reading. */
async function ready(ctx, topics) {
  ctx.client().open();
  ctx.client().tree(topics);
  await ctx.clock.advance(1100);
  await settle();
}

test('not paired: no session, the status says what to do', async () => {
  const ctx = await unit({ config: { [STORED.PASSWORD]: undefined } });
  assert.equal(ctx.connector.clients.length, 0);
  assert.match(status(ctx.gladys), /Not paired yet/);
  const noPin = await unit({ store: createMemoryStore() });
  assert.equal(noPin.connector.clients.length, 0, 'never without a pinned authority');
  assert.match(status(noPin.gladys), /Not paired yet/);
  const bad = await unit({ config: { host: 'http://x/y' } });
  assert.equal(bad.connector.clients.length, 0);
  assert.match(status(bad.gladys), /not valid/);
});

test('the session: pinned, the tree read, the devices in Discovery', async () => {
  const ctx = await unit();
  const client = ctx.client();
  assert.equal(client.config.pin.fingerprint, PIN.fingerprint);
  assert.equal(client.config.password, BROKER_PASSWORD);
  assert.equal(client.config.host, '127.0.0.1');
  assert.match(status(ctx.gladys), /Connecting/);
  client.open();
  assert.deepEqual([...client.subscriptions], ['ebus/5/#']);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0, 'nothing before the tree');
  client.tree();
  await ctx.clock.advance(1100);
  const devices = ctx.gladys.fake.discoveredDevices;
  assert.equal(devices.length, 17);
  const panel = devices[0];
  assert.equal(panel.external_id, `ext:span:panel:${SERIAL}`);
  assert.ok(panel.features.some((f) => f.external_id === P('battery_level')));
  const dryer = devices.find((d) => d.external_id.endsWith(DRYER));
  const relay = dryer.features.find((f) => f.external_id === C(DRYER, 'relay'));
  assert.equal(relay.read_only, false);
  assert.equal(relay.type, 'select');
  assert.notEqual(relay.category, 'switch');
  const pv = devices.find((d) => d.external_id.endsWith(PV_CIRCUIT));
  assert.equal(pv.features.find((f) => f.external_id.endsWith(':relay')).read_only, true);
  assert.ok(pv.features.some((f) => f.external_id.endsWith(':production_index')));
  assert.ok(!pv.features.some((f) => f.external_id.endsWith(':consumption_index')));
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.match(status(ctx.gladys), /nt-9874-s7rxt connected .* 16 circuits/);
  assert.match(status(ctx.gladys), /Create the devices/);
  assert.match(status(ctx.gladys), /read only/);
});

test('values only for created devices, at once on a ready panel, then at the interval', async () => {
  const ctx = await unit({ devices: createdDevices() });
  await ready(ctx);
  const { fake } = ctx.gladys;
  assert.equal(fake.lastState(C(DRYER, 'power')), 4);
  assert.equal(fake.lastState(C(DRYER, 'consumption_index')), 855.287);
  assert.equal(fake.lastState(C(PV_CIRCUIT, 'pv_power')), 1565.7);
  assert.equal(fake.lastState(C(PV_CIRCUIT, 'production_index')), 17468.812);
  assert.equal(fake.lastState(P('grid_power')), 1257);
  assert.equal(fake.lastState(P('feed_import_index')), 27610.15);
  assert.equal(fake.lastState(P('feed_export_total')), 4055.664);
  assert.equal(fake.lastState(P('main_relay')), 'CLOSED');
  assert.equal(fake.lastState(P('door')), undefined, 'UNKNOWN never published');
  assert.ok(!fake.states.some((s) => s.created_at), 'current values, no created_at');
  const before = fake.states.length;
  // A live change: published at the next interval (60 s), not before.
  ctx.client().deliver(`ebus/5/${DRYER}/meter/active-power`, '-1500.5');
  await ctx.clock.advance(30 * SECOND);
  assert.equal(fake.lastState(C(DRYER, 'power')), 4);
  await ctx.clock.advance(35 * SECOND);
  assert.equal(fake.lastState(C(DRYER, 'power')), 1500.5);
  assert.ok(fake.states.length > before);
});

test('a panel or a circuit no longer ready: its values are not published', async () => {
  const ctx = await unit({ devices: createdDevices() });
  await ready(ctx);
  const { fake } = ctx.gladys;
  ctx.client().deliver(`ebus/5/${DRYER}/$state`, 'lost');
  ctx.client().deliver(`ebus/5/${DRYER}/meter/active-power`, '-999');
  await ctx.clock.advance(65 * SECOND);
  assert.equal(fake.lastState(C(DRYER, 'power')), 4, 'the circuit lost: nothing new');
  ctx.client().deliver(`ebus/5/${SERIAL}/$state`, 'lost');
  ctx.client().deliver(`ebus/5/${SERIAL}/power-flows/grid`, '-5000');
  await ctx.clock.advance(65 * SECOND);
  assert.equal(fake.lastState(P('grid_power')), 1257);
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(status(ctx.gladys), /not ready \(lost\)/);
});

test('another panel at the address: nothing published, the status says so', async () => {
  const topics = new Map();
  for (const [topic, payload] of retainedTree()) {
    topics.set(
      topic.replaceAll(SERIAL, 'nt-5555-other'),
      payload.replaceAll(SERIAL, 'nt-5555-other'),
    );
  }
  const ctx = await unit({ devices: createdDevices() });
  await ready(ctx, topics);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  assert.equal(ctx.gladys.fake.states.length, 0);
  assert.match(status(ctx.gladys), /Another panel \(nt-5555-other\)/);
});

test('every session starts from an empty tree: nothing of the former one is published', async () => {
  const ctx = await unit({ devices: createdDevices() });
  await ready(ctx);
  const count = ctx.gladys.fake.states.length;
  ctx.client().close();
  await settle();
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(status(ctx.gladys), /cannot be reached .* new try in 5 s/);
  await ctx.clock.advance(5 * SECOND);
  assert.equal(ctx.connector.clients.length, 2);
  ctx.client().open();
  await ctx.clock.advance(2 * MINUTE);
  assert.equal(ctx.gladys.fake.states.length, count, 'no tree yet: nothing');
  assert.match(status(ctx.gladys), /waiting for the panel to describe itself/);
});

test('reconnections: 5 s, 15 s, 30 s... and back to 5 s after a ready panel', async () => {
  const ctx = await unit();
  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    const n = ctx.connector.clients.length;
    ctx.client().fail('ECONNREFUSED');
    const start = ctx.clock.elapsed;
    while (ctx.connector.clients.length === n) await ctx.clock.advance(SECOND);
    waits.push(Math.round((ctx.clock.elapsed - start) / SECOND));
  }
  assert.deepEqual(waits, [5, 15, 30, 60]);
  await ready(ctx);
  ctx.client().close();
  const n = ctx.connector.clients.length;
  await ctx.clock.advance(5 * SECOND);
  assert.equal(ctx.connector.clients.length, n + 1);
});

test('credentials refused: a final stop kept in /data, lifted by a new pairing only', async () => {
  const store = createMemoryStore({ ca: PIN });
  const ctx = await unit({ store });
  ctx.client().refuse(4);
  await settle();
  assert.match(status(ctx.gladys), /refuses the credentials/);
  assert.equal(store.data.refusal.code, 'refused');
  assert.match(store.data.refusal.fp, /^[0-9a-f]{2}$/);
  await ctx.clock.advance(30 * MINUTE);
  assert.equal(ctx.connector.clients.length, 1, 'never tried again by itself');
  // A restart (same credentials): still stopped.
  const again = await unit({ store });
  assert.equal(again.connector.clients.length, 0);
  // New credentials (a new pairing): tried.
  const paired = await unit({ store, config: { [STORED.PASSWORD]: 'another-password' } });
  assert.equal(paired.connector.clients.length, 1);
  paired.client().open();
  await settle();
  assert.equal(store.data.refusal, null);
});

test('a CONNECT left unanswered twice in a row: a final stop too', async () => {
  const ctx = await unit();
  ctx.client().unanswered();
  await ctx.clock.advance(5 * SECOND);
  assert.equal(ctx.connector.clients.length, 2);
  ctx.client().unanswered();
  await ctx.clock.advance(10 * MINUTE);
  assert.equal(ctx.connector.clients.length, 2);
  assert.equal(ctx.store.data.refusal.code, 'refused');
});

test('getConfig() failing in `connected` is asked again without end, then starts', async () => {
  const ctx = await unit();
  await ctx.app.stop();
  const clients = ctx.connector.clients.length;
  const real = ctx.gladys.getConfig.bind(ctx.gladys);
  let calls = 0;
  ctx.gladys.getConfig = async () => {
    calls += 1;
    if (calls <= 2) throw new Error('gladys busy');
    return real();
  };
  ctx.gladys.emit('connected');
  await settle();
  assert.equal(ctx.connector.clients.length, clients);
  assert.match(status(ctx.gladys), /could not be read from Gladys: new try in 5 s/);
  await ctx.clock.advance(5 * SECOND);
  assert.match(status(ctx.gladys), /new try in 15 s/);
  await ctx.clock.advance(15 * SECOND);
  assert.equal(calls, 3);
  assert.equal(ctx.connector.clients.length, clients + 1);
});

/** The capture with `n` more circuits, copies of the dryer (ids c000..., names Copy n). */
function bigTree(n) {
  const topics = retainedTree();
  const prefix = `ebus/5/${DRYER}/`;
  for (let i = 0; i < n; i += 1) {
    const id = `c${String(i).padStart(31, '0')}`;
    for (const [topic, payload] of retainedTree()) {
      if (!topic.startsWith(prefix)) continue;
      const key = topic.slice(prefix.length);
      topics.set(`ebus/5/${id}/${key}`, key === 'info/name' ? `Copy ${i}` : payload);
    }
  }
  return topics;
}

test('the budget: never more than 270 states a minute, every circuit in turn', async () => {
  const topics = bigTree(44);
  const ctx = await unit({ devices: createdDevices(topics), config: { publish_interval: 30 } });
  await ready(ctx, topics);
  const { fake } = ctx.gladys;
  const marks = [];
  for (let round = 1; round <= 8; round += 1) {
    for (const [topic, payload] of topics) {
      if (/active-power$/.test(topic)) ctx.client().deliver(topic, String(-round * 10));
      if (/exported-energy$|imported-energy$/.test(topic)) {
        ctx.client().deliver(topic, String(Number(payload) + round * 50));
      }
    }
    marks.push({ at: ctx.clock.elapsed, count: fake.states.length });
    await ctx.clock.advance(35 * SECOND);
  }
  marks.push({ at: ctx.clock.elapsed, count: fake.states.length });
  const perRound = marks.slice(1).map((m, i) => m.count - marks[i].count);
  for (let i = 1; i < perRound.length; i += 1) {
    assert.ok(perRound[i - 1] + perRound[i] <= STATES_PER_MINUTE, String(perRound));
  }
  // The rotation forgets no circuit: each one got values in the last four rounds.
  const recent = new Set(
    fake.states.slice(marks[4].count).map((s) => s.device_feature_external_id),
  );
  for (let i = 0; i < 44; i += 1) {
    const id = C(`c${String(i).padStart(31, '0')}`, 'power');
    assert.ok(recent.has(id), id);
  }
  assert.ok(
    perRound.slice(1).every((n) => n > 0),
    `a round sent nothing: ${perRound}`,
  );
});

test('counters: never 0, a drop held and sent again unchanged, accepted in two clicks', async () => {
  const ctx = await unit({ devices: createdDevices() });
  await ready(ctx);
  const { fake } = ctx.gladys;
  const id = C(DRYER, 'consumption_index');
  assert.equal(fake.lastState(id), 855.287);
  ctx.client().deliver(`ebus/5/${DRYER}/meter/exported-energy`, '0');
  await ctx.clock.advance(65 * SECOND);
  assert.equal(fake.lastState(id), 855.287, 'never 0');
  ctx.client().deliver(`ebus/5/${DRYER}/meter/exported-energy`, '12000');
  await ctx.clock.advance(65 * SECOND);
  assert.equal(fake.lastState(id), 855.287, 'a drop is held');
  assert.ok(!fake.states.some((s) => s.device_feature_external_id === id && s.state < 855.287));
  assert.match(
    status(ctx.gladys),
    /Counter "Clothes-Dryer": dropped from 855\.287 to 12 kWh, held back/,
  );
  assert.equal(ctx.store.data.counters[id].guard.held.direction, 'down');
  // Time never confirms it.
  await ctx.clock.advance(3 * 60 * MINUTE);
  assert.equal(fake.lastState(id), 855.287);
  // Two clicks: the first lists, the second accepts.
  const first = await fake.action(ACTIONS.ACCEPT_HELD, {});
  assert.match(text(first.data.message), /Clothes-Dryer: 855\.287 → 12 kWh/);
  assert.equal(fake.lastState(id), 855.287);
  // A second click under 3 s lists again, accepts nothing.
  await ctx.clock.advance(SECOND);
  const early = await fake.action(ACTIONS.ACCEPT_HELD, {});
  assert.match(text(early.data.message), /A second click accepts exactly/);
  assert.ok(ctx.app.guards.get(id).held);
  await ctx.clock.advance(4 * SECOND);
  const second = await fake.action(ACTIONS.ACCEPT_HELD, {});
  assert.match(text(second.data.message), /Accepted: Clothes-Dryer 12 kWh/);
  ctx.client().deliver(`ebus/5/${DRYER}/meter/exported-energy`, '12100');
  await ctx.clock.advance(65 * SECOND);
  assert.equal(fake.lastState(id), 12.1);
});

test('a counter jump is held too; the held state survives a restart (/data)', async () => {
  const store = createMemoryStore({ ca: PIN });
  const ctx = await unit({ store, devices: createdDevices() });
  await ready(ctx);
  const id = P('feed_import_index');
  ctx.client().deliver(`ebus/5/${SERIAL}-lugs-up/meter/imported-energy`, '99610149.5');
  await ctx.clock.advance(65 * SECOND);
  assert.equal(ctx.gladys.fake.lastState(id), 27610.15);
  assert.equal(store.data.counters[id].guard.held.direction, 'up');
  await ctx.app.stop();
  const again = await unit({ store, devices: createdDevices() });
  await ready(
    again,
    new Map([...retainedTree(), [`ebus/5/${SERIAL}-lugs-up/meter/imported-energy`, '99610149.5']]),
  );
  assert.equal(again.gladys.fake.lastState(id), 27610.15, 'still held after the restart');
  assert.match(status(again.gladys), /jumped from 27610\.15 to 99610\.15 kWh/);
});

test('/data cannot be written: the counters are not sent, the other values are', async () => {
  const store = createMemoryStore({ ca: PIN });
  const ctx = await unit({ store, devices: createdDevices() });
  store.failSave = true;
  await ready(ctx);
  assert.equal(ctx.gladys.fake.lastState(C(DRYER, 'consumption_index')), undefined);
  assert.equal(ctx.gladys.fake.lastState(C(DRYER, 'power')), 4);
  assert.match(status(ctx.gladys), /cannot be written/);
});

test('/data unreadable: left as it is, no session, nothing written', async () => {
  const store = createMemoryStore({ ca: PIN }, { unreadable: true });
  const ctx = await unit({ store });
  assert.equal(ctx.connector.clients.length, 0);
  assert.equal(store.saves, 0);
  assert.match(status(ctx.gladys), /cannot be read: it is left as it is/);
  const pair = await ctx.gladys.fake.action(ACTIONS.PAIR, {});
  assert.match(text(pair.data.message), /cannot be read: no pairing/);
});

test('a device created later gets the values of the session at once', async () => {
  const ctx = await unit();
  await ready(ctx);
  assert.equal(ctx.gladys.fake.states.length, 0);
  const [panelDevice] = createdDevices();
  await ctx.gladys.fake.deviceCreated(panelDevice);
  await settle();
  assert.equal(ctx.gladys.fake.lastState(P('grid_power')), 1257);
});

test('a relay changed on the panel is published at once, not at the interval', async () => {
  const ctx = await unit({ devices: createdDevices() });
  await ready(ctx);
  ctx.client().deliver(`ebus/5/${DRYER}/switch/relay-requester`, 'LOAD_SHED');
  ctx.client().deliver(`ebus/5/${DRYER}/switch/relay`, 'OPEN');
  await ctx.clock.advance(400);
  assert.equal(ctx.gladys.fake.lastState(C(DRYER, 'relay')), 'OPEN');
  assert.equal(ctx.gladys.fake.lastState(C(DRYER, 'relay_requester')), 'LOAD_SHED');
});

test('no secret in the status, the logs nor /data', async () => {
  const logger = { lines: [] };
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => logger.lines.push(args.join(' '));
  }
  const store = createMemoryStore({ ca: PIN });
  const ctx = await unit({
    store,
    logger,
    devices: createdDevices(),
    config: { passphrase: 'pass-phrase-1' },
  });
  await ready(ctx);
  ctx.client().refuse(4);
  await settle();
  const everything = JSON.stringify([logger.lines, ctx.gladys.fake.connectionStatuses, store.data]);
  for (const secret of [BROKER_PASSWORD, 'pass-phrase-1']) {
    assert.ok(!everything.includes(secret), secret);
  }
});

test('a certificate the pin refuses: the authority advertised is fetched at most every 15 min', async () => {
  let calls = 0;
  const other = {
    pem: certs.impostor.cert,
    fingerprint: certs.impostor.fingerprint256.replaceAll(':', '').toLowerCase(),
  };
  const http = {
    getCa: async () => {
      calls += 1;
      return other;
    },
  };
  const ctx = await unit({ http });
  for (let i = 0; i < 6; i += 1) {
    const n = ctx.connector.clients.length;
    ctx.client().fail('DEPTH_ZERO_SELF_SIGNED_CERT');
    await settle();
    while (ctx.connector.clients.length === n) await ctx.clock.advance(5 * SECOND);
  }
  assert.ok(ctx.clock.elapsed < 15 * MINUTE);
  assert.equal(calls, 1);
  assert.match(status(ctx.gladys), /does not sign: nothing was sent to it/);
  // Shown, never pinned by itself.
  assert.equal(ctx.store.data.ca.fingerprint, PIN.fingerprint);
  assert.equal(ctx.store.data.seen.fingerprint, other.fingerprint);
  assert.equal(ctx.client().config.pin.fingerprint, PIN.fingerprint);
  assert.match(status(ctx.gladys), /It now advertises the authority/);
  await ctx.clock.advance(15 * MINUTE);
  ctx.client().fail('DEPTH_ZERO_SELF_SIGNED_CERT');
  await settle();
  assert.equal(calls, 2);
});

test('a CONNECT unanswered, then a session, then unanswered again: no stop (not in a row)', async () => {
  const ctx = await unit();
  ctx.client().unanswered();
  await ctx.clock.advance(5 * SECOND);
  ctx.client().open();
  ctx.client().close();
  await ctx.clock.advance(15 * SECOND);
  ctx.client().unanswered();
  await ctx.clock.advance(30 * SECOND);
  assert.equal(ctx.store.data.refusal ?? null, null);
  assert.equal(ctx.connector.clients.length, 4);
});

test('budget spent: a relay change waits, never beyond 270 states a minute', async () => {
  const ctx = await unit({ devices: createdDevices() });
  await ready(ctx);
  ctx.app.sent.push({ at: ctx.app.monotonic(), count: STATES_PER_MINUTE });
  ctx.client().deliver(`ebus/5/${DRYER}/switch/relay`, 'OPEN');
  await ctx.clock.advance(400);
  assert.equal(ctx.gladys.fake.lastState(C(DRYER, 'relay')), 'CLOSED');
});

test('a configuration saved while getConfig() fails: no retry of the old attempt overrides it', async () => {
  const ctx = await unit();
  let reject;
  ctx.gladys.getConfig = () => new Promise((_, r) => (reject = r));
  ctx.gladys.emit('connected');
  await settle();
  await ctx.gladys.fake.configUpdated({ ...ctx.gladys.fake.config });
  await ctx.app.idle();
  const clients = ctx.connector.clients.length;
  reject(new Error('late failure'));
  await settle();
  assert.doesNotMatch(status(ctx.gladys), /could not be read from Gladys/);
  await ctx.clock.advance(2 * MINUTE);
  assert.equal(ctx.connector.clients.length, clients, 'no restart by the old attempt');
});
