const router = require('express').Router();
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const { getDb } = require('../db');
const { signToken } = require('../auth');

router.post('/login', (req, res) => {
  const { username, password, mfa_token } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  function logActivity(success) {
    try {
      db.prepare('INSERT INTO login_activity (username, success, ip_address) VALUES (?, ?, ?)').run(username, success ? 1 : 0, req.ip || null);
    } catch {}
  }

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    logActivity(false);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!user.is_active && user.is_active !== null && user.is_active !== undefined) {
    logActivity(false);
    return res.status(401).json({ error: 'Account is inactive' });
  }

  // If MFA is enabled, require the token
  if (user.mfa_enabled) {
    if (!mfa_token) {
      return res.json({ mfa_required: true });
    }
    const valid = speakeasy.totp.verify({
      secret: user.mfa_secret,
      encoding: 'base32',
      token: mfa_token,
      window: 1,
    });
    if (!valid) {
      logActivity(false);
      return res.status(401).json({ error: 'Invalid MFA code' });
    }
  }

  logActivity(true);
  const token = signToken({ id: user.id, username: user.username, role: user.role || 'analyst' });
  res.json({ token, username: user.username, role: user.role || 'analyst', force_password_reset: !!user.force_password_reset });
});

router.post('/change-password', require('../auth').requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
