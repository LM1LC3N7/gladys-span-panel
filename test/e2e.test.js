// -----------------------------------------------------------------------------
// End to end, on loopback: the real HTTP, HTTPS and MQTTS transports of the
// integration against the fake panel (test/helpers/fakePanel.js), real time.
// Pairing in two clicks, the passphrase only over the pinned HTTPS, the
// broker password only on the pinned TLS, the tree read, the devices
// published, a relay command confirmed, an impostor certificate refused.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ACTIONS, STORED } from '../src/constants.js';
import { certs } from './kit/index.mjs';
import { C, P, createdDevices, e2e, until } from './helpers/app.js';
import { BROKER_PASSWORD, DRYER, PASSPHRASE, SERIAL, fakePanel } from './helpers/fakePanel.js';
import { createMemoryStore, pemFingerprint } from '../src/store.js';

const text = (m) => (m && typeof m === 'object' ? `${m.en} ${m.fr}` : String(m));
const said = (ack) => text(ack.data?.message ?? ack.error);

async function pairTwice(gladys, panel) {
  const first = await gladys.fake.action(ACTIONS.PAIR, {});
  first.registrations = panel?.registrations.length;
  await sleep(3100);
  const second = await gladys.fake.action(ACTIONS.PAIR, {});
  return { first, second };
}

test('pairing in two clicks, then the session: devices, values, a relay confirmed', async (t) => {
  const panel = await fakePanel();
  t.after(() => panel.close());
  const { gladys, app, store } = await e2e({
    panel,
    config: { passphrase: PASSPHRASE, allow_relay_control: true },
    devices: createdDevices(),
  });
  t.after(() => app.stop());
  assert.match(text(gladys.fake.connectionStatus.message), /Not paired yet/);

  const { first, second } = await pairTwice(gladys, panel);
  assert.equal(first.success, true);
  assert.match(said(first), /advertises the certificate authority/);
  assert.match(said(first), new RegExp(certs.device.fingerprint256));
  assert.match(said(first), /Nothing was sent yet/);
  assert.equal(first.registrations, 0, 'nothing registered on the first click');
  assert.match(said(second), /Paired with the SPAN panel nt-9874-s7rxt/);
  assert.equal(panel.registrations.length, 1);
  assert.equal(panel.registrations[0].hopPassphrase, PASSPHRASE);
  assert.match(panel.registrations[0].name, /^gladys-[0-9a-f]{8}$/);
  // The credentials are kept by Gladys, the pin by /data (no secret there).
  assert.equal(gladys.fake.config[STORED.PASSWORD], BROKER_PASSWORD);
  assert.equal(store.data.ca.fingerprint, pemFingerprint(certs.device.cert));
  assert.ok(!JSON.stringify(store.data).includes(BROKER_PASSWORD));
  assert.ok(!JSON.stringify(store.data).includes(PASSPHRASE));

  await until(() => gladys.fake.connectionStatus?.connected === true, 8000, 'connected');
  assert.match(text(gladys.fake.connectionStatus.message), /SPAN panel nt-9874-s7rxt connected/);
  assert.equal(panel.connects.at(-1).password, BROKER_PASSWORD);
  const discovered = gladys.fake.discoveredDevices;
  assert.equal(discovered.length, 1 + 16);
  await until(() => gladys.fake.lastState(C(DRYER, 'power')) !== undefined, 5000, 'values');
  assert.equal(gladys.fake.lastState(C(DRYER, 'power')), 4);
  assert.equal(gladys.fake.lastState(C(DRYER, 'consumption_index')), 855.287);
  assert.equal(gladys.fake.lastState(P('grid_power')), 1257);
  assert.equal(gladys.fake.lastState(C(DRYER, 'relay')), 'CLOSED');

  // A relay opened from Gladys: sent once, confirmed by the state published back.
  const ack = await gladys.fake.setValue(
    discovered.find((d) => d.external_id.endsWith(DRYER)),
    { external_id: C(DRYER, 'relay') },
    'OPEN',
  );
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.deepEqual(
    panel.published.filter((p) => p.topic.endsWith('/set')),
    [{ topic: `ebus/5/${DRYER}/switch/relay/set`, payload: 'OPEN' }],
  );
  await until(() => gladys.fake.lastState(C(DRYER, 'relay')) === 'OPEN', 3000, 'relay state');
  assert.equal(gladys.fake.lastState(C(DRYER, 'relay_requester')), 'USER');
});

test('an impostor answering the broker port gets no byte: the session never sends the password', async (t) => {
  const panel = await fakePanel();
  const impostor = await fakePanel({ cert: certs.impostor });
  t.after(() => Promise.all([panel.close(), impostor.close()]));
  const { gladys, app } = await e2e({
    panel,
    config: {
      passphrase: PASSPHRASE,
      [STORED.USERNAME]: 'u',
      [STORED.PASSWORD]: BROKER_PASSWORD,
      [STORED.PORT]: impostor.mqttPort,
      [STORED.SERIAL]: SERIAL,
    },
    store: createMemoryStore({
      ca: { pem: certs.device.cert, fingerprint: pemFingerprint(certs.device.cert) },
    }),
  });
  t.after(() => app.stop());
  await until(
    () =>
      /the pinned certificate authority .* does not sign/.test(
        text(gladys.fake.connectionStatus?.message ?? ''),
      ),
    8000,
    'untrusted status',
  );
  assert.equal(impostor.connects.length, 0, 'no CONNECT reached the impostor');
  // The authority the panel advertises (here the same) is fetched to be shown, never pinned.
  await until(() => panel.caCalls >= 1, 3000, 'diagnosis');
});

test('the pairing refuses a passphrase over a certificate the authority does not sign', async (t) => {
  const panel = await fakePanel();
  t.after(() => panel.close());
  // The HTTP side advertises the impostor authority: it signs nothing the panel serves.
  panel.caPem = certs.impostor.cert;
  const { gladys, app } = await e2e({ panel, config: { passphrase: PASSPHRASE } });
  t.after(() => app.stop());
  const { second } = await pairTwice(gladys);
  assert.match(said(second), /does not sign the HTTPS certificate/);
  assert.equal(panel.registrations.length, 0, 'the passphrase never left');
});

test('proximity pairing: refused until the door was opened, then accepted', async (t) => {
  const panel = await fakePanel({ proximity: false });
  t.after(() => panel.close());
  const fp = certs.device.fingerprint256;
  const { gladys, app } = await e2e({ panel, config: { ca_fingerprint: fp } });
  t.after(() => app.stop());
  // The fingerprint typed in the form: one click is enough.
  const refused = await gladys.fake.action(ACTIONS.PAIR, {});
  assert.match(said(refused), /did not accept the pairing by proximity/);
  assert.equal(panel.registrations.length, 1);
  assert.equal(panel.registrations[0].hopPassphrase, undefined);
  panel.proximity = true;
  const done = await gladys.fake.action(ACTIONS.PAIR, {});
  assert.match(said(done), /Paired with the SPAN panel .* \(by proximity\)/);
  await until(() => gladys.fake.connectionStatus?.connected === true, 8000, 'connected');
});
