const BASE = '/api';

function token() {
  return localStorage.getItem('lb_token');
}

function headers(extra = {}) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...extra };
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem('lb_token');
    window.location.href = '/login';
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Auth
  login: (username, password) => req('POST', '/auth/login', { username, password }),
  changePassword: (current_password, new_password) => req('POST', '/auth/change-password', { current_password, new_password }),

  // OpenSearch connections
  getConnections: () => req('GET', '/connections'),
  createConnection: (data) => req('POST', '/connections', data),
  updateConnection: (id, data) => req('PUT', `/connections/${id}`, data),
  deleteConnection: (id) => req('DELETE', `/connections/${id}`),
  testConnection: (id) => req('POST', `/connections/${id}/test`),
  getIndices: (id) => req('GET', `/connections/${id}/indices`),
  discoverIndexes: (id, pattern) => req('GET', `/connections/${id}/discover?pattern=${encodeURIComponent(pattern || '')}`),
  getTimestamps: (id, index_pattern) => req('POST', `/connections/${id}/timestamps`, { index_pattern }),
  sampleDocs: (id, index_pattern, size = 3) => req('POST', `/connections/${id}/sample`, { index_pattern, size }),

  // ClickHouse clusters
  getClusters: () => req('GET', '/clusters'),
  createCluster: (data) => req('POST', '/clusters', data),
  updateCluster: (id, data) => req('PUT', `/clusters/${id}`, data),
  deleteCluster: (id) => req('DELETE', `/clusters/${id}`),
  testCluster: (id) => req('POST', `/clusters/${id}/test`),
  getDatabases: (id) => req('GET', `/clusters/${id}/databases`),
  getTables: (id, db) => req('GET', `/clusters/${id}/databases/${db}/tables`),
  getColumns: (id, db, table) => req('GET', `/clusters/${id}/databases/${db}/tables/${table}/columns`),

  // Pipelines
  getPipelines: (params = {}) => req('GET', '/pipelines?' + new URLSearchParams(params)),
  getPipeline: (id) => req('GET', `/pipelines/${id}`),
  createPipeline: (data) => req('POST', '/pipelines', data),
  updatePipeline: (id, data) => req('PUT', `/pipelines/${id}`, data),
  deletePipeline: (id) => req('DELETE', `/pipelines/${id}`),
  startPipeline: (id) => req('POST', `/pipelines/${id}/start`),
  pausePipeline: (id) => req('POST', `/pipelines/${id}/pause`),
  resetCursor: (id) => req('POST', `/pipelines/${id}/reset-cursor`),
  getPipelineLogs: (id, limit = 100) => req('GET', `/pipelines/${id}/logs?limit=${limit}`),
  getStats: () => req('GET', '/pipelines/stats/summary'),
  testRun: (id) => req('POST', `/pipelines/${id}/test-run`),
  runNow: (id, max_pages) => req('POST', `/pipelines/${id}/run-now`, { max_pages }),
  resetStats: (id) => req('POST', `/pipelines/${id}/reset-stats`),
  getChStats: (id) => req('GET', `/pipelines/${id}/ch-stats`),

  // Jobs
  getJobs: () => req('GET', '/jobs'),
  getJobLogs: (params = {}) => req('GET', '/jobs/logs?' + new URLSearchParams(params)),
  getPipelineJobLogs: (id, limit = 100) => req('GET', `/jobs/${id}/logs?limit=${limit}`),
  getLogHistory: (params = {}) => req('GET', '/jobs/log-history?' + new URLSearchParams(params)),

  // Pipeline partitions & reconciliation
  getPartitions: (id) => req('GET', `/pipelines/${id}/partitions`),
  resetPartitionCursor: (id, indexName) => req('DELETE', `/pipelines/${id}/partitions/${encodeURIComponent(indexName)}/cursor`),
  reconcile: (id, from, to) => req('POST', `/pipelines/${id}/reconcile`, { from, to }),

  // ClickHouse DDL
  execSql: (clusterId, sql) => req('POST', `/clusters/${clusterId}/exec`, { sql }),

  // Metrics & health (no auth required on the backend, but we pass token anyway)
  getMetrics: () => req('GET', '/metrics'),
  getDlq: (id, limit = 100) => req('GET', `/pipelines/${id}/dlq?limit=${limit}`),
  retryDlq: (id) => req('POST', `/pipelines/${id}/dlq/retry`),
  clearDlq: (id) => req('DELETE', `/pipelines/${id}/dlq`),
};
