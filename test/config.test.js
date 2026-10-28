// -----------------------------------------------------------------------------
// The configuration of the form and what the pairing keeps, normalized.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf, hostOf, integerOf, normalizeConfig, storedOf } from '../src/config.js';

test('the address: an IP or a host name, nothing else', () => {
  assert.equal(hostOf(' 192.168.1.80 '), '192.168.1.80');
  assert.equal(hostOf('Span-Panel.local'), 'span-panel.local');
  assert.equal(hostOf('[fe80::1]'), 'fe80::1');
  for (const bad of [
    'http://192.168.1.80',
    '192.168.1.80:80',
    '192.168.1.80/api',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '::',
    'ff02::1',
    'a b',
    'host\r\nx',
    '1.2.3',
    '',
  ]) {
    assert.equal(hostOf(bad), undefined, bad);
  }
});

test('the fingerprint: 64 hex digits, colons and case free; empty allowed', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(fingerprintOf(hex.toUpperCase().match(/../g).join(':')), hex);
  assert.equal(fingerprintOf(''), '');
  assert.equal(fingerprintOf('abc'), undefined);
});

test('the form: problems named, defaults, bounds; the secrets never altered', () => {
  assert.equal(normalizeConfig().problem, 'noHost');
  assert.equal(normalizeConfig({ host: 'x/y' }).problem, 'badHost');
  assert.equal(normalizeConfig({ host: 'h', passphrase: 'a\nb' }).problem, 'badPassphrase');
  assert.equal(normalizeConfig({ host: 'h', ca_fingerprint: 'zz' }).problem, 'badFingerprint');
  const c = normalizeConfig({ host: 'h', passphrase: ' spaced pass ', publish_interval: 5 });
  assert.equal(c.problem, undefined);
  assert.equal(c.passphrase, ' spaced pass ');
  assert.equal(c.interval, 30);
  assert.equal(normalizeConfig({ host: 'h', publish_interval: '9999' }).interval, 600);
  assert.equal(normalizeConfig({ host: 'h' }).interval, 60);
  assert.equal(normalizeConfig({ host: 'h' }).allowRelay, false, 'off by default');
  assert.equal(normalizeConfig({ host: 'h', allow_relay_control: 'true' }).allowRelay, false);
  assert.equal(normalizeConfig({ host: 'h', allow_relay_control: true }).allowRelay, true);
  assert.equal(normalizeConfig({ host: 'h' }).httpsPort, 443);
  assert.equal(integerOf('1.5', 0, 9), undefined);
  assert.equal(integerOf('', 0, 9), undefined);
});

test('the credentials of the pairing: complete and well-formed, or none', () => {
  const ok = {
    broker_username: 'u',
    broker_password: 'p',
    broker_port: 8883,
    paired_serial: 'nt-1',
  };
  assert.deepEqual(storedOf(ok), { username: 'u', password: 'p', port: 8883, serial: 'nt-1' });
  assert.equal(storedOf({ ...ok, broker_password: '' }), undefined);
  assert.equal(storedOf({ ...ok, paired_serial: 'a:b' }), undefined);
  assert.equal(storedOf({ ...ok, broker_username: 'x\u0000' }), undefined);
  assert.equal(storedOf({ ...ok, broker_port: 'abc' }).port, 8883);
});
