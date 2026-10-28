// -----------------------------------------------------------------------------
// The certificate authority of the panel, pinned: every TLS connection to the
// panel (HTTPS for the pairing, MQTTS for the session) trusts this one
// authority only (never the system ones), and is accepted only once Node
// verified the chain against it AND the chain shows the pinned fingerprint.
// The host name is not checked: the panel names itself (span-<serial>.local),
// rarely the address the user typed; the pin of an authority that belongs to
// this one panel is the anchor, and the serial of the panel is checked on top
// (src/app.js).
//
// Nothing is written to a socket before that check (src/span/http.js and
// src/span/mqtt.js hold every byte until then).
// -----------------------------------------------------------------------------

import tls from 'node:tls';
import { PROBE_TIMEOUT } from '../constants.js';

/** The TLS options of a connection that trusts the pinned authority only. */
export function pinnedOptions(pem) {
  return {
    ca: [pem],
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    // The chain is verified against `ca`; the host name is not (see above).
    checkServerIdentity: () => undefined,
  };
}

const normalized = (fp) => (typeof fp === 'string' ? fp.replaceAll(':', '').toLowerCase() : '');

/**
 * Whether the TLS socket was verified by Node AND its chain holds the pinned
 * authority (`fingerprint`, 64 hex). A chain is walked at most 10 deep.
 */
export function peerPinned(socket, fingerprint) {
  if (!socket?.authorized) return false;
  let cert;
  try {
    cert = socket.getPeerCertificate(true);
  } catch {
    return false;
  }
  for (let depth = 0; cert && depth < 10; depth += 1) {
    if (normalized(cert.fingerprint256) === fingerprint) return true;
    if (!cert.issuerCertificate || cert.issuerCertificate === cert) break;
    cert = cert.issuerCertificate;
  }
  return false;
}

/** Our own words for a TLS or network failure (never a byte of the peer). */
export function failureOf(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') return 'certificateDate';
  if (
    /CERT|SELF_SIGNED|ISSUER|SIGNATURE|VERIFY|UNTRUSTED|NOT_PINNED/.test(code) ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    return 'untrusted';
  }
  if (code === 'ECONNREFUSED') return 'refusedPort';
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'notFound';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (/^ERR_SSL|^ERR_TLS|EPROTO/.test(code)) return 'tls';
  return 'network';
}

/** An error of ours, with a code from failureOf's vocabulary. */
export const spanError = (code) => Object.assign(new Error(code), { code });

/**
 * A TLS handshake only, against the pinned `pem`: resolves when the panel at
 * `host:port` presents a certificate the authority signs; rejects with an
 * error whose `reason` is failureOf's word. Nothing is ever sent.
 */
export function probe(host, port, pem, fingerprint, { timeout = PROBE_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tls.connect({ host, port, ...pinnedOptions(pem) });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(Object.assign(err, { reason: failureOf(err) }));
      else resolve();
    };
    const timer = setTimeout(() => finish(spanError('TIMEOUT')), timeout);
    socket.once('secureConnect', () =>
      finish(peerPinned(socket, fingerprint) ? undefined : spanError('NOT_PINNED')),
    );
    socket.once('error', (err) => finish(err));
    socket.once('close', () => finish(spanError('ECONNRESET')));
  });
}
