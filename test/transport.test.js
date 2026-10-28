// -----------------------------------------------------------------------------
// The transports on loopback: the bounded HTTP(S) requests of the pairing,
// the pin checked before any byte leaves, the answers of the panel parsed
// strictly, the MQTT packets bounded before they are read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { getCa, register, request } from '../src/span/http.js';
import { PacketGuard, connectBroker } from '../src/span/mqtt.js';
import { peerPinned, probe } from '../src/span/tls.js';
import { pemFingerprint } from '../src/store.js';
import { certs, closed, listen } from './kit/index.mjs';
import { C, e2e, until } from './helpers/app.js';
import { BROKER_PASSWORD, DRYER, SERIAL, fakePanel } from './helpers/fakePanel.js';

const PIN = { pem: certs.device.cert, fingerprint: pemFingerprint(certs.device.cert) };

async function server(handler, { secure = false, cert = certs.device } = {}) {
  const requests = [];
  const sockets = new Set();
  const srv = secure
    ? https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
        requests.push(req.url);
        handler(req, res);
      })
    : http.createServer((req, res) => {
        requests.push(req.url);
        handler(req, res);
      });
  srv.on('connection', (s) => sockets.add(s));
  const port = await listen(srv);
  return {
    port,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await closed(srv);
    },
  };
}

const reasonOf = async (promise) => {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err.reason;
  }
};

test('an answer too large is cut, declared or streamed', async (t) => {
  const declared = await server((req, res) => {
    res.writeHead(200, { 'Content-Length': 10_000_000 });
    res.write('x');
  });
  const streamed = await server((req, res) => {
    res.writeHead(200);
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    for (let i = 0; i < 10; i += 1) res.write(chunk);
    res.end();
  });
  t.after(() => Promise.all([declared.close(), streamed.close()]));
  for (const port of [declared.port, streamed.port]) {
    assert.equal(await reasonOf(request({ host: '127.0.0.1', port, path: '/' })), 'tooLarge');
  }
});

test('a silent panel: the request ends at its timeout', async (t) => {
  const hole = net.createServer(() => {});
  const port = await listen(hole);
  const sockets = new Set();
  hole.on('connection', (s) => sockets.add(s));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await closed(hole);
  });
  assert.equal(
    await reasonOf(request({ host: '127.0.0.1', port, path: '/' }, { timeout: 300 })),
    'timeout',
  );
});

test('HTTPS: an impostor certificate gets no request at all (nor the passphrase)', async (t) => {
  const impostor = await server(
    (req, res) => {
      res.end('{}');
    },
    { secure: true, cert: certs.impostor },
  );
  t.after(() => impostor.close());
  const reason = await reasonOf(
    register({ host: '127.0.0.1', port: impostor.port, pin: PIN, passphrase: 'secret-one' }),
  );
  assert.equal(reason, 'untrusted');
  assert.deepEqual(impostor.requests, []);
  assert.equal(
    await reasonOf(probe('127.0.0.1', impostor.port, PIN.pem, PIN.fingerprint)),
    'untrusted',
  );
});

test('the registration: answers read strictly, the credentials checked', async (t) => {
  let answer;
  const srv = await server(
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    },
    { secure: true },
  );
  t.after(() => srv.close());
  const run = () => register({ host: '127.0.0.1', port: srv.port, pin: PIN, passphrase: 'p' });
  const good = {
    ebusBrokerUsername: 'u',
    ebusBrokerPassword: 'pw',
    ebusBrokerMqttsPort: 8883,
    serialNumber: SERIAL,
  };
  answer = { status: 200, body: good };
  assert.deepEqual(await run(), { username: 'u', password: 'pw', port: 8883, serial: SERIAL });
  const cases = [
    [{ status: 401, body: {} }, 'refused'],
    [{ status: 422, body: { detail: [{ loc: ['body', 'hopPassphrase'] }] } }, 'refused'],
    [{ status: 422, body: { detail: 'Dashboard password is not available' } }, 'unavailable'],
    [{ status: 200, body: { ...good, ebusBrokerPassword: null } }, 'unavailable'],
    [{ status: 503, body: {} }, 'notReady'],
    [{ status: 200, body: { ...good, ebusBrokerMqttsPort: 70000 } }, 'badAnswer'],
    [{ status: 200, body: { ...good, serialNumber: 'a/b' } }, 'badAnswer'],
    [{ status: 200, body: { ...good, ebusBrokerPassword: 'a\r\nb' } }, 'badAnswer'],
    [{ status: 302, body: {} }, 'badAnswer'],
  ];
  for (const [given, expected] of cases) {
    answer = given;
    assert.equal(await reasonOf(run()), expected, JSON.stringify(given));
  }
});

