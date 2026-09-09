import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Activity, CheckCircle2, XCircle, Clock, AlertTriangle, RefreshCw,
  ChevronDown, ChevronUp, RotateCcw, Trash2, CheckCircle, GitCompare, Copy, Check, Eraser,
} from 'lucide-react';
import { api } from '../api';
import { fmtTs, fmtRelative, getTzPref, setTzPref } from '../utils/time';

function fmtNum(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function TzToggle({ pref, onChange }) {
  return (
    <div className="flex items-center gap-1 bg-slate-800 border border-slate-700 rounded-lg p-0.5">
      {['local', 'utc'].map(v => (
        <button key={v} onClick={() => onChange(v)}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${pref === v ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'}`}>
          {v === 'utc' ? 'UTC' : 'Local'}
        </button>
      ))}
    </div>
  );
}

function StatusDot({ status }) {
  const map = { running: 'bg-blue-400 animate-pulse', active: 'bg-green-500', error: 'bg-red-500', paused: 'bg-slate-600' };
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${map[status] || 'bg-slate-600'}`} />;
}

function StatusLabel({ status }) {
  const map = { running: 'text-blue-400', active: 'text-green-400', error: 'text-red-400', paused: 'text-slate-500' };
  return <span className={`text-xs font-medium capitalize ${map[status] || 'text-slate-400'}`}>{status}</span>;
}

// Detect the category embedded in audit log messages like "[pipeline] ..."
function parseLogEntry(entry) {
  const match = entry.message?.match(/^\[(\w+)\]\s*/);
  return {
    category: match ? match[1] : null,
    body: match ? entry.message.slice(match[0].length) : entry.message,
  };
}

const CATEGORY_COLORS = {
  pipeline:   { text: 'text-brand-400',   bg: 'bg-brand-950/30' },
  connection: { text: 'text-cyan-400',    bg: 'bg-cyan-950/30' },
  cluster:    { text: 'text-purple-400',  bg: 'bg-purple-950/30' },
  system:     { text: 'text-slate-400',   bg: '' },
};
const LEVEL_COLORS = {
  error: 'text-red-400',
  warn:  'text-amber-400',
  info:  'text-slate-300',
};

// Parse "Batch inserted: N rows (fetched M, skipped K dedup) | from:ISO to:ISO | index:name"
function parseBatchInsert(body) {
  const m = body.match(/Batch inserted:\s*([\d,]+)\s*rows\s*\(fetched\s*([\d,]+),\s*skipped\s*([\d,]+)\s*dedup\)/i);
  if (!m) return null;
  const fromM  = body.match(/from:(\S+)/);
  const toM    = body.match(/to:(\S+)/);
  const indexM = body.match(/index:(\S+)/);
  return {
    inserted: parseInt(m[1].replace(/,/g, '')),
    fetched:  parseInt(m[2].replace(/,/g, '')),
    skipped:  parseInt(m[3].replace(/,/g, '')),
    fromTs:   fromM  ? fromM[1]  : null,
    toTs:     toM    ? toM[1]    : null,
    index:    indexM ? indexM[1] : null,
  };
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button onClick={copy} title="Copy log line"
      className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-600 hover:text-slate-300 flex-shrink-0 ml-1">
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  );
}

function LogLine({ entry, tz, jobsMap }) {
  const { category, body } = parseLogEntry(entry);
  const isSystem = !entry.pipeline_id || entry.pipeline_name === '[system]';
  const cat = CATEGORY_COLORS[category] || {};
  const job = jobsMap && entry.pipeline_id != null ? jobsMap.get(Number(entry.pipeline_id)) : null;
  const batchInfo = body ? parseBatchInsert(body) : null;

  const copyText = [
    fmtTs(entry.created_at, tz),
    entry.pipeline_name,
    category ? `[${category}]` : '',
    entry.level,
    body,
  ].filter(Boolean).join('  ');

  return (
    <div className={`group py-1.5 border-b border-slate-800/40 hover:bg-slate-800/20 ${isSystem ? 'opacity-80' : ''}`}>
      {/* Main line */}
      <div className="flex items-start gap-2 text-xs font-mono">
        <span className="text-slate-600 w-44 flex-shrink-0 shrink-0">{fmtTs(entry.created_at, tz)}</span>
        <span className={`w-24 flex-shrink-0 truncate font-semibold ${isSystem ? 'text-slate-500' : 'text-brand-400'}`}>
          {entry.pipeline_name}
        </span>
        {category && (
          <span className={`w-20 flex-shrink-0 text-xs px-1 rounded ${cat.text || 'text-slate-500'}`}>[{category}]</span>
        )}
        <span className={`w-10 flex-shrink-0 ${LEVEL_COLORS[entry.level] || 'text-slate-400'}`}>{entry.level}</span>
        <span className={`flex-1 break-words ${LEVEL_COLORS[entry.level] || 'text-slate-400'}`}>{body}</span>
        <CopyButton text={copyText} />
      </div>
      {/* Enriched detail row for batch-insert events */}
      {batchInfo && job && (
        <div className="ml-[13.5rem] mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono">
          {batchInfo.index && (
            <span className="text-slate-500">from <span className="text-yellow-400/90 font-medium">{batchInfo.index}</span></span>
          )}
          <span className="text-emerald-500">→ {job.clickhouse_database}.{job.clickhouse_table}</span>
          <span className="text-slate-500">inserted <span className="text-slate-300">{batchInfo.inserted.toLocaleString()}</span></span>
          {batchInfo.skipped > 0 && <span className="text-amber-500/80">dedup-skipped {batchInfo.skipped.toLocaleString()}</span>}
          {batchInfo.fromTs && (
            <span className="text-slate-600">from <span className="text-blue-300/80">{fmtTs(batchInfo.fromTs, tz)}</span></span>
          )}
          {batchInfo.toTs && (
            <span className="text-slate-600">to <span className="text-blue-300/80">{fmtTs(batchInfo.toTs, tz)}</span></span>
          )}
        </div>
      )}
    </div>
  );
}

function CopyAllButton({ logs, tz }) {
  const [copied, setCopied] = useState(false);
  function copyAll() {
    const lines = logs.map(entry => {
      const { category, body } = parseLogEntry(entry);
      return [fmtTs(entry.created_at, tz), entry.pipeline_name, category ? `[${category}]` : '', entry.level, body]
        .filter(Boolean).join('  ');
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button onClick={copyAll} title="Copy all log lines"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors">
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      {copied ? 'Copied!' : 'Copy all'}
    </button>
  );
}

export default function Jobs() {
  const [jobs, setJobs]           = useState([]);
  const [logs, setLogs]           = useState([]);
  const [logFilter, setLogFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [autoScroll, setAutoScroll]   = useState(true);
  const [expanded, setExpanded]       = useState({});
  const [pipelineLogs, setPipelineLogs] = useState({});
  const [tz, setTzState]              = useState(getTzPref);
  const [resetting, setResetting]     = useState({});
  const [pipelineRecon, setPipelineRecon] = useState({}); // id → { result, checkedAt, loading }
  const logRef = useRef(null);
  const latestLogId = useRef(0);
  const clearedAt = useRef(null); // ISO string — hide logs created before this
  const [hasNew, setHasNew] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const oldestLogId = useRef(null);

  function changeTz(v) { setTzPref(v); setTzState(v); }

  const loadJobs = useCallback(async () => {
    try { setJobs(await api.getJobs()); } catch {}
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const params = { limit: 500 };
      if (levelFilter) params.level = levelFilter;
      if (logFilter) params.pipeline_id = logFilter;
      const rows = await api.getJobLogs(params);
      if (rows.length > 0) {
        const newest = rows[rows.length - 1].id;
        if (latestLogId.current > 0 && newest > latestLogId.current) setHasNew(true);
        latestLogId.current = Math.max(latestLogId.current, newest);
        if (oldestLogId.current === null) oldestLogId.current = rows[0].id;
      }
      setLogs(rows);
      setHasOlder(rows.length >= 500);
    } catch {}
  }, [levelFilter, logFilter]);

  async function loadOlderLogs() {
    if (!oldestLogId.current || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const params = { limit: 500, before_id: oldestLogId.current };
      if (levelFilter) params.level = levelFilter;
      if (logFilter) params.pipeline_id = logFilter;
      const older = await api.getJobLogs(params);
      if (older.length > 0) {
        oldestLogId.current = older[0].id;
        setLogs(prev => [...older, ...prev]);
        setHasOlder(older.length >= 500);
      } else {
        setHasOlder(false);
      }
    } catch {} finally { setLoadingOlder(false); }
  }

  useEffect(() => {
    loadJobs();
    loadLogs();
    const t1 = setInterval(loadJobs, 2000);
    const t2 = setInterval(loadLogs, 1500); // faster — nearly real-time
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [loadJobs, loadLogs]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
      setHasNew(false);
    }
  }, [logs, autoScroll]);

  async function runReconcile(id) {
    setPipelineRecon(s => ({ ...s, [id]: { ...s[id], loading: true } }));
    try {
      const result = await api.reconcile(id);
      setPipelineRecon(s => ({ ...s, [id]: { result, checkedAt: new Date(), loading: false } }));
    } catch (e) {
      setPipelineRecon(s => ({ ...s, [id]: { ...s[id], loading: false, error: e.message } }));
    }
  }

  async function refreshPipelineLogs(id) {
    try {
      const rows = await api.getPipelineJobLogs(id, 50);
      setPipelineLogs(s => ({ ...s, [id]: rows }));
    } catch {}
  }

  async function togglePipelineLogs(id) {
    const nowOpen = !expanded[id];
    setExpanded(e => ({ ...e, [id]: nowOpen }));
    if (nowOpen) {
      refreshPipelineLogs(id);
      runReconcile(id);
    }
  }

  // Auto-refresh logs + reconcile for expanded pipelines
  useEffect(() => {
    const expandedIds = Object.keys(expanded).filter(id => expanded[id]);
    if (expandedIds.length === 0) return;
    const t1 = setInterval(() => { expandedIds.forEach(id => refreshPipelineLogs(id)); }, 3000);
    const t2 = setInterval(() => { expandedIds.forEach(id => runReconcile(id)); }, 30000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [expanded]);

  async function resetStats(job) {
    if (!confirm(`Reset Today/Total row counters for "${job.name}"? This only clears the display counters, not the data in ClickHouse.`)) return;
    setResetting(r => ({ ...r, [job.id]: true }));
    try {
      await api.resetStats(job.id);
      await loadJobs();
    } catch (e) { alert(e.message); }
    finally { setResetting(r => ({ ...r, [job.id]: false })); }
  }

  function clearFeed() {
    clearedAt.current = new Date().toISOString();
    setHasNew(false);
  }

  const visibleLogs = clearedAt.current
    ? logs.filter(e => e.created_at > clearedAt.current)
    : logs;

  const jobsMap = new Map(jobs.map(j => [j.id, j]));
  const running  = jobs.filter(j => j.is_running);
  const erroring = jobs.filter(j => !j.is_running && j.display_status === 'error');
  const active   = jobs.filter(j => !j.is_running && j.display_status === 'active');
  const paused   = jobs.filter(j => j.display_status === 'paused');

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Jobs</h1>
          <p className="text-sm text-slate-400 mt-0.5">Live pipeline execution status and full audit trail</p>
        </div>
        <TzToggle pref={tz} onChange={changeTz} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Running', count: running.length,  icon: Activity,     color: 'text-blue-400',  bg: 'bg-blue-950/40 border-blue-900' },
          { label: 'Active',  count: active.length,   icon: CheckCircle2, color: 'text-green-400', bg: 'bg-green-950/40 border-green-900' },
          { label: 'Errors',  count: erroring.length, icon: XCircle,      color: 'text-red-400',   bg: 'bg-red-950/40 border-red-900' },
          { label: 'Paused',  count: paused.length,   icon: Clock,        color: 'text-slate-400', bg: 'bg-slate-900 border-slate-800' },
        ].map(({ label, count, icon: Icon, color, bg }) => (
          <div key={label} className={`rounded-xl border px-5 py-4 ${bg}`}>
            <div className="flex items-center gap-2 mb-1"><Icon size={14} className={color} /><span className="text-xs text-slate-400">{label}</span></div>
            <div className={`text-2xl font-bold ${color}`}>{count}</div>
          </div>
        ))}
      </div>

      {/* Pipeline table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">All Pipelines</h2>
          <button onClick={loadJobs} className="text-slate-500 hover:text-white transition-colors"><RefreshCw size={13} /></button>
        </div>

        {jobs.length === 0 ? (
          <div className="text-center py-12 text-slate-500 text-sm">No pipelines configured yet.</div>
        ) : jobs.map(job => (
          <div key={job.id} className="border-b border-slate-800 last:border-0">
            <div className="flex items-center gap-4 px-5 py-3 hover:bg-slate-800/30 cursor-pointer transition-colors"
              onClick={() => togglePipelineLogs(job.id)}>
              <StatusDot status={job.display_status} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white text-sm">{job.name}</span>
                  <StatusLabel status={job.display_status} />
                  {job.is_running && <span className="text-xs text-blue-300 bg-blue-950/50 border border-blue-800 px-1.5 py-0.5 rounded">● Running</span>}
                  {(job.rows_dlq ?? 0) > 0 && (
                    <span className="text-xs text-amber-400 flex items-center gap-1"><AlertTriangle size={10} />{fmtNum(job.rows_dlq)} DLQ</span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 truncate">
                  {job.connection_name} → {job.index_pattern} → {job.clickhouse_database}.{job.clickhouse_table}
                </div>
              </div>

              <div className="flex items-center gap-4 text-xs flex-shrink-0">
                <div className="text-center">
                  <div className="text-slate-400">Today</div>
                  <div className="text-white tabular-nums font-medium">{fmtNum(job.rows_inserted_today)}</div>
                </div>
                <div className="text-center">
                  <div className="text-slate-400">Total</div>
                  <div className="text-white tabular-nums font-medium">{fmtNum(job.rows_inserted_total)}</div>
                </div>
                <div className="text-center min-w-[80px]">
                  <div className="text-slate-400">Last run</div>
                  <div className="text-white">{fmtRelative(job.last_run_at)}</div>
                </div>
                <div className="text-center min-w-[130px]">
                  <div className="text-slate-400">Checkpoint</div>
                  <div className="text-white font-mono text-xs truncate max-w-[140px]">
                    {job.cursor_timestamp ? fmtTs(job.cursor_timestamp, tz) : 'none'}
                  </div>
                </div>
                {/* Reset stats button */}
                <button
                  onClick={e => { e.stopPropagation(); resetStats(job); }}
                  disabled={resetting[job.id]}
                  title="Reset Today/Total row counters"
                  className="icon-btn text-slate-500 hover:text-amber-400 transition-colors"
                >
                  <RotateCcw size={13} />
                </button>
                {expanded[job.id] ? <ChevronUp size={13} className="text-slate-500" /> : <ChevronDown size={13} className="text-slate-500" />}
              </div>
            </div>

            {expanded[job.id] && (
              <div className="px-5 pb-4 bg-slate-900/50">
                {job.last_error && job.display_status === 'error' && (
                  <div className="mb-2 px-3 py-2 bg-red-950/40 border border-red-900 rounded text-xs text-red-300">
                    <span className="font-medium">Last error:</span> {job.last_error}
                  </div>
                )}

                {/* Stats grid */}
                <div className="grid grid-cols-4 gap-2 mb-3 pt-1">
                  <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                    <div className="text-[10px] text-slate-500 mb-0.5">Last batch</div>
                    <div className="text-xs text-slate-200 font-medium">{job.last_batch_size > 0 ? fmtNum(job.last_batch_size) + ' rows' : '—'}</div>
                  </div>
                  <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                    <div className="text-[10px] text-slate-500 mb-0.5">Dedup-skipped</div>
                    <div className="text-xs text-slate-200 font-medium">{fmtNum(job.rows_skipped_dedup ?? 0)}</div>
                  </div>
                  <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                    <div className="text-[10px] text-slate-500 mb-0.5">Data processed</div>
                    <div className="text-xs text-slate-200 font-medium">{job.bytes_processed > 0 ? (job.bytes_processed >= 1e9 ? (job.bytes_processed/1e9).toFixed(1)+' GB' : job.bytes_processed >= 1e6 ? (job.bytes_processed/1e6).toFixed(1)+' MB' : job.bytes_processed >= 1e3 ? (job.bytes_processed/1e3).toFixed(1)+' KB' : job.bytes_processed+' B') : '—'}</div>
                  </div>
                  <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                    <div className="text-[10px] text-slate-500 mb-0.5">Checkpoint cursor</div>
                    <div className="text-xs text-slate-300 font-mono truncate">{job.cursor_timestamp ? fmtTs(job.cursor_timestamp, tz) : 'from start'}</div>
                  </div>
                </div>

                {/* Reconciliation */}
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
                      <GitCompare size={12} className="text-slate-500" />
                      Reconciliation
                    </div>
                    <div className="flex items-center gap-2">
                      {pipelineRecon[job.id]?.checkedAt && (
                        <span className="text-[10px] text-slate-600">
                          checked {pipelineRecon[job.id].checkedAt.toLocaleTimeString()}
                        </span>
                      )}
                      <button onClick={() => runReconcile(job.id)} disabled={pipelineRecon[job.id]?.loading}
                        className="text-slate-600 hover:text-slate-400 transition-colors disabled:opacity-40">
                        <RefreshCw size={11} className={pipelineRecon[job.id]?.loading ? 'animate-spin' : ''} />
                      </button>
                    </div>
                  </div>
                  {(() => {
                    const recon = pipelineRecon[job.id];
                    if (!recon || recon.loading) return (
                      <div className="text-[11px] text-slate-500 italic flex items-center gap-1.5">
                        <RefreshCw size={10} className="animate-spin" /> Checking source vs destination counts…
                      </div>
                    );
                    if (recon.error) return (
                      <div className="text-[11px] text-red-400">{recon.error}</div>
                    );
                    if (!recon.result) return null;
                    const { overall, indexes } = recon.result;
                    const overallColor = overall === 'MATCH'    ? 'text-emerald-400 border-emerald-800 bg-emerald-950/30'
                                       : overall === 'MISMATCH' ? 'text-red-400 border-red-800 bg-red-950/30'
                                       : 'text-slate-400 border-slate-700 bg-slate-800/30';
                    return (
                      <div>
                        <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-semibold mb-1.5 ${overallColor}`}>
                          {overall === 'MATCH' ? <CheckCircle size={10} /> : overall === 'MISMATCH' ? <XCircle size={10} /> : <AlertTriangle size={10} />}
                          {overall}
                        </div>
                        <div className="space-y-1">
                          {indexes.map((ix, i) => (
                            <div key={i} className="flex items-center gap-2 text-[10px] font-mono bg-slate-800/40 rounded px-2 py-1">
                              <span className={`w-16 flex-shrink-0 font-semibold ${ix.status === 'MATCH' ? 'text-emerald-500' : ix.status === 'MISMATCH' ? 'text-red-400' : 'text-slate-500'}`}>{ix.status}</span>
                              <span className="text-slate-400 truncate flex-1">{ix.index}</span>
                              <span className="text-slate-500 flex-shrink-0">OS <span className="text-slate-300">{ix.source_count?.toLocaleString() ?? '?'}</span></span>
                              <span className="text-slate-500 flex-shrink-0">CH <span className="text-slate-300">{ix.dest_count?.toLocaleString() ?? '?'}</span></span>
                              {ix.status === 'MISMATCH' && (
                                <span className="text-amber-400 flex-shrink-0">Δ {Math.abs((ix.source_count ?? 0) - (ix.dest_count ?? 0)).toLocaleString()}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs text-slate-500 font-medium">Recent log entries</div>
                  <button onClick={() => refreshPipelineLogs(job.id)} className="text-slate-600 hover:text-slate-400 transition-colors"><RefreshCw size={11} /></button>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
                  {(pipelineLogs[job.id] || []).length === 0 ? (
                    <div className="text-center py-4 text-slate-600 text-xs">No log entries yet</div>
                  ) : (
                    <div className="divide-y divide-slate-800/50 max-h-48 overflow-y-auto">
                      {(pipelineLogs[job.id] || []).slice(-20).map(entry => {
                        const { body } = parseLogEntry(entry);
                        return (
                          <div key={entry.id} className={`flex items-start gap-3 px-3 py-1.5 text-xs font-mono ${entry.level === 'error' ? 'bg-red-950/20' : ''}`}>
                            <span className="text-slate-600 flex-shrink-0">{fmtTs(entry.created_at, tz)}</span>
                            <span className={`w-8 flex-shrink-0 ${entry.level === 'error' ? 'text-red-400' : entry.level === 'warn' ? 'text-amber-400' : 'text-slate-500'}`}>{entry.level}</span>
                            <span className={`flex-1 break-all ${entry.level === 'error' ? 'text-red-300' : 'text-slate-400'}`}>{body}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Live Log Feed */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white flex-1">
            Live Audit Feed
            {hasNew && !autoScroll && (
              <span className="ml-2 text-xs text-brand-400 animate-pulse">● new entries</span>
            )}
          </h2>
          <select className="input text-xs py-1 h-7" value={levelFilter} onChange={e => setLevelFilter(e.target.value)}>
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error only</option>
          </select>
          <select className="input text-xs py-1 h-7" value={logFilter} onChange={e => setLogFilter(e.target.value)}>
            <option value="">All pipelines + system</option>
            {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
          <button onClick={clearFeed} title="Clear feed display (new logs keep arriving)"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors">
            <Eraser size={11} />
            Reset
          </button>
          <CopyAllButton logs={visibleLogs} tz={tz} />
        </div>

        {/* Legend */}
        <div className="px-5 py-2 border-b border-slate-800/60 flex items-center gap-4 text-xs text-slate-500">
          <span className="text-brand-400 font-medium">[pipeline]</span><span>start · stop · run · edit</span>
          <span className="text-cyan-400 font-medium">[connection]</span><span>OpenSearch source config</span>
          <span className="text-purple-400 font-medium">[cluster]</span><span>ClickHouse destination config</span>
          <span className="text-yellow-400/80 font-medium ml-1">index:</span><span>source OS index per batch</span>
          <span className="text-amber-400 ml-auto">warn = destructive</span>
          <span className="text-red-400">error = failure</span>
        </div>

        <div
          ref={logRef}
          className="h-[32rem] overflow-y-auto bg-slate-950 px-4 py-2 font-mono"
          onScroll={e => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (atBottom) setHasNew(false);
            setAutoScroll(atBottom);
            // Auto-load older when scrolled near top
            if (el.scrollTop < 80 && hasOlder && !loadingOlder) loadOlderLogs();
          }}
        >
          {/* Load older button at top */}
          {visibleLogs.length > 0 && (
            <div className="text-center py-2">
              {hasOlder ? (
                <button onClick={loadOlderLogs} disabled={loadingOlder}
                  className="text-xs text-slate-500 hover:text-slate-300 border border-slate-700 rounded px-3 py-1 transition-colors disabled:opacity-40">
                  {loadingOlder ? 'Loading…' : '↑ Load older logs'}
                </button>
              ) : (
                <span className="text-xs text-slate-700">— beginning of log history —</span>
              )}
            </div>
          )}

          {visibleLogs.length === 0 ? (
            <div className="text-slate-600 text-xs text-center py-8">
              {clearedAt.current ? 'Feed cleared — new events will appear here.' : 'No events yet — actions appear here immediately.'}
            </div>
          ) : (
            visibleLogs.map(entry => <LogLine key={entry.id} entry={entry} tz={tz} jobsMap={jobsMap} />)
          )}
        </div>

        <div className="px-5 py-1.5 border-t border-slate-800 text-xs text-slate-600 flex items-center justify-between">
          <span>
            {visibleLogs.length.toLocaleString()} entries shown · polling every 1.5s
            {clearedAt.current && <span className="ml-2 text-slate-700">· cleared {new Date(clearedAt.current).toLocaleTimeString()}</span>}
          </span>
          <a href="/log-history" className="text-slate-500 hover:text-brand-400 transition-colors">View full log history →</a>
        </div>
      </div>
    </div>
  );
}
