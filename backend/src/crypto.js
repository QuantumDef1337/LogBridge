/**
 * Credential encryption at rest — AES-256-GCM authenticated encryption.
 *
 * Key source (in order of preference):
 *   1. LOGBRIDGE_ENCRYPTION_KEY env var — a 64-character hex string (32 bytes)
 *   2. Auto-generated key written to logbridge.key in the backend dir
 *      (acceptable for single-node homelab; for production, use env var)
 *
 * Ciphertext format (stored in DB):
 *   enc:v1:<hex-iv>:<hex-authTag>:<hex-ciphertext>
 *
 * Migration: plaintext values (no "enc:v1:" prefix) are detected and returned
 * as-is from decrypt(), so existing credentials continue working until they
 * are re-saved through the API.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join(__dirname, '..', 'logbridge.key');
const PREFIX = 'enc:v1:';

let _key = null; // Buffer(32)

function getKey() {
  if (_key) return _key;

  // 1. From environment variable
  const envKey = process.env.LOGBRIDGE_ENCRYPTION_KEY;
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error('LOGBRIDGE_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
    _key = Buffer.from(envKey, 'hex');
    return _key;
  }

  // 2. From persistent key file (auto-generated on first run)
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    _key = Buffer.from(hex, 'hex');
    return _key;
  }

  // Generate a new key and persist it
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, newKey.toString('hex'), { mode: 0o600 });
  console.log('[crypto] Generated new encryption key at', KEY_FILE);
  console.log('[crypto] For production: export LOGBRIDGE_ENCRYPTION_KEY=$(cat', KEY_FILE + ')');
  _key = newKey;
  return _key;
}

/**
 * Encrypt a plaintext string.
 * Returns an "enc:v1:..." ciphertext string suitable for storage in SQLite.
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  // Don't double-encrypt
  if (String(plaintext).startsWith(PREFIX)) return plaintext;

  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Decrypt a ciphertext string produced by encrypt().
 * Plaintext values (no "enc:v1:" prefix) are returned as-is — backward compatible
 * with credentials stored before encryption was introduced.
 */
function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  const s = String(ciphertext);
  if (!s.startsWith(PREFIX)) return s; // plaintext — migration path

  const parts = s.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted credential format');

  const [ivHex, tagHex, ctHex] = parts;
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(ctHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

/**
 * Decrypt the password field(s) on a DB row before passing to a service.
 * Operates non-destructively: returns a new object, does not mutate the row.
 */
function decryptRow(row) {
  if (!row) return row;
  const out = { ...row };
  if (out.password !== undefined) out.password = decrypt(out.password);
  return out;
}

module.exports = { encrypt, decrypt, decryptRow };
