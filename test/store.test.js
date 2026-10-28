// -----------------------------------------------------------------------------
// /data: read back strictly (a pin whose PEM does not give its fingerprint is
// no pin), an unreadable file is not an empty one, atomic writes, the files
// of the tests removed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, fingerprint, pemFingerprint, readState } from '../src/store.js';
import { certs } from './kit/index.mjs';

const PIN = { pem: certs.device.cert, fingerprint: pemFingerprint(certs.device.cert) };

test('the state read back: every field checked', () => {
  const state = readState({
    salt: 'a'.repeat(32),
    ca: PIN,
    seen: { pem: certs.impostor.cert, fingerprint: PIN.fingerprint },
    refusal: { code: 'refused', fp: '0f' },
    counters: {
      'ext:span:circuit:nt-1_abc:consumption_index': { guard: {} },
      __proto__: { x: 1 },
      bad: {},
    },
  });
  assert.deepEqual(state.ca, PIN);
  assert.equal(state.seen, null, 'a PEM that does not give its fingerprint');
  assert.deepEqual(state.refusal, { code: 'refused', fp: '0f' });
  assert.deepEqual(Object.keys(state.counters), ['ext:span:circuit:nt-1_abc:consumption_index']);
  assert.equal(Object.getPrototypeOf(state.counters), null);
  assert.equal(readState({ refusal: { code: 'x', fp: '0f' } }).refusal, null);
  assert.match(readState(null).salt, /^[0-9a-f]{32}$/);
});

test('the fingerprint of refused credentials: 8 bits, salted', () => {
  const fp = fingerprint('b'.repeat(32), { username: 'u', password: 'p' });
  assert.match(fp, /^[0-9a-f]{2}$/);
});

test('the file: atomic, unreadable is not empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'span-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(store.load(), { data: {} });
  await store.save({ a: 1 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: 1 });
  await writeFile(file, '{broken');
  assert.deepEqual(store.load(), { unreadable: true });
  await writeFile(file, '[1]');
  assert.deepEqual(store.load(), { unreadable: true });
});
