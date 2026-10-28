// -----------------------------------------------------------------------------
// The pairing (button "Pair with the panel") on a fake REST side and the
// virtual clock: the trust decision on the certificate authority (pin, typed
// fingerprint, second click), its check, its pin in /data before any secret
// leaves, one registration per click, the credentials kept by Gladys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, STORED } from '../src/constants.js';
import { createMemoryStore, shownFingerprint } from '../src/store.js';
import { certs } from './kit/index.mjs';
import { PIN, SECOND, settle, unit } from './helpers/app.js';
import { SERIAL } from './helpers/fakePanel.js';

const text = (m) => (m && typeof m === 'object' ? `${m.en} ${m.fr}` : String(m));
const NEW = {
  pem: certs.impostor.cert,
  fingerprint: certs.impostor.fingerprint256.replaceAll(':', '').toLowerCase(),
};

/** A REST side: `candidate` advertised, `register` answering (a function or an error reason). */
function fakeHttp({ candidate = PIN, register, serial = SERIAL } = {}) {
  const calls = { status: 0, ca: 0, register: [] };
  return {
    calls,
    getStatus: async () => {
      calls.status += 1;
      return { serial, firmware: 'spanos3/r202639/03' };
    },
    getCa: async () => {
      calls.ca += 1;
      return candidate;
    },
    register: async (args) => {
      calls.register.push(args);
      if (typeof register === 'string')
        throw Object.assign(new Error(register), { reason: register });
      return (
        register?.(args) ?? {
          username: 'new-user',
          password: 'new-broker-password',
          port: 8883,
          serial,
        }
      );
    },
  };
}

async function setup({ http = fakeHttp(), store = createMemoryStore(), config = {}, probe } = {}) {
  const ctx = await unit({
    store,
    http,
    probe,
    config: {
      [STORED.USERNAME]: undefined,
      [STORED.PASSWORD]: undefined,
      [STORED.SERIAL]: undefined,
      passphrase: 'label-passphrase',
      ...config,
    },
  });
  ctx.http = http;
  ctx.pair = async () => text((await ctx.gladys.fake.action(ACTIONS.PAIR, {})).data?.message);
  return ctx;
}

test('two clicks: the first shows the fingerprint and sends nothing, the second pairs', async () => {
  const ctx = await setup();
  const first = await ctx.pair();
  assert.match(first, new RegExp(shownFingerprint(PIN.fingerprint)));
  assert.match(first, /Nothing was sent yet/);
  assert.equal(ctx.http.calls.register.length, 0);
  assert.equal(ctx.store.data.ca ?? null, null, 'nothing pinned on the first click');
  await ctx.clock.advance(4 * SECOND);
  const second = await ctx.pair();
  assert.match(second, /Paired with the SPAN panel nt-9874-s7rxt: connecting/);
  assert.equal(ctx.http.calls.register.length, 1);
  assert.equal(ctx.http.calls.register[0].passphrase, 'label-passphrase');
  assert.equal(ctx.http.calls.register[0].pin.fingerprint, PIN.fingerprint);
  assert.equal(ctx.store.data.ca.fingerprint, PIN.fingerprint);
  assert.equal(ctx.gladys.fake.config[STORED.PASSWORD], 'new-broker-password');
  assert.equal(ctx.gladys.fake.config[STORED.SERIAL], SERIAL);
  await ctx.app.idle();
  await settle();
  const client = ctx.client();
  assert.equal(client.config.password, 'new-broker-password');
  assert.equal(client.config.pin.fingerprint, PIN.fingerprint);
});

test('the second click too soon, too late, or for another authority: listed again, nothing sent', async () => {
  const ctx = await setup();
  await ctx.pair();
  await ctx.clock.advance(SECOND);
  assert.match(await ctx.pair(), /Nothing was sent yet/, 'under 3 s');
  await ctx.clock.advance(6 * 60 * SECOND);
  assert.match(await ctx.pair(), /Nothing was sent yet/, 'over 5 min');
  ctx.http.getCa = async () => NEW;
  await ctx.clock.advance(4 * SECOND);
  assert.match(await ctx.pair(), new RegExp(shownFingerprint(NEW.fingerprint)));
  assert.equal(ctx.http.calls.register.length, 0);
});

test('the fingerprint typed in the form: one click; a different one: refused', async () => {
  const typed = await setup({ config: { ca_fingerprint: shownFingerprint(PIN.fingerprint) } });
  assert.match(await typed.pair(), /Paired with/);
  const other = await setup({ config: { ca_fingerprint: shownFingerprint(NEW.fingerprint) } });
  assert.match(await other.pair(), /not the fingerprint typed in the configuration/);
  assert.equal(other.http.calls.register.length, 0);
});

test('a pinned authority is kept; another one advertised needs the two clicks again', async () => {
  const kept = await setup({ store: createMemoryStore({ ca: PIN }) });
  assert.match(await kept.pair(), /Paired with/, 'the pin itself: one click');
  const changed = await setup({
    store: createMemoryStore({ ca: PIN }),
    http: fakeHttp({ candidate: NEW }),
  });
  const first = await changed.pair();
  assert.match(first, /now advertises another certificate authority/);
  assert.match(first, new RegExp(shownFingerprint(PIN.fingerprint)));
  assert.equal(changed.store.data.ca.fingerprint, PIN.fingerprint);
});

