// -----------------------------------------------------------------------------
// The REST bootstrap of the panel (the "eBus" local API, span-panel-api
// auth.py ported): its status and its certificate authority over plain HTTP
// (unauthenticated by nature: the authority fetched is only a CANDIDATE until
// the user confirms its fingerprint, src/app.js), and the registration of a
// client over HTTPS checked against the pinned authority only: the passphrase
// never travels in the clear, nor does the broker password the panel answers.
//
// Bounded: one exchange at a time per call, HTTP_TIMEOUT for the whole of it,
// an answer over MAX_HTTP_BODY cut before it is read in full (a declared
// Content-Length over it is refused at once). Every error is one of our own
// words (src/span/tls.js failureOf); never a byte of the answer in a log.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { ID, secretOf } from '../config.js';
import {
  CLIENT_NAME,
  HTTP_TIMEOUT,
  MAX_CA_BYTES,
  MAX_HTTP_BODY,
  PASSPHRASE_UNAVAILABLE,
  PATHS,
} from '../constants.js';
import { pemFingerprint } from '../store.js';
import { failureOf, peerPinned, pinnedOptions, spanError } from './tls.js';

const hostHeader = (host, port) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

/**
 * One request. `pin`: `{ pem, fingerprint }` for HTTPS (nothing is written
 * before the peer is verified against it), absent for plain HTTP. Resolves
 * `{ status, text }`; rejects with `{ code, reason }`.
 */
export function request(
  { host, port, method = 'GET', path, json, pin, accept = 'application/json' },
  { timeout = HTTP_TIMEOUT, maxBytes = MAX_HTTP_BODY } = {},
) {
  return new Promise((resolve, reject) => {
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json), 'utf8');
    const headers = {
      Host: hostHeader(host, port),
      Accept: accept,
      Connection: 'close',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
    };
    const options = {
      host,
      port,
      method,
      path,
      headers,
      // A fresh socket per request (no keep-alive, no socket shared with a
      // request of another pin), so that its handshake is always checked here.
      agent: false,
      ...(pin ? pinnedOptions(pin.pem) : {}),
    };
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(Object.assign(err, { reason: err.reason ?? failureOf(err) }));
      } else resolve(value);
    };
    const req = (pin ? https : http).request(options, (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        finish(Object.assign(spanError('TOO_LARGE'), { reason: 'tooLarge' }));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          finish(Object.assign(spanError('TOO_LARGE'), { reason: 'tooLarge' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        finish(undefined, {
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => finish(err));
    });
    const timer = setTimeout(() => finish(spanError('TIMEOUT')), timeout);
    req.on('error', (err) => finish(err));
    if (!pin) {
      req.end(body);
      return;
    }
    // HTTPS: the request (headers, passphrase) leaves only once the panel
    // proved it holds a certificate of the pinned authority.
    req.once('socket', (socket) => {
      socket.once('secureConnect', () => {
        if (!peerPinned(socket, pin.fingerprint)) {
          finish(spanError('NOT_PINNED'));
          return;
        }
        req.end(body);
      });
    });
  });
}

/** A JSON object of an answer, or undefined (never a prototype taken from it). */
export function jsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

/** GET /api/v2/status (plain HTTP, unauthenticated): `{ serial, firmware }`. */
export async function getStatus({ host, port }) {
  const answer = await request({ host, port, path: PATHS.STATUS });
  if (answer.status !== 200) {
    throw Object.assign(spanError('HTTP'), { reason: 'notSpan', status: answer.status });
  }
  const body = jsonObject(answer.text);
  const serial = body && own(body, 'serialNumber');
  if (typeof serial !== 'string' || !ID.test(serial)) {
    throw Object.assign(spanError('BAD_ANSWER'), { reason: 'notSpan' });
  }
  const firmware = own(body, 'firmwareVersion');
  return {
    serial,
    firmware: typeof firmware === 'string' && firmware.length <= 64 ? firmware : undefined,
  };
}

/**
 * GET /api/v2/certificate/ca (plain HTTP): a CANDIDATE authority `{ pem,
 * fingerprint }`, trusted only once the user confirmed its fingerprint.
 */
export async function getCa({ host, port }) {
  const answer = await request(
    { host, port, path: PATHS.CA, accept: 'application/x-pem-file, text/plain, */*' },
    { maxBytes: MAX_CA_BYTES },
  );
  if (answer.status === 429) {
    throw Object.assign(spanError('HTTP'), { reason: 'busy', status: 429 });
  }
  if (answer.status !== 200) {
    throw Object.assign(spanError('HTTP'), { reason: 'notSpan', status: answer.status });
  }
  // One certificate: the first block only.
  const match = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/.exec(
    answer.text,
  );
  const pem = match ? `${match[0].replace(/\r\n/g, '\n')}\n` : undefined;
  const fingerprint = pemFingerprint(pem);
  if (!fingerprint) throw Object.assign(spanError('BAD_ANSWER'), { reason: 'badCa' });
  return { pem, fingerprint };
}

/**
 * POST /api/v2/auth/register over HTTPS, pinned. Without `passphrase`, the
 * panel accepts the client only after its door was opened and closed three
 * times (proximity). Every call adds a client on the panel: only ever on a
 * click of the user. Resolves the broker credentials `{ username, password,
 * port, serial }`; rejects with a `reason`: `refused` (passphrase or
 * proximity), `unavailable` (the panel cannot read its passphrase),
 * `notReady` (5xx), `badAnswer`, or a network word.
 */
export async function register({ host, port, pin, passphrase }) {
  const json = { name: `${CLIENT_NAME}-${randomBytes(4).toString('hex')}` };
  if (passphrase) json.hopPassphrase = passphrase;
  const answer = await request({ host, port, method: 'POST', path: PATHS.REGISTER, json, pin });
  const body = jsonObject(answer.text);
  if (answer.status >= 500) {
    throw Object.assign(spanError('HTTP'), { reason: 'notReady', status: answer.status });
  }
  if (answer.status === 422 && body && own(body, 'detail') === PASSPHRASE_UNAVAILABLE) {
    throw Object.assign(spanError('HTTP'), { reason: 'unavailable', status: 422 });
  }
  if ([401, 403, 422].includes(answer.status)) {
    throw Object.assign(spanError('HTTP'), { reason: 'refused', status: answer.status });
  }
  if (answer.status !== 200 || !body) {
    throw Object.assign(spanError('HTTP'), { reason: 'badAnswer', status: answer.status });
  }
  const password = own(body, 'ebusBrokerPassword');
  if (password === null || password === undefined) {
    // From r202639 the panel answers without broker password when it cannot read its passphrase.
    throw Object.assign(spanError('HTTP'), { reason: 'unavailable', status: 200 });
  }
  const username = secretOf(own(body, 'ebusBrokerUsername'));
  const brokerPort = own(body, 'ebusBrokerMqttsPort');
  const serial = own(body, 'serialNumber');
  if (
    !username ||
    !secretOf(password) ||
    !Number.isInteger(brokerPort) ||
    brokerPort < 1 ||
    brokerPort > 65535 ||
    typeof serial !== 'string' ||
    !ID.test(serial)
  ) {
    throw Object.assign(spanError('BAD_ANSWER'), { reason: 'badAnswer' });
  }
  return { username, password, port: brokerPort, serial };
}
