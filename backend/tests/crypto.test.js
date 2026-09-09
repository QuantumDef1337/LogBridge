'use strict';

/**
 * Tests for AES-256-GCM credential encryption (Section 32 — crypto).
 * Uses Node.js built-in test runner (no external dependencies).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Set a fixed key so tests are deterministic
process.env.LOGBRIDGE_ENCRYPTION_KEY = '0'.repeat(64);

const { encrypt, decrypt, decryptRow } = require('../src/crypto');

describe('encrypt / decrypt', () => {
  test('round-trip: encrypt then decrypt gives back the original', () => {
    const plain = 'hunter2';
    const ct = encrypt(plain);
    assert.notEqual(ct, plain);
    assert.equal(decrypt(ct), plain);
  });

  test('encrypted values start with the enc:v1: prefix', () => {
    const ct = encrypt('secret');
    assert.match(ct, /^enc:v1:/);
  });

  test('two calls to encrypt with the same plaintext produce different ciphertext (random IV)', () => {
    const ct1 = encrypt('same');
    const ct2 = encrypt('same');
    assert.notEqual(ct1, ct2);
    assert.equal(decrypt(ct1), 'same');
    assert.equal(decrypt(ct2), 'same');
  });

  test('decrypt is a no-op on plain (non-encrypted) values — backward compat', () => {
    const plain = 'not-yet-encrypted';
    assert.equal(decrypt(plain), plain);
  });

  test('encrypt is a no-op if the value is already encrypted', () => {
    const ct = encrypt('hello');
    const ct2 = encrypt(ct); // should return same ciphertext unchanged
    assert.equal(ct, ct2);
  });

  test('decrypt throws on tampered ciphertext', () => {
    const ct = encrypt('data');
    const tampered = ct.slice(0, -4) + 'XXXX';
    assert.throws(() => decrypt(tampered));
  });
});

describe('decryptRow', () => {
  test('decrypts the password field and leaves other fields untouched', () => {
    const row = { id: 1, name: 'prod', password: encrypt('s3cr3t'), url: 'http://x' };
    const decrypted = decryptRow(row);
    assert.equal(decrypted.password, 's3cr3t');
    assert.equal(decrypted.id, 1);
    assert.equal(decrypted.name, 'prod');
    assert.equal(decrypted.url, 'http://x');
  });

  test('does not mutate the original row', () => {
    const ct = encrypt('pw');
    const row = { password: ct };
    decryptRow(row);
    assert.equal(row.password, ct); // original still encrypted
  });

  test('handles null/undefined row gracefully', () => {
    assert.equal(decryptRow(null), null);
    assert.equal(decryptRow(undefined), undefined);
  });
});
