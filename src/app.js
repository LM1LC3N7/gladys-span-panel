// -----------------------------------------------------------------------------
// The integration itself: the SPAN panel of the configuration, paired once
// by the user (button "Pair with the panel"), then ONE MQTT session at a time
// with the broker of the panel; its tree read (src/span/panel.js), its
// devices in Discovery, their states published at the interval of the form,
// the lifetime counters through their guards, the relay commands, the test
// and accept buttons. index.js and src/handlers.js only wire the SDK
// handlers to it.
//
// Pairing (src/span/http.js), only on a click, one registration per click:
//   1. the status and the certificate authority of the panel are read over
//      plain HTTP (nothing secret travels): the authority is a CANDIDATE;
//   2. it is trusted only when its fingerprint is the one already pinned,
//      the one typed in the form, or confirmed by a second click (3 s to
//      5 min later, same fingerprint): never learnt blindly;
//   3. a TLS handshake checks it signs the HTTPS certificate of the panel;
//      it is pinned in /data (a failed write stops here: nothing sent);
//   4. the registration goes over HTTPS checked against the pin (the
//      passphrase, or proximity: the door opened and closed three times);
//   5. the broker credentials it returns are kept by Gladys (setConfig, keys
//      outside the form), never in /data nor in a log.
//
// Session (src/span/mqtt.js): MQTTS to the panel, the pin only, nothing
// written before the peer is verified. A refusal of the credentials is a
// final stop kept in /data (lifted by a new pairing); a CONNECT left
// unanswered twice in a row too. Any other failure is tried again after 5 s,
// 15 s, 30 s, 1 min, 2 min, then every 5 min. A certificate the pin refuses
// is never re-learnt: the authority the panel now advertises is fetched (at
// most every 15 min) and shown; the user types its fingerprint or pairs
// again (two clicks). Every session starts from an empty tree.
//
// Relay commands (setValue on the `relay` list of a circuit): refused unless
// the option "Allow opening and closing the circuit relays" is on (off by
// default), re-checked right before the publication; decided on the state of
// THIS session (root and circuit ready, relay declared settable and
// controllable, state known); one command at a time per circuit; QoS 0,
// never queued: it leaves now or is refused ("nothing sent"). Confirmed only
// by the state the panel publishes back, different from the state before
// (by 3.3 s after the click), else "sent, without confirmation". Both
// directions (open = cut a circuit, close = power it again) are sensitive:
// neither is ever sent without the option.
//
// Clocks: `monotonic` paces everything (timers, reconnections, the
// publication interval, the budget of 270 states a minute); the guards of the
// counters run on the SESSION clock (the wall clock read once at the start of
// the process plus the monotonic time since, `sessionNow`), so that NTP
// moving the wall clock never widens nor narrows their margin; the wall
// clock itself only dates what /data keeps. Each decision reads each clock
// once.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  CA_DIAGNOSE_EVERY,
  CIRCUIT_LIMITS,
  CONFIG_RETRY,
  CONFIRM_AFTER,
  CONFIRM_RELAY_WITHIN,
  CONFIRM_WITHIN,
  FEED_LIMITS,
  RECONNECT,
  RELAY,
  SEND_WITHIN,
  STALE_AFTER,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  STORED,
  SUBSCRIPTION,
  TOPIC_ROOT,
  UNANSWERED_STOP,
} from './constants.js';
import {
  CIRCUIT_CATALOG,
  CIRCUIT_KEYS,
  PANEL_CATALOG,
  buildCircuitDevice,
  buildPanelDevice,
  circuitIds,
  keysOfDevice,
  kwhOf,
  panelIds,
  parseCircuitFeature,
  statesOf,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import * as httpApi from './span/http.js';
import { connectBroker, isRefusal, sessionReason } from './span/mqtt.js';
import { readPanel } from './span/panel.js';
import { failureOf, probe as tlsProbe } from './span/tls.js';
import { HomieTree } from './span/tree.js';
import { createFileStore, fingerprint, readState } from './store.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
const MINUTE = 60_000;
/** How often the integration looks whether a publication is due. */
const TICK = 5_000;
/** The tree is read again this long after a message (messages come in bursts). */
const REFRESH_DELAY = 1_000;
/** A relay change is published this long after it arrived (its requester comes with it). */
const RELAY_PUBLISH_DELAY = 300;

/** The value Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const raw = feature?.last_value;
  if (!(typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== ''))) {
    return undefined;
  }
  const value = Number(raw);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return Number.isFinite(value) && value > 0 && Number.isFinite(at) ? { value, at } : undefined;
}

const relayError = (key) => Object.assign(new Error(T.relay[key]), { code: key });

export class SpanApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'span-panel' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    connect = connectBroker,
    http = httpApi,
    probe = tlsProbe,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.connect = connect;
    this.http = http;
    this.probe = probe;
    /** The session clock: wall at the start of the process + monotonic elapsed since. */
    this.wallStart = now();
    this.monoStart = monotonic();
    this.loadStore();
    this.savedKey = undefined;
    this.saveFailed = false;
    this.raw = {};
    this.config = normalizeConfig();
    this.generation = 0;
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;
    /** getConfig() in `connected`: the attempt running, its failures, its timer. */
    this.configAttempt = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
    // --- Session ---
    this.client = undefined;
    this.tree = undefined;
    /** The MQTT session is up (CONNACK received, subscription asked). */
    this.up = false;
    this.lastError = undefined;
    this.failures = 0;
    this.unanswered = 0;
    this.retryAtMono = undefined;
    this.reconnectTimer = undefined;
    this.diagnoseAtMono = undefined;
    /** The last reading of the tree: the panel, or `{ problem }`. */
    this.panel = undefined;
    this.refreshTimer = undefined;
    this.publishedDevices = undefined;
    // --- Publication ---
    this.tickTimer = undefined;
    this.lastFlushMono = undefined;
    /** The states sent in the last minute: `[{ at, count }]`, monotonic. */
    this.sent = [];
    this.rotation = 0;
    this.relayTimers = new Map();
    /** By counter feature external id: IndexGuard; the hold last logged. */
    this.guards = new Map();
    this.loggedHolds = new Map();
    this.pendingAccept = undefined;
    // --- Commands and pairing ---
    this.relayChains = new Map();
    this.waiters = new Set();
    this.pendingPin = undefined;
    this.pairing = false;
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.monotonic() - this.monoStart);
  }

  /** Wall minus session clock, now: /data keeps the dates of the guards on the wall clock. */
  wallOffset() {
    return this.now() - this.sessionNow();
  }

  /**
   * Reads /data. A file that cannot be read is never taken as empty: nothing
   * is written over it, no counter published, no certificate pinned, no
   * session opened, until a later start reads it.
   */
  loadStore() {
    const loaded = this.store.load();
    this.storeUnreadable = Boolean(loaded?.unreadable);
    if (this.storeUnreadable) {
      this.logger.warn('SPAN: the state file in /data cannot be read: left as it is');
    }
    this.kept = readState(loaded?.data);
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `connected` (the first connection and each reconnection): the
   * configuration asked from Gladys, again and again while it fails (5 s,
   * 15 s, 30 s, then every minute, without end), then a start.
   */
  async connectedVia(getConfig) {
    this.cancelConfigRetry();
    const attempt = ++this.configAttempt;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (attempt !== this.configAttempt) return;
      const wait = CONFIG_RETRY[Math.min(this.configFailures, CONFIG_RETRY.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `SPAN: reading the configuration from Gladys failed (${err?.name ?? 'Error'}); again in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configRetry(wait));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (attempt === this.configAttempt) {
          this.connectedVia(getConfig).catch((e) =>
            this.logger.error(`SPAN: start failed (${e?.name ?? 'Error'})`),
          );
        }
      }, wait);
      return;
    }
    if (attempt !== this.configAttempt) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  cancelConfigRetry() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** `fresh`: the user saved the form (not a reconnection to Gladys). */
  start(raw = {}, { fresh = false } = {}) {
    // A start wins over a getConfig() still being retried.
    this.configAttempt += 1;
    this.cancelConfigRetry();
    return this.serialize(() => this.doStart(raw, { fresh }));
  }

  stop() {
    this.configAttempt += 1;
    this.cancelConfigRetry();
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop is done (tests). */
  async idle() {
    await this.lifecycle;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw, { fresh = false } = {}) {
    await this.doStop();
    const generation = ++this.generation;
    if (this.storeUnreadable) {
      // Read again: maybe readable now (never taken as empty meanwhile).
      this.loadStore();
      this.guards.clear();
    }
    this.raw = raw && typeof raw === 'object' ? { ...raw } : {};
    const previous = this.config;
    this.config = normalizeConfig(this.raw);
    let changed = false;
    const stored = this.config.stored;
    if (this.kept.refusal && stored) {
      // Other credentials (a new pairing): the refusal is forgotten.
      if (fingerprint(this.kept.salt, stored) !== this.kept.refusal.fp) {
        this.kept.refusal = null;
        changed = true;
      }
    }
    if (this.kept.refusal?.code === 'unanswered' && fresh) {
      // A broker that closed without answering is not a refusal of the
      // credentials: a save of the configuration tries again (once).
      this.kept.refusal = null;
      this.unansweredLeft = 1;
      changed = true;
    }
    const typed = this.config.fingerprint;
    this.pinNotSaved = false;
    let repin;
    if (typed && this.kept.seen?.fingerprint === typed && this.kept.ca?.fingerprint !== typed) {
      // The user typed the fingerprint of the authority the panel advertised
      // when the pin refused its certificate: that one is pinned now, once
      // /data holds it (review r1, I2).
      repin = { ca: this.kept.ca, seen: this.kept.seen };
      this.kept.ca = this.kept.seen;
      this.kept.seen = null;
      changed = true;
    }
    if (previous.host && previous.host !== this.config.host) {
      this.pendingPin = undefined;
    }
    const saved = await this.saveState({ force: changed });
    if (repin) {
      if (saved) {
        this.logger.info('SPAN: the certificate authority typed in the configuration is pinned');
      } else {
        // Not kept: the former pin and what was seen stay, no session opens.
        Object.assign(this.kept, repin);
        this.pinNotSaved = true;
      }
    }
    // The core keeps the connection status and the Discovery list in memory:
    // a restarted Gladys has lost them, so they are always sent again.
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    if (!fresh) this.gladys.forgetPublishedStates?.();
    this.failures = 0;
    this.unanswered = 0;
    this.retryAtMono = undefined;
    this.lastError = undefined;
    this.tickTimer = this.timers.setInterval(() => this.tick(generation), TICK);
    // blocked() keeps the session closed on a pin /data does not hold.
    this.openSession(generation);
    await this.updateStatus();
  }

  async doStop() {
    this.generation += 1;
    if (this.tickTimer !== undefined) {
      this.timers.clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.clearReconnect();
    this.endClient();
    // /data written on a clean stop too (the last state of the counters).
    await this.saveState();
  }

  clearReconnect() {
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed (${err?.name ?? 'Error'})`));
  }

  // --- /data -------------------------------------------------------------------------

  /**
   * Keeps the state in /data when it changed; false when it could not (or
   * must not: an unreadable file is never written over). A counter not
   * loaded in memory keeps what /data had.
   */
  async saveState({ force = false } = {}) {
    if (this.storeUnreadable) return false;
    const counters = Object.assign(Object.create(null), this.kept.counters);
    const offset = this.wallOffset();
    const toWall = (ref) =>
      ref && Number.isFinite(ref.at) ? { ...ref, at: ref.at + offset } : ref;
    for (const [id, guard] of this.guards) {
      const state = guard.state();
      counters[id] = { guard: { last: toWall(state.last), held: toWall(state.held) } };
    }
    this.kept.counters = counters;
    const state = {
      salt: this.kept.salt,
      ca: this.kept.ca,
      refusal: this.kept.refusal,
      seen: this.kept.seen,
      counters,
    };
    const key = JSON.stringify(state);
    if (!force && key === this.savedKey && !this.saveFailed) return true;
    try {
      await this.store.save(state);
      this.savedKey = key;
      this.saveFailed = false;
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.logger.warn(`Saving the SPAN state in /data failed (${err?.code ?? 'error'})`);
      }
      this.saveFailed = true;
      return false;
    }
  }

  // --- MQTT session ------------------------------------------------------------------

  /** Why no session can open, or undefined. */
  blocked() {
    if (this.config.problem) return 'problem';
    // An unreadable /data holds no pin (kept.ca is null): no session either.
    if (!this.config.stored || !this.kept.ca) return 'notPaired';
    if (this.kept.refusal) return 'refused';
    if (this.pinNotSaved) return 'pinNotSaved';
    return undefined;
  }

  /** Opens THE session (one at a time), when nothing prevents it. */
  openSession(generation) {
    if (generation !== this.generation || this.client || this.blocked()) return;
    const { host } = this.config;
    const { username, password, port } = this.config.stored;
    const pin = this.kept.ca;
    this.tree = new HomieTree();
    this.up = false;
    this.lastMessageMono = undefined;
    this.panel = undefined;
    let opened = false;
    let pending = false;
    const hooks = {
      onAttempt: () => {
        opened = false;
        pending = false;
      },
      onOpen: () => {
        // The TLS peer is verified: only now may the credentials leave.
        opened = true;
        pending = true;
      },
    };
    let client;
    try {
      client = this.connect({ host, port, pin, username, password }, hooks);
    } catch (err) {
      this.lastError = failureOf(err);
      this.scheduleReconnect(generation);
      return;
    }
    this.client = client;
    const current = () => generation === this.generation && this.client === client;
    client.on('packetreceive', (packet) => {
      if (packet?.cmd === 'connack') pending = false;
    });
    client.on('connect', () => {
      if (!current()) return;
      this.up = true;
      this.unanswered = 0;
      this.unansweredLeft = undefined;
      this.lastMessageMono = this.monotonic();
      this.lastError = undefined;
      this.retryAtMono = undefined;
      client.subscribe(SUBSCRIPTION, { qos: 0 }, () => {});
      this.updateStatus().catch(() => {});
    });
    client.on('message', (topic, payload) => {
      if (current()) this.onMessage(topic, payload);
    });
    client.on('error', (err) => {
      if (!current()) return;
      const code = sessionReason(err) ?? failureOf(err);
      this.lastError = code;
      if (isRefusal(err)) {
        this.onRefused(generation).catch((e) => this.logger.error(`SPAN: ${e?.name}`));
        return;
      }
      if (code === 'noConnack' && !opened) this.lastError = 'timeout';
      if (code === 'untrusted' || code === 'certificateDate') {
        this.diagnoseCertificate(generation).catch(() => {});
      }
    });
    client.on('close', () => {
      if (!current()) return;
      const unanswered = pending && opened;
      pending = false;
      this.endClient();
      if (unanswered) {
        this.unanswered += 1;
        this.lastError = 'unanswered';
        if (this.unanswered >= (this.unansweredLeft ?? UNANSWERED_STOP)) {
          this.onRefused(generation, 'unanswered').catch((e) =>
            this.logger.error(`SPAN: ${e?.name}`),
          );
          return;
        }
      }
      this.lastError ??= 'reset';
      this.logger.warn(`SPAN: session with the panel ended (${this.lastError})`);
      this.scheduleReconnect(generation);
    });
  }

  /** Ends the client of the session (if any): its tree is forgotten, waiters fail. */
  endClient() {
    const client = this.client;
    this.client = undefined;
    this.up = false;
    this.tree = undefined;
    this.panel = undefined;
    if (this.refreshTimer !== undefined) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const timer of this.relayTimers.values()) this.timers.clearTimeout(timer);
    this.relayTimers.clear();
    for (const waiter of this.waiters) waiter.done('session');
    this.waiters.clear();
    if (client) {
      client.removeAllListeners?.();
      client.on?.('error', () => {});
      client.end?.(true);
    }
  }

  scheduleReconnect(generation) {
    if (generation !== this.generation) return;
    this.clearReconnect();
    const wait = RECONNECT[Math.min(this.failures, RECONNECT.length - 1)];
    this.failures += 1;
    this.retryAtMono = this.monotonic() + wait;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSession(generation);
      this.updateStatus().catch(() => {});
    }, wait);
    this.updateStatus().catch(() => {});
  }

  /**
   * The broker refused the credentials (`refused`: stopped until a new
   * pairing), or closed the CONNECT without answer twice in a row
   * (`unanswered`: stopped until the test button, a save of the
   * configuration or a new pairing). A stop kept in /data either way.
   */
  async onRefused(generation, code = 'refused') {
    if (generation !== this.generation) return;
    this.logger.warn(
      code === 'refused'
        ? 'SPAN: the broker of the panel refused the credentials: stopped until a new pairing'
        : 'SPAN: the broker of the panel closed twice without answering: automatic tries stopped',
    );
    this.endClient();
    this.clearReconnect();
    this.kept.refusal = { code, fp: fingerprint(this.kept.salt, this.config.stored) };
    await this.saveState();
    await this.updateStatus();
  }

  /**
   * The pin refused the certificate of the panel: the authority the panel
   * now advertises is fetched (plain HTTP, at most every 15 min) to SHOW its
   * fingerprint; it is never pinned by itself.
   */
  async diagnoseCertificate(generation) {
    const mono = this.monotonic();
    if (this.diagnoseAtMono !== undefined && mono - this.diagnoseAtMono < CA_DIAGNOSE_EVERY) return;
    this.diagnoseAtMono = mono;
    let candidate;
    try {
      candidate = await this.http.getCa({ host: this.config.host, port: this.config.httpPort });
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    if (candidate.fingerprint === this.kept.ca?.fingerprint) {
      if (this.kept.seen) {
        this.kept.seen = null;
        await this.saveState();
      }
      return;
    }
    this.kept.seen = candidate;
    this.logger.warn(
      'SPAN: the panel advertises another certificate authority: never trusted by itself',
    );
    await this.saveState();
    await this.updateStatus();
  }

  onMessage(topic, payload) {
    const tree = this.tree;
    if (!tree) return;
    this.lastMessageMono = this.monotonic();
    const what = tree.ingest(topic, payload);
    if (!what) return;
    if (
      what.kind === 'value' &&
      (what.key === 'switch/relay' || what.key === 'switch/relay-requester')
    ) {
      if (what.key === 'switch/relay') {
        const text = tree.text(what.id, 'switch', 'relay');
        for (const waiter of this.waiters) {
          if (waiter.circuitId === what.id) waiter.seen(text);
        }
      }
      this.scheduleRelayPublish(what.id);
    }
    if (this.refreshTimer === undefined) {
      const generation = this.generation;
      this.refreshTimer = this.timers.setTimeout(() => {
        this.refreshTimer = undefined;
        if (generation === this.generation) {
          this.refresh().catch((e) => this.logger.error(`SPAN: refresh failed (${e?.name})`));
        }
      }, REFRESH_DELAY);
    }
  }

  /** Reads the tree again: the panel, Discovery and the status; a first publication when ready. */
  async refresh() {
    if (!this.tree || !this.config.stored) return;
    const wasReady = this.panel && !this.panel.problem;
    this.panel = readPanel(this.tree, this.config.stored.serial);
    if (!this.panel.problem) {
      // A session that reached a ready panel: the next failure starts the backoff again.
      this.failures = 0;
      await this.discover();
      if (!wasReady) {
        // The first values of this session at once, then at the interval.
        await this.flush();
      }
    }
    await this.updateStatus();
  }

  // --- Devices -------------------------------------------------------------------------

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d.external_id === externalId);
  }

  /** The devices of the panel read (nothing before a ready panel of the serial paired). */
  devicesOf(panel) {
    const serial = panel.serial;
    const panelDevice = buildPanelDevice(
      this.gladys,
      panel,
      this.createdDevice(panelIds(this.gladys, serial).device),
    );
    const circuits = panel.circuits.map((c) =>
      buildCircuitDevice(
        this.gladys,
        serial,
        c,
        this.createdDevice(circuitIds(this.gladys, serial, c.id).device),
      ),
    );
    return [panelDevice, ...circuits];
  }

  async discover({ force = false } = {}) {
    const panel = this.panel && !this.panel.problem ? this.panel : undefined;
    if (!panel && !force) return;
    const devices = panel ? this.devicesOf(panel) : [];
    const json = JSON.stringify(devices);
    if (!force && json === this.publishedDevices) return;
    this.publishedDevices = json;
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) =>
        this.logger.warn(`Publishing the SPAN devices failed (${err?.name ?? 'Error'})`),
      );
  }

  /** The Discover tab: the devices of the panel read in this session; never a request by itself. */
  async scan() {
    await this.discover({ force: true });
    await this.updateStatus();
  }

  /** A device just created: no reference of its counters yet; its values now. */
  async onDeviceCreated(device) {
    const id = device?.external_id;
    if (typeof id !== 'string' || !id.startsWith(`ext:${this.gladys.selector}:`)) return;
    // A new device: no reference of its counters yet (nor a state kept in
    // /data for a deleted device of the same id).
    for (const counterId of Object.keys(this.kept.counters)) {
      if (counterId.startsWith(`${id}:`)) delete this.kept.counters[counterId];
    }
    for (const counterId of [...this.guards.keys()]) {
      if (counterId.startsWith(`${id}:`)) this.guards.delete(counterId);
    }
    await this.saveState({ force: true });
    await this.flush({ only: id });
  }

  async onDeviceUpdated(device) {
    const id = device?.external_id;
    if (typeof id === 'string' && id.startsWith(`ext:${this.gladys.selector}:`)) {
      await this.flush({ only: id });
    }
  }

  // --- Publication ----------------------------------------------------------------------

  /** The timer: a publication when the interval passed (monotonic). */
  tick(generation) {
    if (generation !== this.generation) return;
    const mono = this.monotonic();
    if (this.stale(mono)) {
      // A panel silent too long: nothing published as new, the status says so.
      this.updateStatus().catch(() => {});
      return;
    }
    if (
      this.lastFlushMono !== undefined &&
      mono - this.lastFlushMono < this.config.interval * 1000
    ) {
      return;
    }
    this.flush().catch((e) => this.logger.error(`SPAN: publication failed (${e?.name})`));
  }

  /** The guard of a counter of a created device, from Gladys and /data. */
  guardOf(created, id, limits) {
    if (!this.guards.has(id)) {
      const saved = this.kept.counters[id];
      const sessionNow = this.sessionNow();
      // /data holds wall dates (saveState): back to the session clock.
      const offset = this.now() - sessionNow;
      const toSession = (ref) =>
        ref && Number.isFinite(ref.at) ? { ...ref, at: ref.at - offset } : ref;
      // A date "in the future" (a wall clock set back across a restart) is now.
      const clamp = (ref) =>
        ref && Number.isFinite(ref.at) ? { ...ref, at: Math.min(ref.at, sessionNow) } : ref;
      const guardState = saved?.guard
        ? { ...saved.guard, last: clamp(toSession(saved.guard.last)) }
        : saved?.guard;
      // The reference Gladys holds is dated on the wall clock: to the session clock too.
      this.guards.set(
        id,
        new IndexGuard(clamp(toSession(lastValueOf(created, id))), guardState, sessionNow, limits),
      );
    }
    return this.guards.get(id);
  }

  /** The value a counter may publish now (kWh), through its guard; undefined otherwise. */
  counterValue(created, id, entry, wh, label, now) {
    const limits = entry.counter === 'feed' ? FEED_LIMITS : CIRCUIT_LIMITS;
    const guard = this.guardOf(created, id, limits);
    const read = kwhOf(wh);
    // Unknown now: nothing sent (never a value the panel does not show now).
    if (read === undefined) return undefined;
    const plausible = guard.accept(read, now);
    const held = guard.held ? `${guard.held.direction}:${guard.held.from}` : undefined;
    if (held && this.loggedHolds.get(id) !== held) {
      this.logger.warn(
        `SPAN counter "${label.en}" ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held counter" button takes it`,
      );
    }
    if (held) this.loggedHolds.set(id, held);
    else this.loggedHolds.delete(id);
    // While a value is held, the last accepted one is sent again (no delta for the core).
    return plausible ? read : guard.held ? guard.last?.value : undefined;
  }

  /** The label of a counter in the texts. */
  counterLabel(entry, circuit) {
    if (!circuit) {
      return entry.key === 'feed_import_index' ? T.counter.feedImport : T.counter.feedExport;
    }
    return T.counter.circuit(circuit.name, entry.key === CIRCUIT_KEYS.PRODUCTION_INDEX);
  }

  /**
   * The states of the panel read, for the created devices (each subject:
   * the panel, then each circuit). `only`: one device external id.
   */
  prepare(panel, { only } = {}) {
    const now = this.sessionNow();
    const subjects = [];
    const add = (ids, catalog, subject, circuit) => {
      if (only && ids.device !== only) return;
      const created = this.createdDevice(ids.device);
      if (!created) return;
      const keys = keysOfDevice(created);
      const counters = (entry) =>
        this.counterValue(
          created,
          ids.feature(entry.key),
          entry,
          entry.wh(subject),
          this.counterLabel(entry, circuit),
          now,
        );
      const states = statesOf(ids, catalog, subject, keys, counters);
      if (states.length > 0) subjects.push({ id: ids.device, states, counters: catalog });
    };
    add(panelIds(this.gladys, panel.serial), PANEL_CATALOG, panel);
    for (const circuit of panel.circuits) {
      add(circuitIds(this.gladys, panel.serial, circuit.id), CIRCUIT_CATALOG, circuit, circuit);
    }
    return subjects;
  }

  /**
   * One publication: the states of the ready panel, the counters only once
   * /data holds their guards; within STATES_PER_MINUTE, the subjects in
   * turn (a subject left out this time comes first next time).
   */
  /**
   * The panel said nothing for STALE_AFTER while the session is up (review
   * r1, m4): its values are no longer published as current. It publishes no
   * time stamp; its silence is measured here, on the monotonic clock.
   */
  stale(mono = this.monotonic()) {
    return (
      this.up && this.lastMessageMono !== undefined && mono - this.lastMessageMono > STALE_AFTER
    );
  }

  async flush({ only } = {}) {
    const generation = this.generation;
    const mono = this.monotonic();
    if (!only) this.lastFlushMono = mono;
    if (!this.tree || !this.config.stored || this.stale(mono)) return;
    // Read now: never a reading older than this publication.
    const panel = readPanel(this.tree, this.config.stored.serial);
    if (panel.problem) return;
    const subjects = this.prepare(panel, { only });
    if (subjects.length === 0) return;
    const saved = await this.saveState();
    if (generation !== this.generation) return;
    const counterIds = new Set();
    if (!saved) {
      for (const subject of subjects) {
        for (const entry of subject.counters) {
          if (entry.counter) counterIds.add(`${subject.id}:${entry.key}`);
        }
      }
    }
    const ordered = [];
    const start = only ? 0 : this.rotation % subjects.length;
    for (let i = 0; i < subjects.length; i += 1)
      ordered.push(subjects[(start + i) % subjects.length]);
    const room = this.room();
    const batch = [];
    let taken = 0;
    for (const subject of ordered) {
      const states = subject.states.filter((s) => !counterIds.has(s.device_feature_external_id));
      if (batch.length + states.length > room) break;
      batch.push(...states);
      taken += 1;
    }
    if (!only) this.rotation = (start + taken) % subjects.length;
    if (taken < ordered.length) {
      this.logger.debug('SPAN: some values kept for the next publication (states per minute)');
    }
    if (batch.length > 0) await this.send(batch);
    if (generation === this.generation) await this.updateStatus();
  }

  /** States that may still be sent in the current minute. */
  room() {
    const mono = this.monotonic();
    this.sent = this.sent.filter((s) => mono - s.at < MINUTE);
    return Math.max(0, STATES_PER_MINUTE - this.sent.reduce((sum, s) => sum + s.count, 0));
  }

  /** Sends states already counted against the budget (reserved BEFORE the request). */
  async send(states) {
    if (states.length === 0 || states.length > this.room()) return;
    const entry = { at: this.monotonic(), count: states.length };
    this.sent.push(entry);
    try {
      const result = await this.gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT });
      if (Number.isInteger(result?.count) && result.count >= 0 && result.count <= states.length) {
        entry.count = result.count;
      }
    } catch (err) {
      this.logger.warn(`Publishing the SPAN values failed (${err?.name ?? 'Error'})`);
    }
  }

  /** A relay changed: its state (and requester) published shortly, not waiting for the interval. */
  scheduleRelayPublish(circuitId) {
    if (this.relayTimers.has(circuitId)) return;
    const generation = this.generation;
    this.relayTimers.set(
      circuitId,
      this.timers.setTimeout(() => {
        this.relayTimers.delete(circuitId);
        if (generation === this.generation) {
          this.publishRelay(circuitId).catch(() => {});
        }
      }, RELAY_PUBLISH_DELAY),
    );
  }

  async publishRelay(circuitId) {
    if (!this.tree || !this.config.stored || this.stale()) return;
    const serial = this.config.stored.serial;
    const panel = readPanel(this.tree, serial);
    if (panel.problem) return;
    const circuit = panel.circuits.find((c) => c.id === circuitId);
    if (!circuit) return;
    const ids = circuitIds(this.gladys, serial, circuitId);
    const created = this.createdDevice(ids.device);
    if (!created) return;
    const relayOnly = CIRCUIT_CATALOG.filter(
      (e) => e.key === CIRCUIT_KEYS.RELAY || e.key === CIRCUIT_KEYS.REQUESTER,
    );
    const states = statesOf(ids, relayOnly, circuit, keysOfDevice(created), () => undefined);
    await this.send(states);
  }

  // --- Status ----------------------------------------------------------------------------

  /** Every counter held back: `{ id, label, direction, from, to }`. */
  heldList() {
    const list = [];
    const panel = this.panel && !this.panel.problem ? this.panel : undefined;
    for (const [id, guard] of this.guards) {
      if (!guard.held) continue;
      let label = T.counter.feedImport;
      const key = id.split(':').at(-1);
      if (key === 'feed_export_total') label = T.counter.feedExport;
      else if (key !== 'feed_import_index') {
        const circuitPart = id.split(':').at(-2) ?? '';
        const circuit = panel?.circuits.find((c) => circuitPart.endsWith(`_${c.id}`));
        label = T.counter.circuit(
          circuit?.name ?? circuitPart,
          key === CIRCUIT_KEYS.PRODUCTION_INDEX,
        );
      }
      list.push({ id, label, ...guard.held });
    }
    return list;
  }

  async updateStatus() {
    const { problem, host } = this.config;
    if (problem) {
      await this.setStatus(false, T.problem[problem]);
      return;
    }
    if (this.storeUnreadable) {
      await this.setStatus(false, T.storeUnreadable);
      return;
    }
    if (!this.config.stored || !this.kept.ca) {
      await this.setStatus(false, T.notPaired);
      return;
    }
    if (this.kept.refusal) {
      await this.setStatus(
        false,
        this.kept.refusal.code === 'unanswered' ? T.unansweredStop : T.refused,
      );
      return;
    }
    if (this.pinNotSaved) {
      await this.setStatus(false, T.pinNotSaved);
      return;
    }
    const mono = this.monotonic();
    if (this.stale(mono)) {
      await this.setStatus(false, T.stale(mono - this.lastMessageMono));
      return;
    }
    const wait = this.retryAtMono === undefined ? 0 : Math.max(0, this.retryAtMono - mono);
    if (!this.up) {
      if (this.lastError === 'untrusted' || this.lastError === 'certificateDate') {
        const seen = this.kept.seen?.fingerprint;
        await this.setStatus(false, T.untrusted(host, this.kept.ca.fingerprint, seen, wait));
      } else if (this.lastError) {
        await this.setStatus(false, T.failing(host, this.lastError, wait));
      } else {
        await this.setStatus(false, T.connecting(host));
      }
      return;
    }
    const panel = this.panel;
    if (!panel) {
      await this.setStatus(false, T.panel.notDescribed);
      return;
    }
    if (panel.problem) {
      const messages = {
        notDescribed: T.panel.notDescribed,
        notPanel: T.panel.notPanel,
        notReady: T.panel.notReady(panel.state),
        otherPanel: T.panel.otherPanel(this.config.stored.serial, panel.seen),
        dataModel: T.panel.dataModel(panel.version),
      };
      await this.setStatus(false, messages[panel.problem] ?? T.panel.notDescribed);
      return;
    }
    const notes = [];
    if (!this.createdDevice(panelIds(this.gladys, panel.serial).device))
      notes.push(T.notes.noDevice);
    notes.push(this.config.allowRelay ? T.notes.relayOn : T.notes.relayOff);
    if (this.tree?.dropped > 0) notes.push(T.notes.dropped(this.tree.dropped));
    if (this.saveFailed) notes.push(T.notes.storeFailed);
    const held = this.heldList();
    if (held.length > 0) notes.push(T.notes.held(held));
    await this.setStatus(true, T.ok(panel, notes));
  }

  // --- Relay commands -----------------------------------------------------------------

  /**
   * The `relay` list of a circuit: OPEN (cut the circuit) or CLOSED (power
   * it again). Throws with the reason when refused or not confirmed.
   */
  setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const serial = this.config.stored?.serial;
    const parsed = serial
      ? parseCircuitFeature(this.gladys, serial, feature?.external_id)
      : undefined;
    if (!parsed || parsed.key !== CIRCUIT_KEYS.RELAY) {
      return Promise.reject(relayError('notCommandable'));
    }
    const wanted = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
    if (wanted !== RELAY.OPEN && wanted !== RELAY.CLOSED) {
      return Promise.reject(relayError('badValue'));
    }
    if (!this.config.allowRelay) return Promise.reject(relayError('disabled'));
    // One command at a time per circuit (never per panel: a scene on several
    // circuits sets them all at once).
    const { circuitId } = parsed;
    const previous = this.relayChains.get(circuitId) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(() => this.sendRelay(serial, circuitId, wanted, received));
    this.relayChains.set(circuitId, job);
    const clear = () => {
      if (this.relayChains.get(circuitId) === job) this.relayChains.delete(circuitId);
    };
    job.then(clear, clear);
    return job;
  }

  async sendRelay(serial, circuitId, wanted, received) {
    // From here to the publication, ONE turn of the event loop (no await):
    // the option, the session and the state of the circuit are read right
    // before the command leaves, never from a former check.
    if (this.monotonic() - received > SEND_WITHIN) throw relayError('late');
    if (!this.config.allowRelay) throw relayError('disabled');
    const client = this.client;
    if (!client || !this.up || !client.connected || !this.tree) throw relayError('notConnected');
    // A panel silent too long: its state is not current (review r2, m7).
    if (this.stale()) throw relayError('stale');
    if (this.config.stored?.serial !== serial) throw relayError('notReady');
    // The state of THIS session, read now (never a memory of a former one).
    const panel = readPanel(this.tree, serial);
    if (panel.problem) throw relayError('notReady');
    const circuit = panel.circuits.find((c) => c.id === circuitId);
    if (!circuit) throw relayError('unknownCircuit');
    if (!circuit.settable || !circuit.controllable) throw relayError('notControllable');
    if (!circuit.relay) throw relayError('unknownState');
    if (circuit.relay === wanted) {
      // Already in that state: nothing to send.
      this.scheduleRelayPublish(circuitId);
      return;
    }
    let settle;
    const outcome = new Promise((resolve) => {
      settle = resolve;
    });
    let timer;
    const waiter = {
      circuitId,
      // Only the state asked confirms (it differs from the state before, read
      // above): the state before published again is "not applied yet".
      seen: (text) => {
        if (text === wanted) waiter.done('confirmed');
      },
      done: (result) => {
        this.waiters.delete(waiter);
        if (timer !== undefined) this.timers.clearTimeout(timer);
        settle(result);
      },
    };
    this.waiters.add(waiter);
    const sent = await new Promise((resolve) => {
      try {
        client.publish(
          `${TOPIC_ROOT}${circuitId}/switch/relay/set`,
          wanted,
          { qos: 0, retain: false },
          (err) => resolve(!err),
        );
      } catch {
        resolve(false);
      }
    });
    if (!sent) {
      waiter.done('notSent');
      throw relayError('nothingSent');
    }
    this.logger.info(`SPAN: relay ${wanted} sent to circuit ${circuitId}`);
    const left = Math.max(0, received + CONFIRM_RELAY_WITHIN - this.monotonic());
    timer = this.timers.setTimeout(() => waiter.done('timeout'), left);
    const result = await outcome;
    if (result !== 'confirmed') throw relayError('unconfirmed');
    this.scheduleRelayPublish(circuitId);
  }

  // --- Configuration screen buttons -------------------------------------------------

  /** "Pair with the panel": see the head of this file. One registration per click at most. */
  async pair() {
    if (this.pairing) return T.pair.running;
    this.pairing = true;
    try {
      return await this.doPair();
    } finally {
      this.pairing = false;
    }
  }

  async doPair() {
    const config = this.config;
    if (config.problem) return T.problem[config.problem];
    if (this.storeUnreadable) return T.pair.storeUnreadable;
    const { host, httpPort, httpsPort } = config;
    const sameConfig = () => this.config === config;
    let status;
    let candidate;
    try {
      status = await this.http.getStatus({ host, port: httpPort });
      candidate = await this.http.getCa({ host, port: httpPort });
    } catch (err) {
      return T.pair.unreachable(host, err?.reason ?? failureOf(err));
    }
    if (!sameConfig()) return T.pair.changed;
    // The trust decision: the pin, the fingerprint typed, or a second click.
    const pinned = this.kept.ca;
    const mono = this.monotonic();
    let trusted = pinned?.fingerprint === candidate.fingerprint;
    if (!trusted && config.fingerprint) {
      if (config.fingerprint !== candidate.fingerprint) {
        return T.pair.fingerprintDiffers(config.fingerprint, candidate.fingerprint);
      }
      trusted = true;
    }
    if (!trusted) {
      const pending = this.pendingPin;
      this.pendingPin = undefined;
      const elapsed = pending ? mono - pending.at : undefined;
      const confirmed =
        pending &&
        pending.host === host &&
        pending.fingerprint === candidate.fingerprint &&
        elapsed >= CONFIRM_AFTER &&
        elapsed <= CONFIRM_WITHIN;
      if (!confirmed) {
        this.pendingPin = { at: mono, host, fingerprint: candidate.fingerprint };
        // Another authority than the one shown a moment ago, same address:
        // said plainly (review r1, m1), and it starts over (two clicks again).
        const previous =
          pending &&
          pending.host === host &&
          pending.fingerprint !== candidate.fingerprint &&
          elapsed <= CONFIRM_WITHIN
            ? pending.fingerprint
            : undefined;
        return T.pair.confirmPin(
          status.serial,
          candidate.fingerprint,
          pinned?.fingerprint,
          CONFIRM_WITHIN,
          previous,
        );
      }
    }
    this.pendingPin = undefined;
    // The authority must sign the HTTPS certificate of the panel (handshake only).
    try {
      await this.probe(host, httpsPort, candidate.pem, candidate.fingerprint);
    } catch (err) {
      return T.pair.notSigned(host, err?.reason ?? failureOf(err));
    }
    if (!sameConfig()) return T.pair.changed;
    // Pinned in /data BEFORE any secret leaves; a failed write stops here.
    if (pinned?.fingerprint !== candidate.fingerprint) {
      const before = { ca: this.kept.ca, seen: this.kept.seen };
      this.kept.ca = candidate;
      this.kept.seen = null;
      if (!(await this.saveState({ force: true }))) {
        Object.assign(this.kept, before);
        return T.pair.saveFailed;
      }
      this.logger.info('SPAN: certificate authority of the panel pinned');
    }
    const proximity = !config.passphrase;
    let credentials;
    try {
      credentials = await this.http.register({
        host,
        port: httpsPort,
        pin: candidate,
        passphrase: config.passphrase || undefined,
      });
    } catch (err) {
      const reason = err?.reason;
      if (reason === 'refused')
        return proximity ? T.pair.refusedProximity : T.pair.refusedPassphrase;
      if (reason === 'unavailable') return T.pair.unavailable;
      if (reason === 'notReady') return T.pair.notReady;
      if (reason === 'badAnswer') return T.pair.badAnswer;
      return T.pair.failed(host, reason ?? failureOf(err));
    }
    if (credentials.serial !== status.serial) {
      return T.pair.otherPanel(status.serial, credentials.serial);
    }
    if (!sameConfig()) return T.pair.changed;
    const stored = {
      [STORED.USERNAME]: credentials.username,
      [STORED.PASSWORD]: credentials.password,
      [STORED.PORT]: credentials.port,
      [STORED.SERIAL]: credentials.serial,
    };
    try {
      await this.gladys.setConfig(stored);
    } catch {
      return T.pair.configFailed;
    }
    this.logger.info(`SPAN: paired with the panel ${credentials.serial}`);
    // A new pairing lifts a refusal of the broker.
    this.kept.refusal = null;
    await this.saveState();
    if (!sameConfig()) return T.pair.changed;
    await this.start({ ...this.raw, ...stored }, { fresh: true });
    return T.pair.done(credentials.serial, proximity);
  }

  /**
   * "Accept the held counter", in two clicks: the first lists every counter
   * held (nothing is accepted), the second, from 3 s to 5 min later, accepts
   * exactly what the first listed, and only when it still shows that value
   * (or, for a jump, what may have come since: src/guard.js). A save of the
   * form never accepts.
   */
  async acceptHeldCounter() {
    const list = this.heldList();
    const mono = this.monotonic();
    const now = this.sessionNow();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const elapsed = pending ? mono - pending.at : undefined;
    if (!pending || elapsed > CONFIRM_WITHIN || elapsed < CONFIRM_AFTER) {
      if (list.length === 0) return T.accept.nothing;
      this.pendingAccept = { at: mono, listedAt: now, list };
      return T.accept.confirm(list, CONFIRM_WITHIN);
    }
    const accepted = [];
    const changed = [];
    for (const entry of pending.list) {
      const guard = this.guards.get(entry.id);
      const held = guard?.held;
      const margin = guard ? guard.margin(pending.listedAt, now) : 0;
      const same =
        held &&
        held.direction === entry.direction &&
        held.from === entry.from &&
        held.to >= entry.to &&
        held.to - entry.to <= margin;
      if (same && guard.acceptHeld()) accepted.push({ ...entry, to: held.to });
      else if (held) changed.push(entry);
    }
    if (accepted.length === 0 && changed.length === 0) return T.accept.nothing;
    for (const { label, direction } of accepted) {
      this.logger.info(
        `SPAN counter "${label.en}" ${direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
      );
    }
    await this.saveState();
    const taken = new Set(accepted.map((h) => h.id));
    const stillHeld = this.heldList().some((h) => !taken.has(h.id));
    return T.accept.done(accepted, changed, stillHeld);
  }

  /** "Test the connection": what the session knows now (never a new connection). */
  async testConnection() {
    if (this.kept.refusal?.code === 'unanswered') {
      // A broker that closed without answering: one new try per click.
      this.kept.refusal = null;
      await this.saveState();
      this.unanswered = 0;
      this.unansweredLeft = 1;
      this.failures = 0;
      this.openSession(this.generation);
    }
    if (this.up && this.tree) await this.refresh();
    else await this.updateStatus();
    const status = this.lastStatus ? JSON.parse(this.lastStatus)[1] : undefined;
    return status ?? T.connecting(this.config.host || '?');
  }
}
