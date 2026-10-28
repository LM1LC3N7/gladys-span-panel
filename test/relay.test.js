// -----------------------------------------------------------------------------
// The relay commands (the `relay` list of a circuit): off by default, decided
// on the state of the session, one at a time per circuit, never queued,
// confirmed only by the state the panel publishes back.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, SECOND, createdDevices, settle, unit } from './helpers/app.js';
import { DRYER, PV_CIRCUIT, SERIAL } from './helpers/fakePanel.js';

const CIRCUITS = [
  DRYER,
  'cb26f4260adebb7b71de48682618db0a',
  '9498a44c930374d2ea1e9508c3def44e',
  'c00a7e2e5d468da627d084071177d865',
  '704b457f76e9451eb44fbc8287e67f9f',
];

/** A ready session; `applyMs`: the panel applies a relay command after this delay (null: never). */
async function setup({ allow = true, applyMs = 400, config = {} } = {}) {
  const ctx = await unit({
    devices: createdDevices(),
    config: { allow_relay_control: allow, ...config },
  });
  ctx.connector.responder = (topic, payload, client) => {
    const match = /^ebus\/5\/([^/]+)\/switch\/relay\/set$/.exec(topic);
    if (!match || applyMs === null) return;
    ctx.clock.timers.setTimeout(() => {
      client.deliver(`ebus/5/${match[1]}/switch/relay-requester`, 'USER');
      client.deliver(`ebus/5/${match[1]}/switch/relay`, payload);
    }, applyMs);
  };
  ctx.client().open();
  ctx.client().tree();
  await ctx.clock.advance(1100);
  return ctx;
}

/** setValue through the fake Gladys, the virtual clock moving meanwhile. */
async function command(ctx, circuit, value, { advance = 4 * SECOND } = {}) {
  const ack = ctx.gladys.fake.setValue(
    { external_id: `ext:span:circuit:${SERIAL}_${circuit}` },
    { external_id: C(circuit, 'relay') },
    value,
  );
  // The command starts at once (as in production), then the time moves.
  await settle();
  if (advance > 0) await ctx.clock.advance(advance);
  return ack;
}

const sent = (ctx) => ctx.connector.clients.flatMap((c) => c.commands());

test('off by default: every command refused, nothing sent', async () => {
  const ctx = await setup({ allow: false });
  for (const value of ['OPEN', 'CLOSED']) {
    const ack = await command(ctx, DRYER, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /off in the configuration.*nothing sent/);
  }
  assert.deepEqual(sent(ctx), []);
});

test('open then close: sent once each, QoS 0, confirmed by the state published back', async () => {
  const ctx = await setup();
  const open = await command(ctx, DRYER, 'OPEN');
  assert.deepEqual(open, { success: true });
  assert.deepEqual(sent(ctx), [
    { topic: `ebus/5/${DRYER}/switch/relay/set`, payload: 'OPEN', qos: 0, retain: false },
  ]);
  assert.equal(ctx.gladys.fake.lastState(C(DRYER, 'relay')), 'OPEN');
  const close = await command(ctx, DRYER, 'closed');
  assert.deepEqual(close, { success: true });
  assert.equal(sent(ctx).length, 2);
  assert.equal(ctx.gladys.fake.lastState(C(DRYER, 'relay')), 'CLOSED');
});

test('no state back in time, or the state before: "sent, without confirmation"', async () => {
  const ctx = await setup({ applyMs: null });
  const ack = await command(ctx, DRYER, 'OPEN');
  assert.equal(ack.success, false);
  assert.match(ack.error, /^Sent, without confirmation/);
  assert.equal(sent(ctx).length, 1);
  // The panel publishes the state before (not applied): not a confirmation either.
  ctx.connector.responder = (topic, payload, client) =>
    client.deliver(`ebus/5/${DRYER}/switch/relay`, 'CLOSED');
  const again = await command(ctx, DRYER, 'OPEN');
  assert.match(again.error, /^Sent, without confirmation/);
});

test('already in that state: nothing sent', async () => {
  const ctx = await setup();
  assert.deepEqual(await command(ctx, DRYER, 'CLOSED'), { success: true });
  assert.deepEqual(sent(ctx), []);
});

test('refused, nothing sent: not commandable, unknown state, bad value, another panel', async () => {
  const ctx = await setup();
  const pv = await command(ctx, PV_CIRCUIT, 'OPEN');
  assert.match(pv.error, /does not allow commanding the relay/);
  ctx.client().deliver(`ebus/5/${DRYER}/switch/relay-controllable`, 'false');
  assert.match((await command(ctx, DRYER, 'OPEN')).error, /does not allow/);
  ctx.client().deliver(`ebus/5/${DRYER}/switch/relay-controllable`, 'true');
  ctx.client().deliver(`ebus/5/${DRYER}/switch/relay`, 'UNKNOWN');
  assert.match((await command(ctx, DRYER, 'OPEN')).error, /not known yet/);
  for (const value of ['ON', 1, '', undefined]) {
    assert.match((await command(ctx, CIRCUITS[1], value)).error, /OPEN or CLOSED/);
  }
  const other = await ctx.gladys.fake.setValue(
    { external_id: 'ext:span:circuit:nt-0000-zzz_x' },
    { external_id: `ext:span:circuit:nt-0000-zzz_${DRYER}:relay` },
    'OPEN',
  );
  assert.match(other.error, /not a relay of the paired panel/);
  const power = await ctx.gladys.fake.setValue({}, { external_id: C(DRYER, 'power') }, 'OPEN');
  assert.match(power.error, /not a relay/);
  assert.deepEqual(sent(ctx), []);
});