test('the certificate authority: one PEM block, its fingerprint; anything else refused', async (t) => {
  let body = certs.device.cert;
  let status = 200;
  const srv = await server((req, res) => {
    res.writeHead(status);
    res.end(body);
  });
  t.after(() => srv.close());
  const ca = await getCa({ host: '127.0.0.1', port: srv.port });
  assert.equal(ca.fingerprint, PIN.fingerprint);
  body = 'not a certificate';
  assert.equal(await reasonOf(getCa({ host: '127.0.0.1', port: srv.port })), 'badCa');
  status = 429;
  assert.equal(await reasonOf(getCa({ host: '127.0.0.1', port: srv.port })), 'busy');
});

test('MQTT packets: cut as soon as a header announces too much, across chunks', async () => {
  const run = (chunks, max = 100) =>
    new Promise((resolve) => {
      const guard = new PacketGuard(max);
      const out = [];
      guard.on('data', (c) => out.push(c));
      guard.on('error', (err) => resolve({ err: err.code, out: Buffer.concat(out) }));
      guard.on('finish', () => resolve({ out: Buffer.concat(out) }));
      for (const c of chunks) guard.write(c);
      guard.end();
    });
  // A CONNACK (4 bytes) then a PUBLISH announcing 200 bytes, header split in two chunks.
  const connack = Buffer.from([0x20, 0x02, 0x00, 0x00]);
  const result = await run([
    Buffer.concat([connack, Buffer.from([0x30])]),
    Buffer.from([0xc8, 0x01]),
  ]);
  assert.equal(result.err, 'PACKET_TOO_LARGE');
  // The CONNACK is delivered; of the oversized packet, nothing beyond the first
  // header byte of an earlier chunk (no body byte is ever buffered).
  assert.deepEqual(result.out, Buffer.concat([connack, Buffer.from([0x30])]));
  const malformed = await run([Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01])], 1e9);
  assert.equal(malformed.err, 'MALFORMED_PACKET');
  const fine = await run([connack, Buffer.from([0x30, 0x03, 0x00, 0x01, 0x61])]);
  assert.equal(fine.err, undefined);
});

test('end to end: an oversized message cuts the session before it is read', async (t) => {
  const panel = await fakePanel();
  t.after(() => panel.close());
  const { gladys, app, store } = await e2e({
    panel,
    config: {
      broker_username: 'gladys-client-1',
      broker_password: BROKER_PASSWORD,
      broker_port: panel.mqttPort,
      paired_serial: SERIAL,
    },
    store: (await import('../src/store.js')).createMemoryStore({ ca: PIN }),
  });
  t.after(() => app.stop());
  await until(() => gladys.fake.connectionStatus?.connected === true, 8000, 'connected');
  assert.ok(store.data.ca);
  // A PUBLISH announcing 2 MB (remaining length 0x80 0x80 0x80 0x01).
  panel.raw(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x01, 0x00]));
  await until(
    () => /message too large/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    5000,
    'cut',
  );
  assert.equal(gladys.fake.lastState(C(DRYER, 'power')), undefined);
});

test('the pin: a socket counts only verified AND showing the pinned authority', () => {
  const chain = (fps) => {
    const certsChain = fps.map((fp) => ({ fingerprint256: fp }));
    certsChain.forEach((c, i) => (c.issuerCertificate = certsChain[i + 1] ?? c));
    return certsChain[0];
  };
  const socket = (authorized, fps) => ({ authorized, getPeerCertificate: () => chain(fps) });
  const pinned = 'AB:'.repeat(31) + 'AB';
  const fp = 'ab'.repeat(32);
  assert.equal(peerPinned(socket(true, ['11:22', pinned]), fp), true);
  assert.equal(peerPinned(socket(false, ['11:22', pinned]), fp), false, 'not verified');
  assert.equal(peerPinned(socket(true, ['11:22', '33:44']), fp), false, 'another authority');
  assert.equal(
    peerPinned(
      {
        authorized: true,
        getPeerCertificate: () => {
          throw new Error('x');
        },
      },
      fp,
    ),
    false,
  );
});

test('a pin whose fingerprint differs: no request, no CONNECT, even over a chain Node accepts', async (t) => {
  const wrong = { pem: certs.device.cert, fingerprint: 'ab'.repeat(32) };
  const srv = await server((req, res) => res.end('{}'), { secure: true });
  t.after(() => srv.close());
  assert.equal(
    await reasonOf(register({ host: '127.0.0.1', port: srv.port, pin: wrong, passphrase: 'p' })),
    'untrusted',
  );
  assert.deepEqual(srv.requests, []);
  const panel = await fakePanel();
  t.after(() => panel.close());
  const client = connectBroker({
    host: '127.0.0.1',
    port: panel.mqttPort,
    pin: wrong,
    username: 'gladys-client-1',
    password: BROKER_PASSWORD,
  });
  const error = await new Promise((resolve) => client.once('error', resolve));
  client.end(true);
  assert.equal(error.code, 'NOT_PINNED');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(panel.connects.length, 0, 'the CONNECT (and its password) never left');
});
