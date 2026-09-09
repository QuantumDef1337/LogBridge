const fetch = require('node-fetch');

function authHeader(cluster) {
  return 'Basic ' + Buffer.from(`${cluster.username}:${cluster.password}`).toString('base64');
}

function buildUrl(cluster, query, extra = '') {
  return `${cluster.url}/?query=${encodeURIComponent(query)}${extra}`;
}

async function query(cluster, sql) {
  const res = await fetch(buildUrl(cluster, sql + ' FORMAT JSON'), {
    headers: { Authorization: authHeader(cluster) },
    timeout: 15000,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickHouse error ${res.status}: ${text}`);
  }
  return await res.json();
}

async function exec(cluster, sql) {
  // For DDL / statements that return no result set (CREATE, ALTER, etc.)
  const res = await fetch(`${cluster.url}/`, {
    method: 'POST',
    headers: { Authorization: authHeader(cluster), 'Content-Type': 'text/plain' },
    body: sql,
    timeout: 30000,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickHouse error ${res.status}: ${text}`);
  }
  return await res.text();
}

async function testConnection(cluster) {
  return await query(cluster, 'SELECT 1 as ok');
}

async function listDatabases(cluster) {
  const res = await query(cluster, 'SHOW DATABASES');
  return (res.data || []).map(r => r.name);
}

async function listTables(cluster, database) {
  const res = await query(cluster, `SHOW TABLES FROM \`${database}\``);
  return (res.data || []).map(r => r.name);
}

async function listColumns(cluster, database, table) {
  const res = await query(
    cluster,
    `SELECT name, type, default_expression FROM system.columns WHERE database = '${database}' AND table = '${table}' ORDER BY position`
  );
  return res.data || [];
}

async function insertRows(cluster, database, table, ndjson) {
  const sql = `INSERT INTO \`${database}\`.\`${table}\` FORMAT JSONEachRow`;
  const url = `${cluster.url}/?query=${encodeURIComponent(sql)}&input_format_skip_unknown_fields=1&date_time_input_format=best_effort`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(cluster),
      'Content-Type': 'application/x-ndjson',
    },
    body: ndjson,
    timeout: 120000,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickHouse insert error ${res.status}: ${text}`);
  }
  return true;
}

async function countRows(cluster, database, table, whereClause = '') {
  const sql = `SELECT count() AS c FROM \`${database}\`.\`${table}\`${whereClause ? ' WHERE ' + whereClause : ''}`;
  const res = await query(cluster, sql);
  return Number(res.data?.[0]?.c ?? 0);
}

// Check which event_ids from a batch already exist in ClickHouse (for dedup).
// Returns [] if the column doesn't exist or the query fails — caller falls through.
async function getExistingEventIds(cluster, database, table, eventIds) {
  if (!eventIds || eventIds.length === 0) return [];
  // Escape single-quotes to prevent injection from event_id values
  const inList = eventIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
  try {
    const res = await query(cluster, `SELECT event_id FROM \`${database}\`.\`${table}\` WHERE event_id IN (${inList})`);
    return (res.data || []).map(r => r.event_id);
  } catch {
    return []; // column absent or table error — skip dedup silently
  }
}

module.exports = { testConnection, listDatabases, listTables, listColumns, insertRows, query, exec, countRows, getExistingEventIds };