test('the authority must sign the HTTPS certificate of the panel; then pinned before the secret leaves', async () => {
  const order = [];
  const store = createMemoryStore();
  const http = fakeHttp({
    register: () => {
      order.push(`register (pinned: ${Boolean(store.data.ca)})`);
      return undefined;
    },
  });
  const refused = await setup({
    config: { ca_fingerprint: shownFingerprint(PIN.fingerprint) },
    probe: async () => {
      throw Object.assign(new Error('x'), { reason: 'untrusted' });
    },
  });
  assert.match(await refused.pair(), /does not sign the HTTPS certificate/);
  assert.equal(refused.http.calls.register.length, 0);
  assert.equal(refused.store.data.ca ?? null, null);
  const ok = await setup({
    store,
    http,
    config: { ca_fingerprint: shownFingerprint(PIN.fingerprint) },
  });
  await ok.pair();
  assert.deepEqual(order, ['register (pinned: true)']);
});

test('/data cannot be written: nothing pinned, nothing sent', async () => {
  const store = createMemoryStore();
  const ctx = await setup({ store, config: { ca_fingerprint: shownFingerprint(PIN.fingerprint) } });
  store.failSave = true;
  assert.match(await ctx.pair(), /could not be kept in \/data: nothing was sent/);
  assert.equal(ctx.http.calls.register.length, 0);
  assert.equal(ctx.app.kept.ca, null);
});

test('the answers of the registration: each its own message, nothing kept', async () => {
  const fp = { ca_fingerprint: shownFingerprint(PIN.fingerprint) };
  const cases = [
    ['refused', {}, /refused the passphrase/],
    [
      'refused',
      { passphrase: '' },
      /did not accept the pairing by proximity: open and close the door/,
    ],
    ['unavailable', {}, /cannot read its own passphrase/],
    ['notReady', {}, /starting/],
    ['badAnswer', {}, /unreadable: nothing kept/],
    ['timeout', {}, /failed \(no answer in time\): it may or may not have been received/],
  ];
  for (const [reason, extra, expected] of cases) {
    const ctx = await setup({ http: fakeHttp({ register: reason }), config: { ...fp, ...extra } });
    assert.match(await ctx.pair(), expected, reason);
    assert.equal(ctx.gladys.fake.config[STORED.PASSWORD], undefined);
  }
  const proximity = await setup({ config: { ...fp, passphrase: '' } });
  assert.match(await proximity.pair(), /\(by proximity\)/);
  assert.equal(proximity.http.calls.register[0].passphrase, undefined);
});

test('another panel registered than the one that answered first: nothing kept', async () => {
  const ctx = await setup({
    http: fakeHttp({
      register: () => ({ username: 'u', password: 'p', port: 8883, serial: 'nt-0000-other' }),
    }),
    config: { ca_fingerprint: shownFingerprint(PIN.fingerprint) },
  });
  assert.match(await ctx.pair(), /is not the one that answered first/);
  assert.equal(ctx.gladys.fake.config[STORED.PASSWORD], undefined);
});

test('Gladys does not keep the credentials: said, the click can be repeated', async () => {
  const ctx = await setup({ config: { ca_fingerprint: shownFingerprint(PIN.fingerprint) } });
  ctx.gladys.setConfig = async () => {
    throw new Error('500');
  };
  assert.match(await ctx.pair(), /did not keep the credentials/);
});

test('one pairing at a time; a panel unreachable: nothing sent', async () => {
  let release;
  const http = fakeHttp();
  http.getStatus = () => new Promise((resolve) => (release = resolve));
  const ctx = await setup({ http });
  const first = ctx.pair();
  await settle();
  assert.match(await ctx.pair(), /already running/);
  release({ serial: SERIAL });
  await first;
  const down = fakeHttp();
  down.getStatus = async () => {
    throw Object.assign(new Error('x'), { reason: 'refusedPort' });
  };
  const ctx2 = await setup({ http: down });
  assert.match(await ctx2.pair(), /could not be read \(connection refused\). Nothing was sent/);
});

test('a new pairing lifts a refusal of the broker', async () => {
  const store = createMemoryStore({ ca: PIN, refusal: { code: 'refused', fp: '00' } });
  const ctx = await setup({ store });
  assert.match(await ctx.pair(), /Paired with/);
  assert.equal(store.data.refusal, null);
  await ctx.app.idle();
  assert.equal(ctx.connector.clients.length, 1);
});

test('the authority seen after a pin failure is pinned when the user types its fingerprint', async () => {
  const store = createMemoryStore({ ca: PIN, seen: NEW });
  const ctx = await unit({ store });
  assert.equal(ctx.client().config.pin.fingerprint, PIN.fingerprint);
  await ctx.gladys.fake.configUpdated({
    ...ctx.gladys.fake.config,
    ca_fingerprint: shownFingerprint(NEW.fingerprint),
  });
  await ctx.app.idle();
  assert.equal(store.data.ca.fingerprint, NEW.fingerprint);
  assert.equal(store.data.seen, null);
  assert.equal(ctx.client().config.pin.fingerprint, NEW.fingerprint);
});
