const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'logbridge-secret-change-in-production';
const JWT_EXPIRES = '24h';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

const ROLE_WEIGHT = { super_admin: 4, admin: 3, analyst: 2, viewer: 1 };

function requireAdmin(req, res, next) {
  const w = ROLE_WEIGHT[req.user?.role] ?? 1;
  if (w < 3) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireAnalyst(req, res, next) {
  const w = ROLE_WEIGHT[req.user?.role] ?? 1;
  if (w < 2) return res.status(403).json({ error: 'Analyst access required' });
  next();
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, requireAnalyst };
