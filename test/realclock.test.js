// -----------------------------------------------------------------------------
// Clocks: the publication period measured on the real clock sped up 20 times
// (never faster than the interval, never a cycle late), and the guards of the
// counters on the session clock (a wall clock moved by NTP never widens their
// margin).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurePeriod, realClock, spyOn, testClock } from './kit/index.mjs';
import { C, SECOND, START, createdDevices, settle, unit } from './helpers/app.js';
import { DRYER } from './helpers/fakePanel.js';

test('real clock x20: one publication per interval (30 s), measured', async (t) => {
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const ctx = await unit({ clock, devices: createdDevices(), config: { publish_interval: 30 } });
  t.after(() => ctx.app.stop());
  const spy = spyOn(ctx.app, 'flush', clock);
  ctx.client().open();
  ctx.client().tree();
  // Values keep changing, as a real panel pushes them.
  let n = 0;
  const feeder = setInterval(() => {
    n += 1;
    ctx.client().deliver(`ebus/5/${DRYER}/meter/active-power`, String(-n));
  }, 50);
  t.after(() => clearInterval(feeder));
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
  assert.ok(ctx.gladys.fake.lastState(C(DRYER, 'power')) > 0);
});

test('the guards run on the session clock: NTP moving the wall clock 6 h widens nothing', async () => {
  const base = testClock({ start: START });
  let jump = 0;
  const clock = {
    ...base,
    now: () => base.now() + jump,
    timers: base.timers,
    advance: base.advance,
  };
  const ctx = await unit({ clock, devices: createdDevices() });
  ctx.client().open();
  ctx.client().tree();
  await base.advance(1100);
  const id = C(DRYER, 'consumption_index');
  assert.equal(ctx.gladys.fake.lastState(id), 855.287);
  // The wall clock jumps 6 h ahead; 65 s really pass; the counter rises 100 kWh.
  jump = 6 * 3600 * SECOND;
  ctx.client().deliver(`ebus/5/${DRYER}/meter/exported-energy`, String(855286.5 + 100_000));
  await base.advance(65 * SECOND);
  await settle();
  assert.equal(
    ctx.gladys.fake.lastState(id),
    855.287,
    '100 kWh in 65 s is held, whatever the wall clock',
  );
  assert.equal(ctx.app.guards.get(id).held.direction, 'up');
});