test('no session, no tree, a lost panel: refused, nothing sent', async () => {
  const ctx = await setup();
  ctx.client().deliver(`ebus/5/${SERIAL}/$state`, 'lost');
  assert.match((await command(ctx, DRYER, 'OPEN')).error, /not ready/);
  ctx.client().close();
  await settle();
  assert.match((await command(ctx, DRYER, 'OPEN')).error, /not connected/);
  // A new session before its tree: nothing of the former one is used.
  await ctx.clock.advance(5 * SECOND);
  ctx.client().open();
  assert.match((await command(ctx, DRYER, 'OPEN')).error, /not ready/);
  assert.deepEqual(sent(ctx), []);
});

test('the publication fails: "nothing sent"', async () => {
  const ctx = await setup();
  ctx.client().publishError = new Error('client disconnecting');
  const ack = await command(ctx, DRYER, 'OPEN');
  assert.match(ack.error, /could not be sent.*nothing sent/);
});

test('the option re-checked right before sending: a queued command is refused', async () => {
  const ctx = await setup({ applyMs: 1500 });
  const first = command(ctx, DRYER, 'OPEN', { advance: 0 });
  await settle();
  const second = command(ctx, DRYER, 'CLOSED', { advance: 0 });
  await settle();
  // The user unchecks the option while the first one waits for its confirmation.
  ctx.app.config = { ...ctx.app.config, allowRelay: false };
  await ctx.clock.advance(4 * SECOND);
  assert.deepEqual(await first, { success: true });
  assert.match((await second).error, /off in the configuration/);
  assert.deepEqual(
    sent(ctx).map((c) => c.payload),
    ['OPEN'],
  );
});

test('one command at a time per circuit; one waiting too long is refused unsent', async () => {
  const ctx = await setup({ applyMs: 3000 });
  const first = command(ctx, DRYER, 'OPEN', { advance: 0 });
  await settle();
  const second = command(ctx, DRYER, 'CLOSED', { advance: 0 });
  await settle();
  assert.equal(sent(ctx).length, 1, 'the second waits for the first');
  await ctx.clock.advance(6 * SECOND);
  assert.deepEqual(await first, { success: true });
  assert.match((await second).error, /waited too long.*nothing sent/);
  assert.equal(sent(ctx).length, 1);
});

test('a scene on five slow circuits: all five sent at once and confirmed', async () => {
  const ctx = await setup({ applyMs: 900 });
  const acks = CIRCUITS.map((c) => command(ctx, c, 'OPEN', { advance: 0 }));
  await settle();
  assert.equal(sent(ctx).length, 5, 'never serialized across circuits');
  await ctx.clock.advance(4 * SECOND);
  for (const ack of await Promise.all(acks)) assert.deepEqual(ack, { success: true });
  for (const c of CIRCUITS) assert.equal(ctx.gladys.fake.lastState(C(c, 'relay')), 'OPEN');
});

test('the session ends while waiting: "sent, without confirmation", never a success', async () => {
  const ctx = await setup({ applyMs: 2000 });
  const ack = command(ctx, DRYER, 'OPEN', { advance: 0 });
  await settle();
  ctx.client().close();
  await ctx.clock.advance(4 * SECOND);
  assert.match((await ack).error, /^Sent, without confirmation/);
});

test('the option off refuses at once, even behind a command still in flight', async () => {
  const ctx = await setup({ applyMs: 1500 });
  const first = command(ctx, DRYER, 'OPEN', { advance: 0 });
  await settle();
  ctx.app.config = { ...ctx.app.config, allowRelay: false };
  let second;
  command(ctx, DRYER, 'CLOSED', { advance: 0 }).then((ack) => (second = ack));
  await settle();
  assert.match(second?.error ?? 'still waiting', /off in the configuration/, 'never queued');
  await ctx.clock.advance(4 * SECOND);
  assert.deepEqual(await first, { success: true });
});

test('a session still connecting (no CONNACK yet): "not connected", nothing sent', async () => {
  const ctx = await unit({ devices: createdDevices(), config: { allow_relay_control: true } });
  const ack = await command(ctx, DRYER, 'OPEN');
  assert.match(ack.error, /not connected/);
  assert.deepEqual(sent(ctx), []);
});

test('a relay controllable but not declared settable by the panel: refused, nothing sent', async () => {
  const ctx = await setup();
  ctx.client().deliver(`ebus/5/${PV_CIRCUIT}/switch/relay-controllable`, 'true');
  assert.match((await command(ctx, PV_CIRCUIT, 'OPEN')).error, /does not allow/);
  assert.deepEqual(sent(ctx), []);
});

test('a panel silent too long: its relay state is not current, refused, nothing sent', async () => {
  const ctx = await setup();
  await ctx.clock.advance(6 * 60 * SECOND);
  assert.match((await command(ctx, DRYER, 'OPEN')).error, /sent nothing for several minutes/);
  assert.deepEqual(sent(ctx), []);
});
