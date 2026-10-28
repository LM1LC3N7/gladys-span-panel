// -----------------------------------------------------------------------------
// A fake SPAN panel on loopback, built from the eBus documentation of
// span-panel-api (auth.py, _http.py) and a real capture of a MAIN 32 on
// firmware spanos3/r202639/03 (test/fixtures/main32_r202639-tree-v1.json,
// MIT, electrification-bus/distribution-enclosure-simulator):
//   - plain HTTP: GET /api/v2/status, GET /api/v2/certificate/ca;
//   - HTTPS (its certificate): POST /api/v2/auth/register (passphrase in
//     `hopPassphrase`, or proximity when `proximity` is true);
//   - MQTTS (same certificate): a broker that checks the credentials,
//     replays the retained tree on SUBSCRIBE (retain flag set), forwards live
//     publications (retain flag clear) and applies `<circuit>/switch/relay/set`
//     after `applyDelayMs` when the circuit is controllable.
// Everything is counted for the tests: connections, CONNECTs, registrations,
// publications received.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import tls from 'node:tls';
import { certs, closed, listen } from '../kit/index.mjs';

const require = createRequire(import.meta.url);
const mqttPacket = require('mqtt-packet');

const capture = JSON.parse(
  readFileSync(new URL('../fixtures/main32_r202639-tree-v1.json', import.meta.url), 'utf8'),
);

export const SERIAL = 'nt-9874-s7rxt';
export const PASSPHRASE = 'Kitchen-Panel-42';
export const BROKER_USER = 'gladys-client-1';
export const BROKER_PASSWORD = 'Br0ker-S3cret-Value';
/** Circuits of the capture. */
export const DRYER = '390351d21af25d6409aba2b210928f7f';
export const PV_CIRCUIT = Object.entries(capture.devices).find(
  ([, d]) => d.properties['connection/feeds-device-type'] === 'energy.ebus.device.pv',
)[0];
export const UPSTREAM = `${SERIAL}-lugs-up`;

/** The retained topics of the capture: Map(topic → payload string). */
export function retainedTree() {
  const topics = new Map();
  for (const [id, device] of Object.entries(capture.devices)) {
    topics.set(`ebus/5/${id}/$description`, JSON.stringify(device.description));
    topics.set(`ebus/5/${id}/$state`, 'ready');
    for (const [key, value] of Object.entries({
      ...device.numeric_properties,
      ...device.properties,
    })) {
      topics.set(`ebus/5/${id}/${key}`, String(value));
    }
  }
  return topics;
}

