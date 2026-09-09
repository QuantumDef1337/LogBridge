'use strict';

const router = require('express').Router();
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const ch = require('../services/clickhouse');
const { encrypt, decryptRow } = require('../crypto');
const audit = require('../audit');

router.use(requireAuth);

// Password is NEVER returned in list/get responses
const PUBLIC_COLS = 'id,name,url,username,default_database,created_at,updated_at';

router.get('/', (req, res) => {
  const rows = getDb().prepare(
    `SELECT ${PUBLIC_COLS} FROM clickhouse_clusters ORDER BY name`
  ).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = getDb().prepare(
    `SELECT ${PUBLIC_COLS} FROM clickhouse_clusters WHERE id=?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req, res) => {
  const { name, url, username, password, default_database } = req.body;
  if (!name || !url || !username || !password)
    return res.status(400).json({ error: 'name, url, username, password required' });
  const r = getDb().prepare(
    'INSERT INTO clickhouse_clusters (name,url,username,password,default_database) VALUES (?,?,?,?,?)'
  ).run(name, url.replace(/\/$/, ''), username, encrypt(password), default_database || 'default');
  audit.info('cluster', `ClickHouse cluster created: "${name}" (${url})`);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { name, url, username, password, default_database } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM clickhouse_clusters WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const storedPassword = password ? encrypt(password) : existing.password;

  db.prepare(
    "UPDATE clickhouse_clusters SET name=?,url=?,username=?,password=?,default_database=?,updated_at=datetime('now') WHERE id=?"
  ).run(
    name || existing.name,
    url ? url.replace(/\/$/, '') : existing.url,
    username || existing.username,
    storedPassword,
    default_database || existing.default_database,
    req.params.id
  );
  audit.info('cluster', `ClickHouse cluster updated: "${name || existing.name}" (${req.params.id})`);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const row = getDb().prepare('SELECT name FROM clickhouse_clusters WHERE id=?').get(req.params.id);
  getDb().prepare('DELETE FROM clickhouse_clusters WHERE id=?').run(req.params.id);
  audit.warn('cluster', `ClickHouse cluster deleted: "${row?.name || req.params.id}"`);
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM clickhouse_clusters WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    await ch.testConnection(decryptRow(row));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/:id/databases', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM clickhouse_clusters WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    res.json(await ch.listDatabases(decryptRow(row)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/databases/:db/tables', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM clickhouse_clusters WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    res.json(await ch.listTables(decryptRow(row), req.params.db));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/databases/:db/tables/:table/columns', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM clickhouse_clusters WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    res.json(await ch.listColumns(decryptRow(row), req.params.db, req.params.table));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/exec', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM clickhouse_clusters WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const sql = (req.body?.sql || '').trim();
  if (!sql) return res.status(400).json({ error: 'sql required' });
  const allowed = /^(CREATE|ALTER|DROP TABLE|RENAME|TRUNCATE)\b/i.test(sql);
  if (!allowed)
    return res.status(400).json({ error: 'Only CREATE/ALTER/RENAME/TRUNCATE/DROP TABLE statements are allowed here' });
  try {
    const out = await ch.exec(decryptRow(row), sql);
    res.json({ ok: true, output: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
