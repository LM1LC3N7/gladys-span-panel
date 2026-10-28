// -----------------------------------------------------------------------------
// The Homie 5 tree the panel publishes on its broker (`ebus/5/<device>/...`,
// retained), as received in ONE MQTT session: every session starts from an
// empty tree, so nothing of a former session (nor of a former process) is
// ever taken for current. Pure, bounded, linear.
//
// Kept per device: its `$description` (parsed: type, name, root, parent,
// children, and per node the declared properties with datatype, unit,
// settable), its `$state`, and the value of each `<node>/<property>`. Every
// other topic (`/set`, `$target`, a deeper attribute) is ignored. A topic
// over MAX_TOPIC_BYTES, a payload over its bound, a device beyond
// MAX_DEVICES, a property beyond MAX_PROPERTIES are dropped and counted,
// never stored; nothing read is ever used as an object key (Maps only).
// -----------------------------------------------------------------------------

import { ID } from '../config.js';
import {
  MAX_DESCRIPTION_BYTES,
  MAX_DEVICES,
  MAX_PROPERTIES,
  MAX_TOPIC_BYTES,
  MAX_VALUE_BYTES,
  TOPIC_ROOT,
} from '../constants.js';

/** A Homie node or property id. */
const PART = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const str = (v, max = 128) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** A `$description` payload, normalized, or undefined when it is not one. */
export function parseDescription(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  const type = str(own(raw, 'type'));
  if (!type) return undefined;
  const nodes = new Map();
  const rawNodes = own(raw, 'nodes');
  if (isObject(rawNodes)) {
    for (const [nodeId, node] of Object.entries(rawNodes).slice(0, 64)) {
      if (!PART.test(nodeId) || !isObject(node)) continue;
      const properties = new Map();
      const rawProps = own(node, 'properties');
      if (isObject(rawProps)) {
        for (const [propId, prop] of Object.entries(rawProps).slice(0, MAX_PROPERTIES)) {
          if (!PART.test(propId) || !isObject(prop)) continue;
          properties.set(propId, {
            datatype: str(own(prop, 'datatype'), 16),
            unit: str(own(prop, 'unit'), 16),
            format: str(own(prop, 'format'), 2048),
            settable: own(prop, 'settable') === true,
          });
        }
      }
      nodes.set(nodeId, { type: str(own(node, 'type')), properties });
    }
  }
  const children = own(raw, 'children');
  return {
    type,
    name: str(own(raw, 'name'), 256),
    root: str(own(raw, 'root'), 64),
    parent: str(own(raw, 'parent'), 64),
    children: Array.isArray(children)
      ? children.filter((c) => typeof c === 'string' && ID.test(c)).slice(0, MAX_DEVICES)
      : [],
    nodes,
  };
}

export class HomieTree {
  constructor() {
    /** id → { id, description, state, values: Map('<node>/<prop>' → text) } */
    this.devices = new Map();
    /** Messages dropped (too large, too many, malformed), for the status. */
    this.dropped = 0;
  }

  device(id) {
    let device = this.devices.get(id);
    if (!device) {
      if (this.devices.size >= MAX_DEVICES) return undefined;
      device = { id, description: undefined, state: undefined, values: new Map() };
      this.devices.set(id, device);
    }
    return device;
  }

  /**
   * One message of the broker. Returns what it was: `{ id, kind:
   * 'description' | 'state' | 'value', key }`, or undefined when ignored.
   */
  ingest(topic, payload) {
    if (typeof topic !== 'string' || topic.length > MAX_TOPIC_BYTES) {
      this.dropped += 1;
      return undefined;
    }
    if (!topic.startsWith(TOPIC_ROOT)) return undefined;
    const parts = topic.slice(TOPIC_ROOT.length).split('/');
    const [id, a, b] = parts;
    if (!ID.test(id ?? '')) return undefined;
    const size = payload?.length ?? 0;
    if (parts.length === 2 && (a === '$description' || a === '$state')) {
      const max = a === '$description' ? MAX_DESCRIPTION_BYTES : MAX_VALUE_BYTES;
      if (size > max) {
        this.dropped += 1;
        return undefined;
      }
      const device = this.device(id);
      if (!device) {
        this.dropped += 1;
        return undefined;
      }
      const text = Buffer.from(payload ?? []).toString('utf8');
      if (a === '$state') {
        device.state = text.length <= 16 ? text : undefined;
        return { id, kind: 'state' };
      }
      // An empty retained payload clears the description; a malformed one too.
      device.description = text ? parseDescription(text) : undefined;
      if (text && !device.description) this.dropped += 1;
      return { id, kind: 'description' };
    }
    if (parts.length !== 3 || !PART.test(a ?? '') || !PART.test(b ?? '')) return undefined;
    if (size > MAX_VALUE_BYTES) {
      this.dropped += 1;
      return undefined;
    }
    const device = this.device(id);
    if (!device) {
      this.dropped += 1;
      return undefined;
    }
    const key = `${a}/${b}`;
    const text = Buffer.from(payload ?? []).toString('utf8');
    if (text === '') {
      // An empty retained payload clears the value: unknown, never 0.
      device.values.delete(key);
    } else if (device.values.has(key) || device.values.size < MAX_PROPERTIES) {
      device.values.set(key, text);
    } else {
      this.dropped += 1;
      return undefined;
    }
    return { id, kind: 'value', key };
  }

  /** The text of `<node>/<prop>` of a device, or undefined. */
  text(id, node, prop) {
    return this.devices.get(id)?.values.get(`${node}/${prop}`);
  }

  /** What the description of a device declares for `<node>/<prop>`, or undefined. */
  declared(id, node, prop) {
    return this.devices.get(id)?.description?.nodes.get(node)?.properties.get(prop);
  }
}
