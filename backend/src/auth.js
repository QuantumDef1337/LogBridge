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

module.exports = { signToken, verifyToken, requireAuth };
