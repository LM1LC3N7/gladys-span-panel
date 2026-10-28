// -----------------------------------------------------------------------------
// The MQTT session with the broker of the panel (MQTTS, port given by the
// panel at pairing): mqtt.js over a TLS socket built here, for three reasons:
//   - the socket trusts the pinned certificate authority of the panel only,
//     and NOTHING is written to it (not even the CONNECT with the broker
//     password) before the peer is verified against the pin (src/span/tls.js);
//   - every packet the broker sends is bounded BEFORE it is buffered: the
//     fixed header announces its length, and a packet over MAX_PACKET cuts
//     the connection at once (PacketGuard, from gladys-pglab, approved);
//   - one client at a time, no automatic reconnection by mqtt.js
//     (src/app.js decides when to try again, with its own pace), nothing
//     queued while offline (a command leaves now or is refused).
// MQTT 3.1.1, as the reference client (paho, span-panel-api).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { Duplex, Transform } from 'node:stream';
import tls from 'node:tls';
import { MqttClient } from 'mqtt';
import { CONNECT_TIMEOUT, MAX_PACKET } from '../constants.js';
import { peerPinned, pinnedOptions, spanError } from './tls.js';

/** MQTT 3.1.1 CONNACK refusals worth a precise message. */
export const REFUSALS = {
  1: 'protocol',
  2: 'identifier',
  3: 'serverUnavailable',
  4: 'credentials',
  5: 'notAuthorized',
};

/**
 * Cuts the stream as soon as a packet header announces more than `max`
 * bytes (or is malformed): the rest is never buffered. Packets are tracked
 * across chunks (header bytes, then the body skipped).
 */
export class PacketGuard extends Transform {
  constructor(max = MAX_PACKET) {
    super();
    this.max = max;
    this.skip = 0;
    this.header = [];
  }

  _transform(chunk, _encoding, callback) {
    let i = 0;
    // Where the packet being refused starts in this chunk: the packets before
    // it (a CONNACK in the same chunk...) are still delivered before the cut.
    let start = 0;
    const cut = (code) => {
      if (start > 0) {
        this.push(chunk.subarray(0, start));
      }
      callback(spanError(code));
    };
    while (i < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - i);
        this.skip -= n;
        i += n;
        continue;
      }
      if (this.header.length === 0) {
        start = i;
      }
      this.header.push(chunk[i]);
      i += 1;
      if (this.header.length === 1) {
        continue;
      }
      const last = this.header[this.header.length - 1];
      if (last & 0x80) {
        if (this.header.length >= 5) {
          return cut('MALFORMED_PACKET');
        }
        continue;
      }
      let length = 0;
      let factor = 1;
      for (let k = 1; k < this.header.length; k += 1) {
        length += (this.header[k] & 0x7f) * factor;
        factor *= 128;
      }
      if (length + this.header.length > this.max) {
        return cut('PACKET_TOO_LARGE');
      }
      this.skip = length;
      this.header = [];
    }
    return callback(null, chunk);
  }
}

/**
 * The TLS socket to the broker, pinned, its incoming side behind the guard.
 * What mqtt.js writes (the CONNECT first) is held until the handshake is done
 * AND the peer matches the pin; `onOpen` is called then. A peer that does not
 * match destroys the stream with `NOT_PINNED` before any byte left.
 */
export function pinnedStream({ host, port, pin }, { onOpen } = {}) {
  const socket = tls.connect({ host, port, ...pinnedOptions(pin.pem) });
  const guard = new PacketGuard();
  let verified = false;
  const held = [];
  const stream = new Duplex({
    read() {
      guard.resume();
    },
    write(chunk, _encoding, callback) {
      if (verified) socket.write(chunk, callback);
      else held.push([chunk, callback]);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(err, callback) {
      socket.destroy();
      guard.destroy();
      for (const [, cb] of held.splice(0)) cb(err ?? spanError('CLOSED'));
      callback(err);
    },
  });
  socket.once('secureConnect', () => {
    if (!peerPinned(socket, pin.fingerprint)) {
      stream.destroy(spanError('NOT_PINNED'));
      return;
    }
    verified = true;
    onOpen?.();
    for (const [chunk, cb] of held.splice(0)) socket.write(chunk, cb);
    // Only now is anything read from the broker.
    socket.pipe(guard);
  });
  guard.on('data', (chunk) => {
    if (!stream.push(chunk)) {
      guard.pause();
    }
  });
  guard.on('end', () => stream.push(null));
  guard.on('error', (err) => stream.destroy(err));
  socket.on('error', (err) => stream.destroy(err));
  socket.on('close', () => stream.destroy());
  return stream;
}

/**
 * A client to the broker of the panel (never reconnecting by itself). The
 * credentials leave only on the verified socket (pinnedStream).
 */
export function connectBroker(
  { host, port, pin, username, password },
  { onAttempt, onOpen, streamBuilder } = {},
) {
  return new MqttClient(
    streamBuilder ??
      (() => {
        onAttempt?.();
        return pinnedStream({ host, port, pin }, { onOpen });
      }),
    {
      username,
      password,
      // A random client id: two instances (a test and a restart) never kick each other out.
      clientId: `gladys-span-${randomBytes(4).toString('hex')}`,
      clean: true,
      keepalive: 60,
      connectTimeout: CONNECT_TIMEOUT,
      reconnectPeriod: 0,
      protocolVersion: 4,
      resubscribe: false,
      queueQoSZero: false,
    },
  );
}

/** Our own word for a session error (never the password, never a byte of the broker). */
export function sessionReason(err) {
  if (!err) return 'network';
  if (typeof err.code === 'number' && REFUSALS[err.code]) return REFUSALS[err.code];
  if (err.code === 'PACKET_TOO_LARGE' || err.code === 'MALFORMED_PACKET') return 'tooLarge';
  if (err.code === 'NOT_PINNED') return 'untrusted';
  if (err.message === 'connack timeout') return 'noConnack';
  return undefined;
}

/** The broker refused the credentials. */
export const isRefusal = (err) => err?.code === 4 || err?.code === 5;
