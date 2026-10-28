// -----------------------------------------------------------------------------
// What must survive a restart of the container (a small JSON file under
// /data, the only writable place): the certificate authority of the panel
// pinned at pairing (public, not a secret), a refusal of the broker
// credentials (a final stop), the authority the panel advertised when the pin
// refused its certificate (shown in the status, public too), and the guards
// of the lifetime counters.
//
// No secret is ever written: neither the passphrase nor the broker
// credentials (Gladys keeps those in its database). While the broker refuses
// the credentials, the file keeps a TRUNCATED fingerprint of what was
// refused: 8 bits of a salted scrypt (random salt per file) of the user name
// and the password, enough to see after a restart whether a new pairing
// changed them since, far too little to confirm or find a password. It is
// erased by the first successful connection. (After gladys-openems.)
//
// A file that exists but cannot be read (rights, a disk error, broken JSON)
// is NOT an empty file: `load()` says `unreadable`, and the app then never
// writes over it (nor publishes a counter /data cannot keep, nor pins a
// certificate) until a start reads it again. Written through a temporary
// file and a rename, one write at a time; a failure is never fatal.
// -----------------------------------------------------------------------------

import { X509Certificate, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { MAX_CA_BYTES } from './constants.js';

export const DEFAULT_STATE_FILE = '/data/span-panel-state.json';
const MAX_FILE = 256 * 1024;
const MAX_COUNTERS = 200;

/**
 * A JSON file: `load()` (sync: `{ data }`, `{ data: {} }` when absent,
 * `{ unreadable: true }` otherwise) and `save(data)` (atomic).
 */
export function createFileStore(file = DEFAULT_STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: {} } : { unreadable: true };
      }
      try {
        if (text.length > MAX_FILE) return { unreadable: true };
        const data = JSON.parse(text);
        return data && typeof data === 'object' && !Array.isArray(data)
          ? { data }
          : { unreadable: true };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests). `unreadable`: load() says so; `failSave`: save() rejects. */
export function createMemoryStore(
  initial = {},
  { unreadable = false, failSave = false, slow = false } = {},
) {
  let data = structuredClone(initial);
  let saves = 0;
  const store = {
    unreadable,
    failSave,
    slow,
    load: () => (store.unreadable ? { unreadable: true } : { data: structuredClone(data) }),
    async save(next) {
      if (store.slow) for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      if (store.failSave) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
    get saves() {
      return saves;
    },
  };
  return store;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const HEX64 = /^[0-9a-f]{64}$/;
const FP = /^[0-9a-f]{2}$/;
/** The external id of a counter feature (src/devices.js). */
const COUNTER_ID =
  /^ext:[A-Za-z0-9_.-]{1,64}:(?:panel|circuit):[A-Za-z0-9_-]{1,130}:[a-z0-9_]{1,40}$/;

/** The SHA-256 fingerprint of a PEM certificate (64 lowercase hex), or undefined. */
export function pemFingerprint(pem) {
  if (typeof pem !== 'string' || pem.length > MAX_CA_BYTES) return undefined;
  if (!pem.trimStart().startsWith('-----BEGIN CERTIFICATE-----')) return undefined;
  try {
    return new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
  } catch {
    return undefined;
  }
}

/** A fingerprint as people compare it: AB:CD:... (uppercase pairs). */
export const shownFingerprint = (hex) =>
  typeof hex === 'string' && HEX64.test(hex) ? hex.toUpperCase().match(/../g).join(':') : '?';

/** The pinned certificate authority read back: its PEM must still give its fingerprint. */
export function validCa(ca) {
  if (!isObject(ca) || typeof ca.fingerprint !== 'string' || !HEX64.test(ca.fingerprint)) {
    return undefined;
  }
  return pemFingerprint(ca.pem) === ca.fingerprint
    ? { pem: ca.pem, fingerprint: ca.fingerprint }
    : undefined;
}

/**
 * A stop read back: `{ code: 'refused' | 'unanswered', fp }` (credentials
 * refused, or the CONNECT closed twice without answer), no end by time.
 */
export function validRefusal(refusal) {
  if (
    !isObject(refusal) ||
    (refusal.code !== 'refused' && refusal.code !== 'unanswered') ||
    typeof refusal.fp !== 'string' ||
    !FP.test(refusal.fp)
  ) {
    return undefined;
  }
  return { code: refusal.code, fp: refusal.fp };
}

/** The persisted state, sanitized: every field checked, no prototype. */
export function readState(raw) {
  const data = isObject(raw) ? raw : {};
  const salt =
    typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
      ? data.salt
      : randomBytes(16).toString('hex');
  const counters = Object.create(null);
  if (isObject(data.counters)) {
    for (const [id, state] of Object.entries(data.counters).slice(0, MAX_COUNTERS)) {
      if (COUNTER_ID.test(id) && isObject(state)) counters[id] = state;
    }
  }
  return {
    salt,
    ca: validCa(data.ca) ?? null,
    // Kept until a connection succeeds, whatever the time: never tried again by itself.
    refusal: validRefusal(data.refusal) ?? null,
    // The authority the panel advertised when the pin refused its certificate:
    // shown in the status, pinned only when the user types its fingerprint.
    seen: validCa(data.seen) ?? null,
    counters,
  };
}

/**
 * The truncated (8-bit) salted fingerprint of REFUSED broker credentials
 * (none holds a control character, so the separator is unambiguous). Never a
 * secret.
 */
export function fingerprint(salt, { username, password }) {
  const text = [username, password].map(String).join('\u0000');
  return scryptSync(text, salt, 16).subarray(0, 1).toString('hex');
}
