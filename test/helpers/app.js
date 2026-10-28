// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, in two set-ups:
//   - `e2e`: the real transports (HTTP, HTTPS, MQTTS through mqtt.js) against
//     the fake panel of test/helpers/fakePanel.js, real timers;
//   - `unit`: a fake mqtt.js client (test/helpers/fakeMqtt.js) and the
//     virtual clock of the shared test kit: every read of `now()` or
//     `monotonic()` moves the time by 1 µs, so a decision reading the clock
//     twice is caught.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { certs, testClock } from '../kit/index.mjs';
import { SpanApp } from '../../src/app.js';
import { STORED } from '../../src/constants.js';
import { buildCircuitDevice, buildPanelDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { HomieTree } from '../../src/span/tree.js';
import { readPanel } from '../../src/span/panel.js';
import { createMemoryStore, pemFingerprint } from '../../src/store.js';
import { BROKER_PASSWORD, BROKER_USER, SERIAL, retainedTree } from './fakePanel.js';
import { fakeConnector } from './fakeMqtt.js';

export const SELECTOR = 'span';
export const START = Date.UTC(2026, 9, 28, 12, 0, 0);
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** The pin of the bundled device certificate (the fake panel's), as /data keeps it. */
export const PIN = { pem: certs.device.cert, fingerprint: pemFingerprint(certs.device.cert) };

/** The configuration of a paired panel (the credentials the pairing keeps). */
export const PAIRED = {
  host: '127.0.0.1',
  [STORED.USERNAME]: BROKER_USER,
  [STORED.PASSWORD]: BROKER_PASSWORD,
  [STORED.PORT]: 8883,
  [STORED.SERIAL]: SERIAL,
};

/** The panel read from the capture (every device ready). */
export function capturedPanel(topics = retainedTree()) {
  const tree = new HomieTree();
  for (const [topic, payload] of topics) tree.ingest(topic, Buffer.from(payload));
  return readPanel(tree, SERIAL);
}

/** Every device of the capture, as the user created them from Discovery. */
export function createdDevices(topics) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const panel = capturedPanel(topics);
  return [
    buildPanelDevice(gladys, panel),
    ...panel.circuits.map((c) => buildCircuitDevice(gladys, SERIAL, c)),
  ];
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Waits (real time) until `check()` is true; throws after `ms`. */
export async function until(check, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The app with the real transports, against `panel` (fakePanel). */
export async function e2e({ panel, config = {}, devices = [], store, logger } = {}) {
  const cfg = {
    host: '127.0.0.1',
    http_port: panel.httpPort,
    https_port: panel.httpsPort,
    ...config,
  };
  const gladys = createFakeGladys({ selector: SELECTOR, config: cfg, devices });
  const memory = store ?? createMemoryStore();
  const app = new SpanApp({
    gladys,
    store: memory,
    ...(logger ? { logger } : { logger: quiet() }),
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await app.idle();
  return { gladys, app, store: memory, config: cfg };
}

/** The app with a fake mqtt.js client and the virtual clock. */
export async function unit({
  config = {},
  devices = [],
  store = createMemoryStore({ ca: PIN }),
  clock = testClock({ start: START }),
  http,
  probe = async () => {},
  getConfig,
  logger,
} = {}) {
  const connector = fakeConnector();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...PAIRED, ...config },
    devices,
  });
  if (getConfig) gladys.getConfig = getConfig;
  const app = new SpanApp({
    gladys,
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    connect: connector.connect,
    http,
    probe,
    logger: logger ?? quiet(),
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await app.idle();
  await settle();
  return { gladys, app, store, clock, connector, client: () => connector.clients.at(-1) };
}

/** A logger that keeps its lines (and prints nothing). */
export function quiet() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.join(' ')}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

/** The states published for a feature key of a device (`F(...)`). */
export const F = (type, platform, key) => `ext:${SELECTOR}:${type}:${platform}:${key}`;
export const P = (key) => F('panel', SERIAL, key);
export const C = (circuit, key) => F('circuit', `${SERIAL}_${circuit}`, key);
