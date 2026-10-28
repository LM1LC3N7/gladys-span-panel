// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, the keys the integration keeps in its configuration, feature
// keys in src/devices.js, the external id rule) is forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = {
  PAIR: 'pair_panel',
  TEST: 'test_connection',
  ACCEPT_HELD: 'accept_held_counter',
};

/**
 * What the integration keeps in its own configuration (setConfig, keys
 * outside the config_schema: never shown in the form, kept by Gladys in its
 * database). The broker password comes from the panel at pairing.
 */
export const STORED = {
  USERNAME: 'broker_username',
  PASSWORD: 'broker_password',
  PORT: 'broker_port',
  SERIAL: 'paired_serial',
};

/** External id types (forever): `panel:<serial>`, `circuit:<serial>_<circuit id>`. */
export const EXTERNAL_ID_TYPES = { PANEL: 'panel', CIRCUIT: 'circuit' };

// --- The local API of the panel ("eBus", firmware r202633 or later) ----------------
export const DEFAULT_HTTP_PORT = 80;
export const DEFAULT_HTTPS_PORT = 443;
export const PATHS = {
  STATUS: '/api/v2/status',
  CA: '/api/v2/certificate/ca',
  REGISTER: '/api/v2/auth/register',
};
/** The client name given at pairing (the panel lists its clients); a random suffix follows. */
export const CLIENT_NAME = 'gladys';
/** The 422 detail of a panel that cannot read its own passphrase (span-panel-api). */
export const PASSPHRASE_UNAVAILABLE = 'Dashboard password is not available';
/** An HTTP answer of the panel, at most (a status or a registration is under 1 KB). */
export const MAX_HTTP_BODY = 64 * 1024;
/** The certificate authority of the panel, at most (a PEM is about 2 KB). */
export const MAX_CA_BYTES = 16 * 1024;
/** Each HTTP(S) exchange with the panel, connection included. */
export const HTTP_TIMEOUT = 8_000;
/** The TLS check of the certificate authority (handshake only, nothing sent). */
export const PROBE_TIMEOUT = 5_000;

/** The Homie 5 tree of the panel on its broker. */
export const TOPIC_ROOT = 'ebus/5/';
export const SUBSCRIPTION = 'ebus/5/#';
/** The device types read (energy.ebus.device.*). */
export const TYPES = {
  PANEL: 'energy.ebus.device.distribution-enclosure',
  CIRCUIT: 'energy.ebus.device.circuit',
  LUGS: 'energy.ebus.device.lugs',
  BESS: 'energy.ebus.device.bess',
  PV: 'energy.ebus.device.pv',
  MID: 'energy.ebus.device.mid',
};
/** The data-model versions read (parent/child tree, firmware r202633 or later). */
export const DATA_MODEL_MAJOR = 1;

// --- Bounds of what the broker may send ------------------------------------------------
/**
 * An MQTT packet, at most: a description of the data model 1.x is under
 * 10 KB, the single description of the flat schema of older firmware about
 * 60 KB for 40 spaces (read only to say the firmware is too old).
 */
export const MAX_PACKET = 256 * 1024;
/** A `$description` payload, at most. */
export const MAX_DESCRIPTION_BYTES = 192 * 1024;
/** Any other value, at most (the shed policy, a JSON document, is about 120 bytes). */
export const MAX_VALUE_BYTES = 1024;
/** A topic, at most. */
export const MAX_TOPIC_BYTES = 256;
/** The devices of one tree, at most (a 48-space panel with every DER is about 60). */
export const MAX_DEVICES = 160;
/** The properties of one device, at most (a panel has about 50). */
export const MAX_PROPERTIES = 200;
/** The circuits published, at most (48 spaces). */
export const MAX_CIRCUITS = 64;
/** The circuit name shown, at most (characters). */
export const MAX_NAME = 60;

// --- MQTT session -------------------------------------------------------------------
export const DEFAULT_MQTTS_PORT = 8883;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** CONNECT to CONNACK. */
export const CONNECT_TIMEOUT = 15 * SECOND;
/** Reconnection after a lost or failed session: 5 s, 15 s, 30 s, 1 min, 2 min, then 5 min. */
export const RECONNECT = [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE];
/** A CONNECT left unanswered this many times in a row: the next tries are 15 min apart. */
export const UNANSWERED_MAX = 3;
export const UNANSWERED_PAUSE = 15 * MINUTE;
/** The panel CA the panel advertises is fetched again (to show it) at most this often. */
export const CA_DIAGNOSE_EVERY = 15 * MINUTE;

// --- Schedule ------------------------------------------------------------------------
/** The publication interval of the form (s): 60 s by default, 30 to 600. */
export const INTERVAL_DEFAULT = 60;
export const INTERVAL_MIN = 30;
export const INTERVAL_MAX = 600;
/** The states sent in any 60 s, at most (the core refuses a whole batch beyond 300). */
export const STATES_PER_MINUTE = 270;
/** Unchanged values are sent again after this delay while the panel says they are current. */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** getConfig() failed: asked again after 5 s, 15 s, 30 s, then every minute, without end. */
export const CONFIG_RETRY = [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE];
/** The second click of "Accept the held counter" counts from 3 s to 5 min after the first. */
export const CONFIRM_AFTER = 3 * SECOND;
export const CONFIRM_WITHIN = 5 * MINUTE;

// --- Relay commands ------------------------------------------------------------------
/** A command is sent within this delay of the click, or refused unsent. */
export const SEND_WITHIN = 2_500;
/** The relay is confirmed by the state the panel publishes back by this delay after the click. */
export const CONFIRM_RELAY_WITHIN = 3_300;
export const RELAY = { OPEN: 'OPEN', CLOSED: 'CLOSED' };

// --- Energy ---------------------------------------------------------------------------
/**
 * The margin of the guards of the lifetime counters (src/guard.js): a circuit
 * never draws more than 60 kW (250 A at 240 V), the feed of the panel never
 * more than 120 kW (500 A at 240 V); a little more is always accepted.
 */
export const CIRCUIT_LIMITS = { maxKw: 60, slackKwh: 0.5 };
export const FEED_LIMITS = { maxKw: 120, slackKwh: 1 };
/** A power above this (W, either sign) is a glitch. */
export const POWER_MAX = 500_000;
/** A lifetime counter above this (kWh) is a glitch. */
export const ENERGY_MAX = 100_000_000;
/** A voltage outside this range (V) is a glitch. */
export const VOLTAGE_MAX = 400;
