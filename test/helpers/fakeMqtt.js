// A fake mqtt.js client (after gladys-pglab): what the app subscribed to and
// published, and the broker side (open, deliver the retained tree or a live
// message, refuse, close). `responder` plays the panel: it is called on every
// publication and may deliver answers.

import { EventEmitter } from 'node:events';
import { retainedTree } from './fakePanel.js';

export class FakeMqttClient extends EventEmitter {
  constructor(config, responder) {
    super();
    this.config = config;
    this.responder = responder;
    this.connected = false;
    this.subscriptions = new Set();
    this.published = [];
    this.ended = false;
    this.publishError = undefined;
  }

  subscribe(topics, options, callback) {
    for (const topic of [].concat(topics)) this.subscriptions.add(topic);
    callback?.(null, []);
  }

  publish(topic, payload, options, callback) {
    if (this.publishError) {
      callback?.(this.publishError);
      return;
    }
    this.published.push({ topic, payload: String(payload), ...options });
    this.responder?.(topic, String(payload), this);
    callback?.();
  }

  end() {
    this.ended = true;
    this.connected = false;
  }

  // --- The broker side ---
  open() {
    this.options?.onOpen?.();
    this.emit('packetreceive', { cmd: 'connack' });
    this.connected = true;
    this.emit('connect');
  }

  /** The retained tree (Map topic → payload), retain flag set. */
  tree(topics = retainedTree()) {
    for (const [topic, payload] of topics) this.deliver(topic, payload, { retain: true });
  }

  deliver(topic, payload, packet = { retain: false }) {
    this.emit('message', topic, Buffer.from(String(payload)), packet);
  }

  close() {
    this.connected = false;
    this.emit('close');
  }

  /** The broker takes the CONNECT and closes without CONNACK. */
  unanswered() {
    this.options?.onOpen?.();
    this.connected = false;
    this.emit('close');
  }

  refuse(code = 4) {
    this.options?.onOpen?.();
    this.emit('packetreceive', { cmd: 'connack' });
    this.emit('error', Object.assign(new Error('Connection refused'), { code }));
    this.emit('close');
  }

  fail(code) {
    this.emit('error', Object.assign(new Error(code), { code }));
    this.emit('close');
  }

  /** The relay commands sent. */
  commands() {
    return this.published.filter((p) => p.topic.endsWith('/switch/relay/set'));
  }
}

/** A connect function for the app, keeping every client it creates. */
export function fakeConnector(responder) {
  const clients = [];
  const connector = {
    clients,
    responder,
    connect: (config, options = {}) => {
      const client = new FakeMqttClient(config, (...args) => connector.responder?.(...args));
      client.options = options;
      options.onAttempt?.();
      clients.push(client);
      return client;
    },
  };
  return connector;
}
