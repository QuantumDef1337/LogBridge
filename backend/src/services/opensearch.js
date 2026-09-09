const fetch = require('node-fetch');
const https = require('https');

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function makeAgent(conn) {
  if (conn.url.startsWith('https') && !conn.tls_verify) return insecureAgent;
  return undefined;
}

function authHeader(conn) {
  return 'Basic ' + Buffer.from(`${conn.username}:${conn.password}`).toString('base64');
}

async function testConnection(conn) {
  const res = await fetch(`${conn.url}/`, {
    headers: { Authorization: authHeader(conn) },
    agent: makeAgent(conn),
    timeout: 8000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function listIndices(conn) {
  const res = await fetch(`${conn.url}/_cat/indices?h=index,docs.count,store.size,creation.date.string&format=json&s=index`, {
    headers: { Authorization: authHeader(conn) },
    agent: makeAgent(conn),
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function getIndexTimestamps(conn, indexPattern) {
  // Get oldest timestamp
  const oldestRes = await fetch(`${conn.url}/${indexPattern}/_search`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 15000,
    body: JSON.stringify({
      size: 1,
      sort: [{ '@timestamp': 'asc' }],
      _source: ['@timestamp'],
    }),
  });

  // Get newest timestamp
  const newestRes = await fetch(`${conn.url}/${indexPattern}/_search`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 15000,
    body: JSON.stringify({
      size: 1,
      sort: [{ '@timestamp': 'desc' }],
      _source: ['@timestamp'],
    }),
  });

  // Get doc count
  const countRes = await fetch(`${conn.url}/${indexPattern}/_count`, {
    headers: { Authorization: authHeader(conn) },
    agent: makeAgent(conn),
    timeout: 10000,
  });

  const oldest = await oldestRes.json();
  const newest = await newestRes.json();
  const count = await countRes.json();

  return {
    oldest_ts: oldest.hits?.hits?.[0]?._source?.['@timestamp'] || null,
    newest_ts: newest.hits?.hits?.[0]?._source?.['@timestamp'] || null,
    doc_count: count.count || 0,
  };
}

async function sampleDocs(conn, indexPattern, size = 5) {
  const res = await fetch(`${conn.url}/${indexPattern}/_search`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 15000,
    body: JSON.stringify({
      size,
      sort: [{ '@timestamp': 'desc' }],
      query: { match_all: {} },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body.hits?.hits || []).map(h => h._source);
}

async function fetchPage(conn, indexPattern, batchSize, cursorTs, cursorId, range = {}) {
  // Build the @timestamp range filter from optional from/to plus the cursor.
  const tsRange = {};
  if (range.gte) tsRange.gte = range.gte;
  if (range.lte) tsRange.lte = range.lte;
  if (cursorTs) tsRange.gt = cursorTs; // cursor always wins as the lower bound

  const filters = [];
  if (Object.keys(tsRange).length > 0) {
    filters.push({ range: { '@timestamp': tsRange } });
  }

  const query = {
    size: batchSize,
    sort: [{ '@timestamp': 'asc' }, { _id: 'asc' }],
    query: filters.length ? { bool: { filter: filters } } : { match_all: {} },
  };

  if (cursorTs && cursorId) {
    query.search_after = [cursorTs, cursorId];
  }

  const res = await fetch(`${conn.url}/${indexPattern}/_search`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 60000,
    body: JSON.stringify(query),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSearch error ${res.status}: ${text}`);
  }

  const body = await res.json();
  const hits = body.hits?.hits || [];

  if (hits.length === 0) return { docs: [], nextCursor: null };

  const last = hits[hits.length - 1];
  const nextCursor = {
    ts: last._source?.['@timestamp'] || last.sort?.[0],
    id: last._id,
    index: last._index,
  };

  return { docs: hits.map(h => ({ ...h._source, _id: h._id, _index: h._index })), nextCursor };
}

// ── PIT (Point-In-Time) lifecycle ────────────────────────────────────────────

const PIT_KEEP_ALIVE = '5m';

/**
 * Open a PIT on the given index pattern.
 * Returns { pitId } or throws.
 */
async function openPit(conn, indexPattern) {
  const res = await fetch(`${conn.url}/${indexPattern}/_search/point_in_time?keep_alive=${PIT_KEEP_ALIVE}`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 15000,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PIT open failed HTTP ${res.status}: ${txt}`);
  }
  const body = await res.json();
  const pitId = body.id || body.pit_id;
  if (!pitId) throw new Error('PIT open: no id in response');
  return { pitId };
}

/**
 * Delete a PIT to release resources. Swallows errors (best-effort cleanup).
 */
async function closePit(conn, pitId) {
  if (!pitId) return;
  try {
    await fetch(`${conn.url}/_search/point_in_time`, {
      method: 'DELETE',
      headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
      agent: makeAgent(conn),
      timeout: 10000,
      body: JSON.stringify({ id: pitId }),
    });
  } catch {}
}

/**
 * Fetch one page using a PIT + search_after.
 * `pitId` MUST be in the request; OpenSearch may return a new pit.id — always use the returned one.
 * Returns { docs, nextCursor, pitId } where pitId is the (possibly refreshed) PIT id.
 *
 * Throws with .pitExpired = true when the PIT has expired (404 / no_search_context).
 * The caller should recreate the PIT and resume from the last durable checkpoint.
 */
async function fetchPageWithPit(conn, pitId, batchSize, cursorTs, cursorId, range = {}) {
  const tsRange = {};
  if (range.gte) tsRange.gte = range.gte;
  if (range.lte) tsRange.lte = range.lte;
  if (cursorTs) tsRange.gt = cursorTs;

  const filters = [];
  if (Object.keys(tsRange).length > 0) {
    filters.push({ range: { '@timestamp': tsRange } });
  }

  const query = {
    size: batchSize,
    // When using PIT, omit the index from the URL — use pit.id instead.
    pit: { id: pitId, keep_alive: PIT_KEEP_ALIVE },
    sort: [{ '@timestamp': 'asc' }, { _id: 'asc' }],
    query: filters.length ? { bool: { filter: filters } } : { match_all: {} },
    // track_total_hits: false speeds up every page after the first
    track_total_hits: false,
  };

  if (cursorTs && cursorId) {
    query.search_after = [cursorTs, cursorId];
  }

  const res = await fetch(`${conn.url}/_search`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 60000,
    body: JSON.stringify(query),
  });

  if (!res.ok) {
    const text = await res.text();
    // Circuit breaker: OS JVM heap exhausted — non-retryable, surface actionable message
    if (text.includes('circuit_breaking_exception') || text.includes('data too large')) {
      throw new Error(
        `OpenSearch heap pressure (circuit_breaking_exception): the OS node ran out of JVM heap during search. ` +
        `Reduce batch_size, or increase the OpenSearch node's heap (indices.breaker.total.limit). ` +
        `Raw: ${text.slice(0, 300)}`
      );
    }
    const err = new Error(`OpenSearch PIT search error ${res.status}: ${text}`);
    // 404 with search_context_missing = PIT expired; signal caller to recreate
    if (res.status === 404 || text.includes('search_context_missing') || text.includes('No search context found')) {
      err.pitExpired = true;
    }
    throw err;
  }

  const body = await res.json();

  // OpenSearch returns a refreshed PIT id — always use it for the next call
  const newPitId = body.pit_id || pitId;

  const hits = body.hits?.hits || [];
  if (hits.length === 0) return { docs: [], nextCursor: null, pitId: newPitId };

  const last = hits[hits.length - 1];
  const nextCursor = {
    ts: last._source?.['@timestamp'] || last.sort?.[0],
    id: last._id,
    index: last._index,
  };

  return {
    docs: hits.map(h => ({ ...h._source, _id: h._id, _index: h._index })),
    nextCursor,
    pitId: newPitId,
  };
}

async function getIndexCount(conn, indexPattern, range = {}) {
  const filters = [];
  const tsRange = {};
  if (range.gte) tsRange.gte = range.gte;
  if (range.lte) tsRange.lte = range.lte;
  if (Object.keys(tsRange).length > 0) filters.push({ range: { '@timestamp': tsRange } });

  const body = filters.length ? { query: { bool: { filter: filters } } } : {};
  const res = await fetch(`${conn.url}/${indexPattern}/_count`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 15000,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`_count HTTP ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data.count || 0;
}

/**
 * Resolve a wildcard index pattern to a list of matching physical index names.
 * Uses _cat/indices and filters client-side (avoids _resolve API compat issues).
 */
async function discoverIndexes(conn, pattern) {
  const indices = await listIndices(conn);
  if (!pattern || pattern === '*') return indices;
  // Convert glob-style pattern to RegExp (support * and ?)
  const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  const re = new RegExp(regexStr, 'i');
  return indices.filter(i => re.test(i.index));
}

module.exports = { testConnection, listIndices, getIndexTimestamps, sampleDocs, fetchPage, openPit, closePit, fetchPageWithPit, getIndexCount, discoverIndexes };
