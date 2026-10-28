// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The devices use
// only the units the core accepts for their categories, and the core's rules
// for `supported_options` (a whole Discovery is refused for one bad option).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { ACTIONS, INTERVAL_DEFAULT, INTERVAL_MAX, INTERVAL_MIN, STORED } from '../src/constants.js';
import { CIRCUIT_CATALOG, PANEL_CATALOG } from '../src/devices.js';
import { createdDevices } from './helpers/app.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; the same version everywhere (semver, never pinned by hand)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, '0.1.0');
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-span-panel:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-span-panel');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\./);
  assert.match(pkg.dependencies.mqtt, /^\^5\./);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the docs say it was never tested with a real device', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+appareil/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
      assert.equal(typeof text[lang], 'string', `${path}.${lang}`);
    }
  }
});

test('the configuration matches the code; the secret is described as kept, never shown', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'host',
    'passphrase',
    'ca_fingerprint',
    'allow_relay_control',
    'publish_interval',
    'http_port',
    'https_port',
  ]);
  for (const key of [...Object.keys(fields), ...Object.values(STORED)]) {
    assert.doesNotMatch(key, /^gladys_/);
    assert.match(key, /^[a-z0-9_]+$/);
  }
  // What the pairing keeps is never a field of the form (never shown).
  for (const key of Object.values(STORED)) assert.equal(fields[key], undefined, key);
  assert.equal(fields.passphrase.type, 'secret');
  assert.equal('default' in fields.passphrase, false, 'never a default on a secret');
  assert.match(
    fields.passphrase.description.en,
    /Kept by Gladys in its database, never shown again, sent only to the SPAN panel/,
  );
  assert.match(
    fields.passphrase.description.fr,
    /Gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement au tableau SPAN/,
  );
  assert.equal(fields.allow_relay_control.default, false, 'off by default');
  assert.equal(fields.publish_interval.default, INTERVAL_DEFAULT);
  assert.equal(fields.publish_interval.min, INTERVAL_MIN);
  assert.equal(fields.publish_interval.max, INTERVAL_MAX);
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  assert.match(fields.intro.description.en, /Never tested with a real device/);
  assert.match(fields.intro.description.en, /SPAN servers are never contacted/);
});

test('the actions of the manifest are the handlers of the code', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(handlers.includes('onAction(ACTIONS.PAIR'));
  assert.ok(handlers.includes('onAction(ACTIONS.TEST'));
  assert.ok(handlers.includes('onAction(ACTIONS.ACCEPT_HELD'));
  assert.ok(handlers.includes('onSetValue('));
  assert.ok(handlers.includes("on('connected'"));
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120, action.key);
  }
  assert.match(manifest.actions[0].description.en, /First click.*Second click/);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /span-panel-api/);
  assert.match(notices, /SpanPanel\/span/);
  assert.match(notices, /distribution-enclosure-simulator/);
  assert.match(notices, /MIT License/);
  assert.match(notices, /MQTT\.js/);
});

test('the code never feeds the energy consumption endpoint, nor publishes a scene event', () => {
  for (const file of ['index.js', 'src/app.js', 'src/devices.js', 'src/handlers.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(|publishSceneEvent\(/, file);
  }
});

// The units the core accepts per category (server/utils/constants.js
// DEVICE_FEATURE_UNITS_BY_CATEGORY), for the categories used here.
const UNITS_BY_CATEGORY = {
  [C.ENERGY_SENSOR]: [U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR, U.VOLT, U.AMPERE],
  [C.ENERGY_PRODUCTION_SENSOR]: [U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.GRID_SENSOR]: [U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.HOME_OUTPUT_SENSOR]: [U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.BATTERY_STORAGE]: [U.PERCENT, U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.TEXT]: [],
  [C.UNKNOWN]: [],
};

test('every feature: a unit its category accepts, unique keys, never a switch nor a binary', () => {
  const devices = createdDevices();
  const ids = new Set();
  for (const device of devices) {
    for (const f of device.features) {
      assert.ok(f.category in UNITS_BY_CATEGORY, `${f.external_id}: ${f.category}`);
      if (f.unit !== undefined) {
        assert.ok(UNITS_BY_CATEGORY[f.category].includes(f.unit), `${f.external_id}: ${f.unit}`);
      }
      assert.notEqual(f.category, C.SWITCH, 'never a switch');
      assert.notEqual(f.type, TYPES.SWITCH.BINARY, 'never a binary');
      assert.ok(!ids.has(f.external_id), f.external_id);
      ids.add(f.external_id);
      assert.doesNotMatch(f.external_id.split(':').slice(2).join(':'), /\.|\.\./);
      if (f.external_id.endsWith(':relay')) {
        assert.equal(f.type, TYPES.TEXT.SELECT);
      } else {
        assert.equal(f.read_only, true, f.external_id);
      }
    }
  }
  // The only indexes: consumption per circuit and of the main lugs, production of a solar circuit.
  const indexes = [...PANEL_CATALOG, ...CIRCUIT_CATALOG]
    .filter((e) => /index/.test(e.spec.type))
    .map((e) => `${e.spec.category}/${e.spec.type}:${e.key}`);
  assert.deepEqual(indexes, [
    'energy-sensor/index:feed_import_index',
    'energy-sensor/index:consumption_index',
    'energy-production-sensor/index:production_index',
  ]);
  // Every lifetime counter is guarded (src/app.js counterValue).
  for (const entry of [...PANEL_CATALOG, ...CIRCUIT_CATALOG]) {
    if (/index|_total$/.test(entry.key)) assert.ok(entry.counter, entry.key);
  }
});

// The core's own validator of supported_options, when a Gladys clone is at hand
// (not on GitHub CI): the rules below are its schema, this is the proof.
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

test('the supported options follow the rules of the core (a bad one refuses all Discovery)', () => {
  const OPTION_KEYS = ['id', 'value', 'label', 'sort_order'];
  let lists = 0;
  for (const device of createdDevices()) {
    for (const f of device.features) {
      if (f.supported_options === undefined) continue;
      lists += 1;
      const allowStringValues = f.category === C.TEXT && f.type === TYPES.TEXT.SELECT;
      assert.ok(Array.isArray(f.supported_options) && f.supported_options.length > 0);
      for (const option of f.supported_options) {
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.trim().length > 0);
        assert.equal(option.label, option.label.trim());
        assert.ok(
          Number.isInteger(option.value) ||
            (allowStringValues &&
              typeof option.value === 'string' &&
              option.value.length > 0 &&
              option.value === option.value.trim()),
        );
        assert.deepEqual(
          Object.keys(option).filter((k) => !OPTION_KEYS.includes(k)),
          [],
        );
      }
      const values = f.supported_options.map((o) => `${o.value}`);
      assert.equal(new Set(values).size, values.length);
      if (normalizeSupportedOptions) {
        assert.doesNotThrow(() =>
          normalizeSupportedOptions(f.supported_options, { allowStringValues }),
        );
      }
    }
  }
  assert.equal(lists, 16, 'one relay list per circuit');
});
