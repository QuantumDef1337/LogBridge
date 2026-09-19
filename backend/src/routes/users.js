'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');

function requireAdmin(req, res, next) {
  if (!['super_admin', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function sanitizeUser(u) {
  const { password_hash, mfa_secret, ...safe } = u;
  return safe;
}

// ── Static routes first (must come before /:id) ──────────────────────────────

// My profile
router.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(sanitizeUser(user));
});

router.put('/me/profile', requireAuth, (req, res) => {
  const { display_name, email } = req.body;
  const db = getDb();
  db.prepare("UPDATE users SET display_name = ?, email = ?, updated_at = datetime('now') WHERE id = ?")
    .run(display_name || null, email || null, req.user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(sanitizeUser(updated));
});

// System security settings
router.get('/settings/security', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM system_settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json(settings);
});

router.put('/settings/security', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const allowed = [
    'login_history_retention_days',
    'failed_attempts_threshold', 'lockout_duration_minutes', 'min_password_length',
    'password_history_depth', 'session_idle_timeout_minutes', 'mfa_backup_codes_count',
  ];
  const upsert = db.prepare("INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) upsert.run(k, String(v));
  }
  const rows = db.prepare('SELECT key, value FROM system_settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
});

// Login activity
router.get('/activity/logins', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 100;
  const rows = db.prepare('SELECT * FROM login_activity ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json(rows);
});

// ── List users ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  res.json(users.map(sanitizeUser));
});

// ── Create user ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, requireAdmin, (req, res) => {
  const { username, display_name, email, password, role = 'analyst', force_password_reset = false, require_mfa_enrollment = false } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, display_name, email, password_hash, role, force_password_reset, require_mfa_enrollment) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(username, display_name || null, email || null, hash, role, force_password_reset ? 1 : 0, require_mfa_enrollment ? 1 : 0);

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(sanitizeUser(created));
});

// ── Get single user ─────────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
  if (!isAdmin && req.user.id !== user.id) return res.status(403).json({ error: 'Forbidden' });
  res.json(sanitizeUser(user));
});

// ── Update user ─────────────────────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
  const isSelf = req.user.id === user.id;
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'Forbidden' });

  const { display_name, email, role, is_active, force_password_reset, require_mfa_enrollment } = req.body;

  const fields = [];
  const values = [];
  if (display_name !== undefined) { fields.push('display_name = ?'); values.push(display_name); }
  if (email !== undefined) { fields.push('email = ?'); values.push(email); }
  if (isAdmin && role !== undefined) { fields.push('role = ?'); values.push(role); }
  if (isAdmin && is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  if (isAdmin && force_password_reset !== undefined) { fields.push('force_password_reset = ?'); values.push(force_password_reset ? 1 : 0); }
  if (isAdmin && require_mfa_enrollment !== undefined) { fields.push('require_mfa_enrollment = ?'); values.push(require_mfa_enrollment ? 1 : 0); }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  res.json(sanitizeUser(updated));
});

// ── Delete user ─────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (req.user.id === user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── MFA setup — generate secret + QR ────────────────────────────────────────
router.post('/:id/mfa/setup', requireAuth, (req, res) => {
  const isSelf = req.user.id === parseInt(req.params.id);
  if (!isSelf) return res.status(403).json({ error: 'Forbidden' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const secret = speakeasy.generateSecret({ name: `LogBridge (${user.username})`, length: 20 });
  db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secret.base32, req.params.id);

  const otpAuthUrl = speakeasy.otpauthURL({
    secret: secret.ascii,
    label: `LogBridge:${user.username}`,
    issuer: 'LogBridge',
    encoding: 'ascii',
  });

  QRCode.toDataURL(otpAuthUrl)
    .then(qrDataUrl => res.json({ secret: secret.base32, qr_url: qrDataUrl }))
    .catch(err => res.status(500).json({ error: 'QR generation failed' }));
});

// ── MFA verify — confirm code, enable MFA ───────────────────────────────────
router.post('/:id/mfa/verify', requireAuth, (req, res) => {
  const isSelf = req.user.id === parseInt(req.params.id);
  if (!isSelf) return res.status(403).json({ error: 'Forbidden' });

  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user || !user.mfa_secret) return res.status(400).json({ error: 'MFA setup not initiated' });

  const valid = speakeasy.totp.verify({ secret: user.mfa_secret, encoding: 'base32', token, window: 1 });
  if (!valid) return res.status(400).json({ error: 'Invalid code — try again' });

  db.prepare('UPDATE users SET mfa_enabled = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, mfa_enabled: true });
});

// ── MFA disable ──────────────────────────────────────────────────────────────
router.post('/:id/mfa/disable', requireAuth, (req, res) => {
  const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
  const isSelf = req.user.id === parseInt(req.params.id);
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'Forbidden' });

  const db = getDb();
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true, mfa_enabled: false });
});

module.exports = router;
