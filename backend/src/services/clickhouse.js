const fetch = require('node-fetch');

function authHeaders(cluster) {
  if (!cluster.password) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${cluster.username}:${cluster.password}`).toString('base64') };
}

function buildUrl(cluster, query, extra = '') {
  return `${cluster.url}/?query=${encodeURIComponent(query)}${extra}`;
}

async function query(cluster, sql) {
  const res = await fetch(buildUrl(cluster, sql + ' FORMAT JSON'), {
    headers: { ...authHeaders(cluster) },
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
    headers: { ...authHeaders(cluster), 'Content-Type': 'text/plain' },
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
      ...authHeaders(cluster),
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

// Range-scoped stats for reconciliation: exact row count plus oldest/newest value of
// the timestamp column, all in one query. whereClause is already-built SQL (may be '').
async function getRangeStats(cluster, database, table, whereClause = '', tsCol = 'timestamp') {
  const where = whereClause ? ' WHERE ' + whereClause : '';
  const sql = `SELECT count() AS c, min(\`${tsCol}\`) AS oldest, max(\`${tsCol}\`) AS newest FROM \`${database}\`.\`${table}\`${where}`;
  const res = await query(cluster, sql);
  const row = res.data?.[0] || {};
  const count = Number(row.c ?? 0);
  // min/max on an empty set return the DateTime epoch — null those out.
  const clean = (v) => (count > 0 && v && !String(v).startsWith('1970-01-01')) ? v : null;
  return { count, oldest_ts: clean(row.oldest), newest_ts: clean(row.newest) };
}

// Check which event_ids from a batch already exist in ClickHouse (for dedup).
// Returns [] if the query fails for a transient reason (network blip, etc.) — caller
// falls through and inserts anyway rather than blocking ingestion.
//
// If the target table has no `event_id` column, ClickHouse raises UNKNOWN_IDENTIFIER
// (code 47) — that specific failure is NOT swallowed here. It is re-thrown as a tagged
// error so the caller can log it loudly: silently returning [] in that case would look
// identical to "no duplicates found" and let duplicate rows accumulate forever with no
// visible warning (this is exactly what happened with the Fortigate table).
async function getExistingEventIds(cluster, database, table, eventIds) {
  if (!eventIds || eventIds.length === 0) return [];
  // Escape single-quotes to prevent injection from event_id values
  const inList = eventIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
  const sql = `SELECT event_id FROM \`${database}\`.\`${table}\` WHERE event_id IN (${inList})`;
  // Retry up to 3 times on transient errors (429, timeout, network blip) before
  // falling back to "insert anyway". Without retries a 429 storm silently disables
  // dedup for the entire batch, letting duplicate rows accumulate.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await query(cluster, sql);
      return (res.data || []).map(r => r.event_id);
    } catch (e) {
      if (/UNKNOWN_IDENTIFIER|Code:\s*47\b/.test(e.message) && /event_id/.test(e.message)) {
        const err = new Error(`Target table \`${database}\`.\`${table}\` has no 'event_id' column — deduplication is DISABLED for this pipeline. Duplicate rows will accumulate on every overlapping run.`);
        err.dedupUnsupported = true;
        throw err;
      }
      lastErr = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  // All retries exhausted — log and fall through (insert without dedup check) so
  // ingestion is not blocked, but the caller will see this in the warn log.
  const fallbackErr = new Error(`dedup check failed after 3 attempts (${lastErr?.message?.slice(0, 80)}) — inserting without dedup`);
  fallbackErr.dedupFallback = true;
  throw fallbackErr;
}

module.exports = { testConnection, listDatabases, listTables, listColumns, insertRows, query, exec, countRows, getRangeStats, getExistingEventIds };
