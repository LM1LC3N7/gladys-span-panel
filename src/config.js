// -----------------------------------------------------------------------------
// The configuration of the form (manifest `config_schema`) and what the
// integration keeps in its own configuration after a pairing (src/constants.js
// STORED), checked and normalized. Pure.
//
// Nothing here is ever logged, nor written to /data, nor shown: the
// passphrase and the broker password only leave towards the panel.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import {
  DEFAULT_HTTPS_PORT,
  DEFAULT_HTTP_PORT,
  DEFAULT_MQTTS_PORT,
  INTERVAL_DEFAULT,
  INTERVAL_MAX,
  INTERVAL_MIN,
  STORED,
} from './constants.js';

/** A device id of the Homie tree and a panel serial: no `.`, no `:`, no `/`. */
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Any C0 control byte and DEL: never in an address, a secret or a header.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const text = (value) => (typeof value === 'string' ? value : '');

/** A strict integer of a range (a number or its digits), or undefined. */
export function integerOf(value, min, max) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) n = Number(value.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * The address of the panel: a host name or an IP address, nothing else (no
 * scheme, port, path, nor a broadcast, multicast or unspecified address).
 */
export function hostOf(value) {
  const host = text(value).trim();
  if (!host || host.length > 253 || CONTROL.test(host)) return undefined;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const version = isIP(bare);
  if (version === 4) {
    const parts = bare.split('.').map(Number);
    if (parts[0] === 0 || parts[0] >= 224 || parts.every((p) => p === 255)) return undefined;
    return bare;
  }
  if (version === 6) {
    const lower = bare.toLowerCase();
    if (lower === '::' || lower.startsWith('ff')) return undefined;
    return lower;
  }
  return HOSTNAME.test(host) && !/^\d+(\.\d+)*$/.test(host) ? host.toLowerCase() : undefined;
}

/** A SHA-256 fingerprint typed by the user (with or without colons), as 64 lowercase hex. */
export function fingerprintOf(value) {
  const raw = text(value).trim();
  if (!raw) return '';
  const hex = raw.replace(/[\s:]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/** A secret: a non-empty string without control character, 1 to 256 bytes. */
export function secretOf(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (CONTROL.test(value) || Buffer.byteLength(value) > 256) return undefined;
  return value;
}

/** The credentials kept after a pairing, when complete and well-formed. */
export function storedOf(raw = {}) {
  const username = secretOf(raw[STORED.USERNAME]);
  const password = secretOf(raw[STORED.PASSWORD]);
  const port = integerOf(raw[STORED.PORT], 1, 65535) ?? DEFAULT_MQTTS_PORT;
  const serial = typeof raw[STORED.SERIAL] === 'string' ? raw[STORED.SERIAL] : '';
  if (!username || !password || !ID.test(serial)) return undefined;
  return { username, password, port, serial };
}

/**
 * The configuration, normalized. `problem` names what prevents any
 * connection (no address, a malformed field); the integration then only says
 * so in its status.
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const hostText = text(source.host).trim();
  const host = hostOf(hostText);
  const passphraseText = text(source.passphrase);
  const passphrase = passphraseText ? secretOf(passphraseText) : '';
  const fingerprint = fingerprintOf(source.ca_fingerprint);
  let problem;
  if (!hostText) problem = 'noHost';
  else if (!host) problem = 'badHost';
  else if (passphrase === undefined) problem = 'badPassphrase';
  else if (fingerprint === undefined) problem = 'badFingerprint';
  const interval = integerOf(source.publish_interval, 0, 1_000_000);
  return {
    host: host ?? '',
    passphrase: passphrase ?? '',
    fingerprint: fingerprint ?? '',
    allowRelay: source.allow_relay_control === true,
    interval:
      interval === undefined
        ? INTERVAL_DEFAULT
        : Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, interval)),
    httpPort: integerOf(source.http_port, 1, 65535) ?? DEFAULT_HTTP_PORT,
    httpsPort: integerOf(source.https_port, 1, 65535) ?? DEFAULT_HTTPS_PORT,
    stored: storedOf(source),
    problem,
  };
}