export async function fakePanel({
  cert = certs.device,
  serial = SERIAL,
  passphrase = PASSPHRASE,
  proximity = false,
  applyDelayMs = 50,
  topics = retainedTree(),
} = {}) {
  const panel = {
    serial,
    passphrase,
    proximity,
    applyDelayMs,
    topics,
    cert,
    caPem: cert.cert,
    registrations: [],
    connects: [],
    published: [],
    statusCalls: 0,
    caCalls: 0,
    /** CONNACK refused with this code (4: credentials), or silent (no CONNACK) when 'silent'. */
    connack: 0,
    /** The relay command is not applied (the panel ignores it). */
    ignoreRelay: false,
    /** Answers of the registration: a status to force. */
    registerStatus: undefined,
    registerBody: undefined,
    clients: new Set(),
    sockets: new Set(),
  };

  // --- Plain HTTP ---
  const plain = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v2/status') {
      panel.statusCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ serialNumber: panel.serial, firmwareVersion: 'spanos3/r202639/03' }),
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v2/certificate/ca') {
      panel.caCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
      res.end(panel.caPem);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  plain.on('connection', (s) => panel.sockets.add(s));

  // --- HTTPS ---
  const secure = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/v2/auth/register') {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // stays empty
      }
      panel.registrations.push(body);
      if (panel.registerStatus) {
        res.writeHead(panel.registerStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(panel.registerBody ?? { detail: 'refused' }));
        return;
      }
      const ok = body.hopPassphrase
        ? body.hopPassphrase === panel.passphrase
        : panel.proximity === true;
      if (!ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Not authorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          accessToken: 'token-not-used',
          tokenType: 'Bearer',
          iatMs: 1,
          ebusBrokerUsername: BROKER_USER,
          ebusBrokerPassword: BROKER_PASSWORD,
          ebusBrokerHost: `span-${panel.serial}.local`,
          ebusBrokerMqttsPort: panel.mqttPort,
          ebusBrokerWsPort: 9001,
          ebusBrokerWssPort: 9002,
          hostname: `span-${panel.serial}`,
          serialNumber: panel.registerSerial ?? panel.serial,
        }),
      );
    });
  });
  secure.on('connection', (s) => panel.sockets.add(s));

  // --- MQTTS broker ---
  const send = (socket, packet) => {
    if (!socket.destroyed) socket.write(mqttPacket.generate(packet));
  };
  const broker = tls.createServer({ key: cert.key, cert: cert.cert }, (socket) => {
    panel.sockets.add(socket);
    const parser = mqttPacket.parser();
    const client = { socket, subscribed: false };
    parser.on('packet', (packet) => {
      if (packet.cmd === 'connect') {
        panel.connects.push({ username: packet.username, password: String(packet.password ?? '') });
        if (panel.connack === 'silent') return;
        if (panel.connack === 'close') {
          socket.destroy();
          return;
        }
        const good =
          packet.username === BROKER_USER && String(packet.password ?? '') === BROKER_PASSWORD;
        const code = panel.connack || (good ? 0 : 4);
        send(socket, { cmd: 'connack', returnCode: code, sessionPresent: false });
        if (code !== 0) {
          socket.end();
          return;
        }
        panel.clients.add(client);
      } else if (packet.cmd === 'subscribe') {
        send(socket, {
          cmd: 'suback',
          messageId: packet.messageId,
          granted: packet.subscriptions.map(() => 0),
        });
        client.subscribed = true;
        for (const [topic, payload] of panel.topics) {
          send(socket, { cmd: 'publish', topic, payload, qos: 0, retain: true, dup: false });
        }
      } else if (packet.cmd === 'publish') {
        const payload = String(packet.payload);
        panel.published.push({ topic: packet.topic, payload });
        const match = /^ebus\/5\/([^/]+)\/switch\/relay\/set$/.exec(packet.topic);
        if (match && !panel.ignoreRelay) {
          const id = match[1];
          if (panel.topics.get(`ebus/5/${id}/switch/relay-controllable`) === 'true') {
            setTimeout(() => {
              panel.publish(`ebus/5/${id}/switch/relay-requester`, 'USER');
              panel.publish(`ebus/5/${id}/switch/relay`, payload);
            }, panel.applyDelayMs);
          }
        }
      } else if (packet.cmd === 'pingreq') {
        send(socket, { cmd: 'pingresp' });
      } else if (packet.cmd === 'disconnect') {
        socket.end();
      }
    });
    socket.on('data', (data) => parser.parse(data));
    socket.on('error', () => {});
    socket.on('close', () => panel.clients.delete(client));
  });

  /** A live publication: kept retained, forwarded with the retain flag clear. */
  panel.publish = (topic, payload, { retain = true } = {}) => {
    if (retain) panel.topics.set(topic, payload);
    for (const client of panel.clients) {
      if (client.subscribed) {
        send(client.socket, { cmd: 'publish', topic, payload, qos: 0, retain: false, dup: false });
      }
    }
  };
  /** Sets a property of a device: `panel.set(DRYER, 'meter/active-power', '-1200')`. */
  panel.set = (id, key, value) => panel.publish(`ebus/5/${id}/${key}`, String(value));
  /** Raw bytes to every connected client (an oversized packet...). */
  panel.raw = (bytes) => {
    for (const client of panel.clients) client.socket.write(bytes);
  };
  /** Cuts every client connection. */
  panel.dropClients = () => {
    for (const client of panel.clients) client.socket.destroy();
  };

  panel.httpPort = await listen(plain);
  panel.httpsPort = await listen(secure);
  panel.mqttPort = await listen(broker);
  panel.close = async () => {
    for (const s of panel.sockets) s.destroy();
    await Promise.all([closed(plain), closed(secure), closed(broker)]);
  };
  return panel;
}
