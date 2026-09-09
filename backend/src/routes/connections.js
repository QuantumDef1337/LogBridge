'use strict';

const router = require('express').Router();
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const os = require('../services/opensearch');
const { encrypt, decryptRow } = require('../crypto');
const audit = require('../audit');

router.use(requireAuth);

// Password is NEVER returned in list/get responses
const PUBLIC_COLS = 'id,name,url,username,tls_verify,created_at,updated_at';

router.get('/', (req, res) => {
  const rows = getDb().prepare(
    `SELECT ${PUBLIC_COLS} FROM opensearch_connections ORDER BY name`
  ).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = getDb().prepare(
    `SELECT ${PUBLIC_COLS} FROM opensearch_connections WHERE id=?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req, res) => {
  const { name, url, username, password, tls_verify } = req.body;
  if (!name || !url || !username || !password)
    return res.status(400).json({ error: 'name, url, username, password required' });
  const r = getDb().prepare(
    'INSERT INTO opensearch_connections (name,url,username,password,tls_verify) VALUES (?,?,?,?,?)'
  ).run(name, url.replace(/\/$/, ''), username, encrypt(password), tls_verify ? 1 : 0);
  audit.info('connection', `OpenSearch connection created: "${name}" (${url})`);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { name, url, username, password, tls_verify } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM opensearch_connections WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Only re-encrypt if a new password was supplied; otherwise keep the stored (already encrypted) value
  const storedPassword = password ? encrypt(password) : existing.password;

  db.prepare(
    "UPDATE opensearch_connections SET name=?,url=?,username=?,password=?,tls_verify=?,updated_at=datetime('now') WHERE id=?"
  ).run(
    name || existing.name,
    url ? url.replace(/\/$/, '') : existing.url,
    username || existing.username,
    storedPassword,
    tls_verify !== undefined ? (tls_verify ? 1 : 0) : existing.tls_verify,
    req.params.id
  );
  audit.info('connection', `OpenSearch connection updated: "${name || existing.name}" (${req.params.id})`);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const row = getDb().prepare('SELECT name FROM opensearch_connections WHERE id=?').get(req.params.id);
  getDb().prepare('DELETE FROM opensearch_connections WHERE id=?').run(req.params.id);
  audit.warn('connection', `OpenSearch connection deleted: "${row?.name || req.params.id}"`);
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM opensearch_connections WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const info = await os.testConnection(decryptRow(row));
    res.json({ ok: true, version: info.version?.number, cluster_name: info.cluster_name });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/:id/indices', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM opensearch_connections WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    res.json(await os.listIndices(decryptRow(row)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Discover physical indexes matching a wildcard pattern.
// Returns the same shape as /indices but filtered to pattern matches.
router.get('/:id/discover', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM opensearch_connections WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const pattern = (req.query.pattern || '').trim();
  try {
    const indexes = await os.discoverIndexes(decryptRow(row), pattern);
    res.json(indexes);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/timestamps', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM opensearch_connections WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { index_pattern } = req.body;
  if (!index_pattern) return res.status(400).json({ error: 'index_pattern required' });
  try {
    res.json(await os.getIndexTimestamps(decryptRow(row), index_pattern));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/sample', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM opensearch_connections WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { index_pattern, size = 3 } = req.body;
  if (!index_pattern) return res.status(400).json({ error: 'index_pattern required' });
  try {
    const docs = await os.sampleDocs(decryptRow(row), index_pattern, size);
    const fields = new Set();
    docs.forEach(doc => flattenKeys(doc, '', fields));
    res.json({ docs, fields: [...fields].sort() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Return the top-level fields of a sample document (and sub-fields of any JSON-string "message").
// Used by the Field Exclusions UI to show what fields can be stripped from raw_data.
router.get('/:id/sample-fields', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM opensearch_connections WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const index_pattern = (req.query.index_pattern || '').trim();
  if (!index_pattern) return res.status(400).json({ error: 'index_pattern required' });
  try {
    const docs = await os.sampleDocs(decryptRow(row), index_pattern, 1);
    if (!docs.length) return res.json({ fields: [] });
    const doc = docs[0];
    const topLevel = Object.keys(doc).sort();
    // If message field is a JSON string, also expose its sub-keys prefixed with "message."
    let messageSubFields = [];
    if (typeof doc.message === 'string') {
      try {
        const parsed = JSON.parse(doc.message);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          messageSubFields = Object.keys(parsed).map(k => `message.${k}`).sort();
        }
      } catch {}
    }
    res.json({ fields: [...topLevel, ...messageSubFields] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function flattenKeys(obj, prefix, result) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    result.add(prefix);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    flattenKeys(v, prefix ? `${prefix}.${k}` : k, result);
  }
}

module.exports = router;
