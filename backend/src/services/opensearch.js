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

async function getIndexTimestamps(conn, indexPattern, tsField = '@timestamp') {
  // Get oldest timestamp
  const oldestRes = await fetch(`${conn.url}/${indexPattern}/_search`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 15000,
    body: JSON.stringify({
      size: 1,
      sort: [{ [tsField]: 'asc' }],
      _source: [tsField],
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
      sort: [{ [tsField]: 'desc' }],
      _source: [tsField],
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
    oldest_ts: oldest.hits?.hits?.[0]?._source?.[tsField] || null,
    newest_ts: newest.hits?.hits?.[0]?._source?.[tsField] || null,
    doc_count: count.count || 0,
  };
}

async function sampleDocs(conn, indexPattern, size = 5, tsField = '@timestamp') {
  // Try with sort first; if OpenSearch rejects (e.g. @timestamp not mapped), fall back to unsorted.
  for (const body of [
    { size, sort: [{ [tsField]: 'desc' }], query: { match_all: {} } },
    { size, query: { match_all: {} } },
  ]) {
    const res = await fetch(`${conn.url}/${indexPattern}/_search`, {
      method: 'POST',
      headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
      agent: makeAgent(conn),
      timeout: 15000,
      body: JSON.stringify(body),
    });
    if (res.status === 400) continue; // sort field not mapped — retry without sort
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.hits?.hits || []).map(h => h._source);
  }
  throw new Error('HTTP 400');
}

async function fetchPage(conn, indexPattern, batchSize, cursorTs, cursorId, range = {}, tsField = '@timestamp') {
  const tsRange = {};
  if (range.gte) tsRange.gte = range.gte;
  if (range.lte) tsRange.lte = range.lte;
  if (range.lt)  tsRange.lt  = range.lt;   // exclusive upper bound for non-overlapping chunks
  if (cursorTs) tsRange.gt = cursorTs;

  const filters = [];
  if (Object.keys(tsRange).length > 0) {
    filters.push({ range: { [tsField]: { ...tsRange, format: 'strict_date_optional_time||yyyy-MM-dd HH:mm:ss.SSS||yyyy-MM-dd' } } });
  }

  const query = {
    size: batchSize,
    sort: [{ [tsField]: 'asc' }, { _id: 'asc' }],
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
    ts: last._source?.[tsField] || last.sort?.[0],
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
async function fetchPageWithPit(conn, pitId, batchSize, cursorTs, cursorId, range = {}, tsField = '@timestamp') {
  const tsRange = {};
  if (range.gte) tsRange.gte = range.gte;
  if (range.lte) tsRange.lte = range.lte;
  if (range.lt)  tsRange.lt  = range.lt;   // exclusive upper bound for non-overlapping chunks
  if (cursorTs) tsRange.gt = cursorTs;

  const filters = [];
  if (Object.keys(tsRange).length > 0) {
    filters.push({ range: { [tsField]: { ...tsRange, format: 'strict_date_optional_time||yyyy-MM-dd HH:mm:ss.SSS||yyyy-MM-dd' } } });
  }

  const query = {
    size: batchSize,
    // When using PIT, omit the index from the URL — use pit.id instead.
    pit: { id: pitId, keep_alive: PIT_KEEP_ALIVE },
    sort: [{ [tsField]: 'asc' }, { _id: 'asc' }],
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
    ts: last._source?.[tsField] || last.sort?.[0],
    id: last._id,
    index: last._index,
  };

  return {
    docs: hits.map(h => ({ ...h._source, _id: h._id, _index: h._index })),
    nextCursor,
    pitId: newPitId,
  };
}

async function getIndexCount(conn, indexPattern, range = {}, tsField = '@timestamp') {
  const filters = [];
  const tsRange = {};
  if (range.gte) tsRange.gte = range.gte;
  if (range.lte) tsRange.lte = range.lte;
  if (Object.keys(tsRange).length > 0) filters.push({ range: { [tsField]: { ...tsRange, format: 'strict_date_optional_time||yyyy-MM-dd HH:mm:ss.SSS||yyyy-MM-dd' } } });

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
 * Range-scoped stats for reconciliation: exact document count plus the oldest and
 * newest timestamp within [range.gte, range.lte]. One _search with size:0 does all
 * three (track_total_hits gives an exact count instead of the 10k cap; min/max aggs
 * give the bounds). Pass an empty range to cover the whole index.
 */
async function getRangeStats(conn, indexPattern, range = {}, tsField = '@timestamp') {
  const tsRange = {};
  if (range.gte) tsRange.gte = range.gte;
  if (range.lte) tsRange.lte = range.lte;
  if (range.lt)  tsRange.lt  = range.lt;   // exclusive upper bound (matches ingestion window)
  const filter = Object.keys(tsRange).length
    ? [{ range: { [tsField]: { ...tsRange, format: 'strict_date_optional_time||yyyy-MM-dd HH:mm:ss.SSS||yyyy-MM-dd' } } }]
    : [];
  const body = {
    size: 0,
    track_total_hits: true,
    query: filter.length ? { bool: { filter } } : { match_all: {} },
    aggs: { min_ts: { min: { field: tsField } }, max_ts: { max: { field: tsField } } },
  };
  const res = await fetch(`${conn.url}/${indexPattern}/_search`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 15000,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`_search stats HTTP ${res.status}: ${text}`);
  }
  const d = await res.json();
  const total = typeof d.hits?.total === 'object' ? d.hits.total.value : d.hits?.total;
  return {
    count: total || 0,
    oldest_ts: d.aggregations?.min_ts?.value_as_string || null,
    newest_ts: d.aggregations?.max_ts?.value_as_string || null,
  };
}

/**
 * Per-physical-index time bounds for index-aware chunk routing.
 * One aggregation search (size:0, terms on _index with min/max sub-aggs) returns the
 * actual oldest/newest timestamp of every physical index matching the pattern — derived
 * from the DATA, so it works for any layout (daily-rotated, non-daily, single, multi)
 * without parsing index names. This is a transient search: it does NOT hold a scroll/PIT
 * context, so it doesn't count against the open-context limit.
 *
 * Returns [{ index, min, max }] with min/max as epoch millis; indices with no timestamped
 * docs are omitted.
 */
async function getPerIndexTimeBounds(conn, indexPattern, tsField = '@timestamp') {
  const body = {
    size: 0,
    aggs: {
      by_index: {
        terms: { field: '_index', size: 10000 },
        aggs: {
          min_ts: { min: { field: tsField } },
          max_ts: { max: { field: tsField } },
        },
      },
    },
  };
  const res = await fetch(`${conn.url}/${indexPattern}/_search`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 30000,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`per-index bounds _search HTTP ${res.status}: ${text}`);
  }
  const d = await res.json();
  const buckets = d.aggregations?.by_index?.buckets || [];
  return buckets
    .map(b => ({ index: b.key, min: b.min_ts?.value ?? null, max: b.max_ts?.value ?? null }))
    .filter(b => b.min != null && b.max != null);
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

/**
 * Sliced scroll worker for a fixed time window.
 * Fetches all documents belonging to this slice (id / max) within [range.gte, range.lte].
 * Calls onPage(docs) for each page; docs include _id and _index injected from hit metadata.
 * Cleans up the scroll context on finish or error.
 */
async function fetchSlicedWindow(conn, indexPattern, sliceId, sliceMax, batchSize, range = {}, tsField = '@timestamp', onPage) {
  const tsRange = {};
  if (range.gte) tsRange.gte = range.gte;
  if (range.lte) tsRange.lte = range.lte;
  if (range.lt)  tsRange.lt  = range.lt;   // exclusive upper bound for time-window partitioning

  const query = {
    size: Math.min(batchSize, 10000),
    query: Object.keys(tsRange).length > 0
      ? { bool: { filter: [{ range: { [tsField]: { ...tsRange, format: 'strict_date_optional_time' } } }] } }
      : { match_all: {} },
  };

  // Only add slice block when using multiple workers — a max=1 slice is a no-op but some
  // versions of OpenSearch reject it, so skip it entirely for the single-worker case.
  if (sliceMax > 1) {
    query.slice = { id: sliceId, max: sliceMax };
  }

  const initRes = await fetch(`${conn.url}/${indexPattern}/_search?scroll=2m`, {
    method: 'POST',
    headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
    agent: makeAgent(conn),
    timeout: 60000,
    body: JSON.stringify(query),
  });

  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`Sliced scroll init (slice ${sliceId}/${sliceMax}) HTTP ${initRes.status}: ${text}`);
  }

  let data = await initRes.json();
  let scrollId = data._scroll_id;

  // A partial/failed scroll response (circuit breaker, cancelled search task, node
  // timeout) can come back as HTTP 200 with timed_out=true or _shards.failed>0 and
  // fewer/empty hits — which is indistinguishable from a genuine end-of-data unless
  // we inspect these flags. Treating it as "done" would silently drop documents and
  // let the caller advance its cursor past data that was never read. So we throw
  // instead: the run fails loudly and the cursor is left untouched.
  const assertHealthy = (resp, where) => {
    if (resp.timed_out) {
      throw new Error(`Sliced scroll ${where} (slice ${sliceId}/${sliceMax}) timed_out on the OpenSearch side — partial result, aborting to avoid data loss`);
    }
    const sh = resp._shards || {};
    if ((sh.failed || 0) > 0) {
      const reason = sh.failures?.[0]?.reason?.reason || sh.failures?.[0]?.reason?.type || 'unknown';
      throw new Error(`Sliced scroll ${where} (slice ${sliceId}/${sliceMax}) had ${sh.failed}/${sh.total} shard failure(s): ${reason} — partial result, aborting to avoid data loss`);
    }
  };

  // Total documents OpenSearch says match this window — used to verify we read them all.
  const expectedTotal = typeof data.hits?.total === 'object' ? data.hits.total.value : (data.hits?.total ?? null);
  let seen = 0;

  try {
    assertHealthy(data, 'init');
    while (true) {
      const hits = data.hits?.hits || [];
      if (hits.length === 0) break;
      seen += hits.length;
      await onPage(hits.map(h => ({ ...h._source, _id: h._id, _index: h._index })));

      const scrollRes = await fetch(`${conn.url}/_search/scroll`, {
        method: 'POST',
        headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
        agent: makeAgent(conn),
        timeout: 60000,
        body: JSON.stringify({ scroll: '2m', scroll_id: scrollId }),
      });
      if (!scrollRes.ok) {
        const text = await scrollRes.text();
        throw new Error(`Sliced scroll page (slice ${sliceId}/${sliceMax}) HTTP ${scrollRes.status}: ${text}`);
      }
      data = await scrollRes.json();
      assertHealthy(data, 'page');
      scrollId = data._scroll_id || scrollId;
    }

    // Final completeness check: if OpenSearch reported N matches but we scrolled fewer,
    // something dropped documents mid-scroll without raising an error. Fail loudly.
    if (expectedTotal != null && seen < expectedTotal) {
      throw new Error(`Sliced scroll (slice ${sliceId}/${sliceMax}) incomplete: read ${seen} of ${expectedTotal} matching docs — aborting to avoid data loss`);
    }
  } finally {
    if (scrollId) {
      fetch(`${conn.url}/_search/scroll`, {
        method: 'DELETE',
        headers: { Authorization: authHeader(conn), 'Content-Type': 'application/json' },
        agent: makeAgent(conn),
        timeout: 10000,
        body: JSON.stringify({ scroll_id: scrollId }),
      }).catch(() => {});
    }
  }
}

module.exports = { testConnection, listIndices, getIndexTimestamps, sampleDocs, fetchPage, openPit, closePit, fetchPageWithPit, getIndexCount, getRangeStats, getPerIndexTimeBounds, discoverIndexes, fetchSlicedWindow };
