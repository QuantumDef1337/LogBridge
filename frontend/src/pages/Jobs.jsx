import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Activity, CheckCircle2, XCircle, Clock, AlertTriangle, RefreshCw,
  ChevronDown, ChevronUp, RotateCcw, Trash2, CheckCircle, GitCompare,
  Copy, Check, Eraser, Search, Zap, AlertCircle, BarChart2, X,
} from 'lucide-react';
import { api } from '../api';
import { fmtTs, fmtRelative, getTzPref, setTzPref } from '../utils/time';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtBytes(b) {
  if (!b) return '—';
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GiB';
  if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MiB';
  if (b >= 1024)       return (b / 1024).toFixed(1) + ' KiB';
  return b + ' B';
}

function fmtEta(secs) {
  if (!secs || secs <= 0) return null;
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtLag(secs) {
  if (secs == null) return null;
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

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

// Event lag badge
function LagBadge({ secs }) {
  if (secs == null) return null;
  const label = fmtLag(secs);
  const color = secs < 300 ? 'text-emerald-400 bg-emerald-950/40 border-emerald-800'
              : secs < 3600 ? 'text-amber-400 bg-amber-950/40 border-amber-800'
              : 'text-red-400 bg-red-950/40 border-red-800';
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${color}`} title={`Event lag: ${label} behind live`}>
      {label} lag
    </span>
  );
}

// Rows/sec stat
function RpsStat({ batchSize, durationMs }) {
  if (!batchSize || !durationMs || durationMs <= 0) return null;
  const rps = Math.round(batchSize / (durationMs / 1000));
  if (!rps) return null;
  return (
    <span className="text-[10px] font-mono text-cyan-400/80 flex items-center gap-0.5" title="Current rows/sec">
      <Zap size={9} />{fmtNum(rps)}/s
    </span>
  );
}

// Error count badge
function ErrorBadge({ count, onClick }) {
  if (!count) return null;
  return (
    <button onClick={onClick}
      className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-950/60 text-red-300 border border-red-800 hover:bg-red-900/60 transition-colors"
      title={`${count} recent errors — click to view logs`}>
      <AlertCircle size={9} />{count} err
    </button>
  );
}

// ETA progress bar
function EtaBar({ job }) {
  const total = job.source_doc_count;
  const done  = job.rows_inserted_total || 0;
  if (!total || total <= 0 || done <= 0) return null;
  const pct = Math.min(100, (done / total) * 100);

  const rps = (job.last_batch_size && job.last_run_duration_ms > 0)
    ? job.last_batch_size / (job.last_run_duration_ms / 1000) : 0;
  const remaining = total - done;
  const etaSecs = rps > 0 ? remaining / rps : null;

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>{fmtNum(done)} / {fmtNum(total)} rows <span className="text-slate-600">({pct.toFixed(1)}%)</span></span>
        <span className="flex items-center gap-2">
          {rps > 0 && <span className="text-cyan-400">{fmtNum(Math.round(rps))}/s</span>}
          {etaSecs && <span className="text-amber-400">ETA {fmtEta(etaSecs)}</span>}
        </span>
      </div>
      <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
        <div className="h-full bg-gradient-to-r from-brand-600 to-brand-400 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Mini sparkline SVG (20 data points, normalized 0–1)
function Sparkline({ data }) {
  if (!data || data.length < 2) return null;
  const W = 80, H = 24, PAD = 2;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => {
    const x = PAD + (i / (data.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((v / max) * (H - PAD * 2));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={W} height={H} className="flex-shrink-0" title="rows/sec over time">
      <polyline points={pts} fill="none" stroke="#38bdf8" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

// Per-index progress bars
function IndexProgress({ indexes, tz }) {
  if (!indexes || indexes.length === 0) return (
    <div className="text-xs text-slate-600 italic py-2">No per-index data yet</div>
  );
  const total = indexes.reduce((s, ix) => s + (ix.rows_inserted || 0), 0);
  return (
    <div className="space-y-1.5">
      {indexes.map(ix => {
        const pct = total > 0 ? Math.min(100, ((ix.rows_inserted || 0) / total) * 100) : 0;
        const statusColor = ix.status === 'running' ? 'text-blue-400'
          : ix.status === 'done' ? 'text-emerald-400'
          : ix.last_error ? 'text-red-400' : 'text-slate-500';
        return (
          <div key={ix.index_name}>
            <div className="flex items-center justify-between text-[10px] mb-0.5">
              <span className="font-mono text-slate-400 truncate max-w-[200px]" title={ix.index_name}>{ix.index_name}</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={statusColor}>{ix.status}</span>
                <span className="text-slate-500">{fmtNum(ix.rows_inserted || 0)}</span>
                {ix.cursor_timestamp && <span className="text-slate-600">{fmtTs(ix.cursor_timestamp, tz)}</span>}
              </div>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1">
              <div className="h-full rounded-full transition-all duration-300"
                style={{ width: `${pct}%`, backgroundColor: ix.last_error ? '#ef4444' : ix.status === 'done' ? '#10b981' : '#3b82f6' }} />
            </div>
            {ix.last_error && <div className="text-[10px] text-red-400 mt-0.5 truncate">{ix.last_error}</div>}
          </div>
        );
      })}
    </div>
  );
}

// DLQ viewer
function DlqPanel({ pipelineId, dlqCount, tz }) {
  const [entries, setEntries]   = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(false);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    if (!dlqCount) return;
    setLoading(true);
    try {
      const data = await api.getDlq(pipelineId, { limit: 50 });
      setEntries(data.rows); setTotal(data.total);
    } catch {} finally { setLoading(false); }
  }, [pipelineId, dlqCount]);

  useEffect(() => { load(); }, [load]);

  async function dismiss(dlqId) {
    await api.dismissDlqEntry(pipelineId, dlqId);
    setEntries(e => e.filter(r => r.id !== dlqId));
    setTotal(t => t - 1);
  }

  async function dismissAll() {
    if (!confirm('Dismiss all DLQ entries for this pipeline?')) return;
    await api.dismissAllDlq(pipelineId);
    setEntries([]); setTotal(0);
  }

  if (!dlqCount) return (
    <div className="text-xs text-emerald-500 flex items-center gap-1"><CheckCircle size={11} />No DLQ entries — all events processed cleanly</div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-amber-400 flex items-center gap-1">
          <AlertTriangle size={11} />{total} DLQ {total === 1 ? 'entry' : 'entries'}
        </span>
        <div className="flex items-center gap-2">
          <button onClick={load} className="text-slate-600 hover:text-slate-300 transition-colors"><RefreshCw size={10} /></button>
          {total > 0 && (
            <button onClick={dismissAll} className="text-[10px] text-slate-500 hover:text-red-400 transition-colors border border-slate-700 px-2 py-0.5 rounded">
              Dismiss all
            </button>
          )}
        </div>
      </div>
      {loading ? (
        <div className="text-xs text-slate-500 italic">Loading…</div>
      ) : (
        <div className="space-y-1">
          {entries.map(e => (
            <div key={e.id} className="bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] font-mono text-amber-400 bg-amber-950/40 px-1 rounded">{e.error_category}</span>
                    <span className="text-[10px] text-slate-500">{fmtTs(e.first_failure_at, tz)}</span>
                    {e.retry_count > 0 && <span className="text-[10px] text-slate-600">{e.retry_count}× retried</span>}
                  </div>
                  <div className="text-xs text-red-300 truncate">{e.error_message}</div>
                  {e.source_index && <div className="text-[10px] text-slate-600 mt-0.5 font-mono">index: {e.source_index}</div>}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {e.document_preview && (
                    <button onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                      className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors">
                      {expanded === e.id ? 'hide' : 'doc'}
                    </button>
                  )}
                  <button onClick={() => dismiss(e.id)} title="Dismiss"
                    className="text-slate-600 hover:text-red-400 transition-colors"><X size={12} /></button>
                </div>
              </div>
              {expanded === e.id && e.document_preview && (
                <pre className="mt-2 text-[10px] text-slate-400 bg-slate-900 rounded p-2 overflow-x-auto max-h-32 font-mono">
                  {e.document_preview}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Log line components (unchanged from before) ──────────────────────────────

function parseLogEntry(entry) {
  const match = entry.message?.match(/^\[(\w+)\]\s*/);
  return { category: match ? match[1] : null, body: match ? entry.message.slice(match[0].length) : entry.message };
}
const CATEGORY_COLORS = {
  pipeline:   { text: 'text-brand-400',  bg: 'bg-brand-950/30' },
  connection: { text: 'text-cyan-400',   bg: 'bg-cyan-950/30' },
  cluster:    { text: 'text-purple-400', bg: 'bg-purple-950/30' },
  system:     { text: 'text-slate-400',  bg: '' },
};
const LEVEL_COLORS = { error: 'text-red-400', warn: 'text-amber-400', info: 'text-slate-300' };

function parseBatchInsert(body) {
  const m = body?.match(/Batch inserted:\s*([\d,]+)\s*rows\s*\(fetched\s*([\d,]+),\s*skipped\s*([\d,]+)\s*dedup\)/i);
  if (!m) return null;
  return {
    inserted: parseInt(m[1].replace(/,/g, '')),
    fetched:  parseInt(m[2].replace(/,/g, '')),
    skipped:  parseInt(m[3].replace(/,/g, '')),
    fromTs:   body.match(/from:(\d{4}-\d{2}-\d{2}[T ][\d:.]+)/)?.[1] || null,
    toTs:     body.match(/to:(\d{4}-\d{2}-\d{2}[T ][\d:.]+)/)?.[1]   || null,
    index:    body.match(/index:(\S+)/)?.[1] || null,
  };
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  function copy() { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }
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
  const copyText = [fmtTs(entry.created_at, tz), entry.pipeline_name, category ? `[${category}]` : '', entry.level, body].filter(Boolean).join('  ');
  return (
    <div className={`group py-1.5 border-b border-slate-800/40 hover:bg-slate-800/20 ${isSystem ? 'opacity-80' : ''}`}>
      <div className="flex items-start gap-2 text-xs font-mono">
        <span className="text-slate-600 w-44 flex-shrink-0 shrink-0">{fmtTs(entry.created_at, tz)}</span>
        <span className={`w-24 flex-shrink-0 truncate font-semibold ${isSystem ? 'text-slate-500' : 'text-brand-400'}`}>{entry.pipeline_name}</span>
        {category && <span className={`w-20 flex-shrink-0 text-xs px-1 rounded ${cat.text || 'text-slate-500'}`}>[{category}]</span>}
        <span className={`w-10 flex-shrink-0 ${LEVEL_COLORS[entry.level] || 'text-slate-400'}`}>{entry.level}</span>
        <span className={`flex-1 break-words ${LEVEL_COLORS[entry.level] || 'text-slate-400'}`}>{body}</span>
        <CopyButton text={copyText} />
      </div>
      {batchInfo && job && (
        <div className="ml-[13.5rem] mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono">
          {batchInfo.index && <span className="text-slate-500">from <span className="text-yellow-400/90 font-medium">{batchInfo.index}</span></span>}
          <span className="text-emerald-500">→ {job.clickhouse_database}.{job.clickhouse_table}</span>
          <span className="text-slate-500">inserted <span className="text-slate-300">{batchInfo.inserted.toLocaleString()}</span></span>
          {batchInfo.skipped > 0 && <span className="text-amber-500/80">dedup-skipped {batchInfo.skipped.toLocaleString()}</span>}
          {batchInfo.fromTs && <span className="text-slate-600">from <span className="text-blue-300/80">{fmtTs(batchInfo.fromTs, tz)}</span></span>}
          {batchInfo.toTs && <span className="text-slate-600">to <span className="text-blue-300/80">{fmtTs(batchInfo.toTs, tz)}</span></span>}
        </div>
      )}
    </div>
  );
}

function CopyAllButton({ logs, tz }) {
  const [copied, setCopied] = useState(false);
  function copyAll() {
    const lines = logs.map(e => { const { category, body } = parseLogEntry(e); return [fmtTs(e.created_at, tz), e.pipeline_name, category ? `[${category}]` : '', e.level, body].filter(Boolean).join('  '); });
    navigator.clipboard.writeText(lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }
  return (
    <button onClick={copyAll} title="Copy all log lines"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors">
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      {copied ? 'Copied!' : 'Copy all'}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const MAX_SPARKLINE_PTS = 20;

export default function Jobs() {
  const [jobs, setJobs]                   = useState([]);
  const [logs, setLogs]                   = useState([]);
  const [logFilter, setLogFilter]         = useState('');
  const [levelFilter, setLevelFilter]     = useState('');
  const [autoScroll, setAutoScroll]       = useState(true);
  const [expanded, setExpanded]           = useState({});
  const [activeTab, setActiveTab]         = useState({}); // id → 'logs'|'dlq'|'indexes'|'recon'
  const [pipelineLogs, setPipelineLogs]   = useState({});
  const [pipelineIndexes, setPipelineIndexes] = useState({});
  const [pipelineRecon, setPipelineRecon] = useState({});
  const [tz, setTzState]                  = useState(getTzPref);
  const [resetting, setResetting]         = useState({});
  const [search, setSearch]               = useState('');
  const logRef       = useRef(null);
  const latestLogId  = useRef(0);
  const oldestLogId  = useRef(null);
  const clearedAt    = useRef(null);
  const sparklines   = useRef(new Map()); // id → number[]
  const prevJobs     = useRef(new Map()); // id → job snapshot
  const [hasNew, setHasNew]               = useState(false);
  const [loadingOlder, setLoadingOlder]   = useState(false);
  const [hasOlder, setHasOlder]           = useState(true);

  function changeTz(v) { setTzPref(v); setTzState(v); }

  const loadJobs = useCallback(async () => {
    try {
      const fresh = await api.getJobs();
      // Update sparklines from new batch data
      fresh.forEach(job => {
        if (!job.last_batch_size || !job.last_run_duration_ms || job.last_run_duration_ms <= 0) return;
        const prev = prevJobs.current.get(job.id);
        if (prev && prev.rows_inserted_total === job.rows_inserted_total) return; // no new batch
        const rps = Math.round(job.last_batch_size / (job.last_run_duration_ms / 1000));
        if (!sparklines.current.has(job.id)) sparklines.current.set(job.id, []);
        const pts = sparklines.current.get(job.id);
        pts.push(rps);
        if (pts.length > MAX_SPARKLINE_PTS) pts.shift();
      });
      prevJobs.current = new Map(fresh.map(j => [j.id, j]));
      setJobs(fresh);
    } catch {}
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const params = { limit: 500 };
      if (levelFilter) params.level = levelFilter;
      if (logFilter)   params.pipeline_id = logFilter;
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
      if (logFilter)   params.pipeline_id = logFilter;
      const older = await api.getJobLogs(params);
      if (older.length > 0) {
        oldestLogId.current = older[0].id;
        setLogs(prev => [...older, ...prev]);
        setHasOlder(older.length >= 500);
      } else { setHasOlder(false); }
    } catch {} finally { setLoadingOlder(false); }
  }

  useEffect(() => {
    loadJobs(); loadLogs();
    const t1 = setInterval(loadJobs, 2000);
    const t2 = setInterval(loadLogs, 1500);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [loadJobs, loadLogs]);

  useEffect(() => {
    if (autoScroll && logRef.current) { logRef.current.scrollTop = logRef.current.scrollHeight; setHasNew(false); }
  }, [logs, autoScroll]);

  async function runReconcile(id) {
    setPipelineRecon(s => ({ ...s, [id]: { ...s[id], loading: true } }));
    try {
      const result = await api.reconcile(id);
      setPipelineRecon(s => ({ ...s, [id]: { result, checkedAt: new Date(), loading: false } }));
    } catch (e) { setPipelineRecon(s => ({ ...s, [id]: { ...s[id], loading: false, error: e.message } })); }
  }

  async function refreshPipelineLogs(id) {
    try { const rows = await api.getPipelineJobLogs(id, 50); setPipelineLogs(s => ({ ...s, [id]: rows })); } catch {}
  }

  async function refreshIndexes(id) {
    try { const rows = await api.getJobIndexes(id); setPipelineIndexes(s => ({ ...s, [id]: rows })); } catch {}
  }

  async function toggleExpand(id) {
    const nowOpen = !expanded[id];
    setExpanded(e => ({ ...e, [id]: nowOpen }));
    if (nowOpen) {
      if (!activeTab[id]) setActiveTab(t => ({ ...t, [id]: 'logs' }));
      refreshPipelineLogs(id);
      refreshIndexes(id);
      runReconcile(id);
    }
  }

  useEffect(() => {
    const ids = Object.keys(expanded).filter(id => expanded[id]);
    if (!ids.length) return;
    const t1 = setInterval(() => ids.forEach(id => refreshPipelineLogs(id)), 3000);
    const t2 = setInterval(() => ids.forEach(id => refreshIndexes(id)), 5000);
    const t3 = setInterval(() => ids.forEach(id => runReconcile(id)), 30000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [expanded]);

  async function resetStats(job) {
    if (!confirm(`Reset Today/Total row counters for "${job.name}"?`)) return;
    setResetting(r => ({ ...r, [job.id]: true }));
    try { await api.resetStats(job.id); await loadJobs(); }
    catch (e) { alert(e.message); }
    finally { setResetting(r => ({ ...r, [job.id]: false })); }
  }

  function clearFeed() { clearedAt.current = new Date().toISOString(); setHasNew(false); }

  const visibleLogs = clearedAt.current ? logs.filter(e => e.created_at > clearedAt.current) : logs;
  const jobsMap = new Map(jobs.map(j => [j.id, j]));

  const filteredJobs = search
    ? jobs.filter(j => j.name.toLowerCase().includes(search.toLowerCase()) || (j.index_pattern || '').toLowerCase().includes(search.toLowerCase()))
    : jobs;

  const running  = jobs.filter(j => j.is_running);
  const erroring = jobs.filter(j => !j.is_running && j.display_status === 'error');
  const active   = jobs.filter(j => !j.is_running && j.display_status === 'active');
  const paused   = jobs.filter(j => j.display_status === 'paused');

  // ─── Render ───────────────────────────────────────────────────────────────

  function PipelineTab({ id, label, tab, badge }) {
    const isActive = activeTab[id] === tab;
    return (
      <button onClick={() => setActiveTab(t => ({ ...t, [id]: tab }))}
        className={`px-3 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${isActive ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
        {label}
        {badge > 0 && <span className="text-[9px] bg-amber-600 text-white rounded-full px-1 min-w-[14px] text-center">{badge}</span>}
      </button>
    );
  }

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
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white flex-shrink-0">All Pipelines</h2>
          {/* Search filter */}
          <div className="relative flex-1 max-w-xs">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Filter by name or index…"
              className="input w-full pl-7 text-xs h-7 py-0" />
          </div>
          <button onClick={loadJobs} className="text-slate-500 hover:text-white transition-colors flex-shrink-0"><RefreshCw size={13} /></button>
        </div>

        {filteredJobs.length === 0 ? (
          <div className="text-center py-12 text-slate-500 text-sm">{search ? 'No pipelines match your search.' : 'No pipelines configured yet.'}</div>
        ) : filteredJobs.map(job => {
          const sparkPts = sparklines.current.get(job.id) || [];
          const curTab   = activeTab[job.id] || 'logs';
          const dlqCount = job.rows_dlq || 0;

          return (
            <div key={job.id} className="border-b border-slate-800 last:border-0">
              {/* Pipeline row */}
              <div className="flex items-center gap-4 px-5 py-3 hover:bg-slate-800/30 cursor-pointer transition-colors"
                onClick={() => toggleExpand(job.id)}>
                <StatusDot status={job.display_status} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-white text-sm">{job.name}</span>
                    <StatusLabel status={job.display_status} />
                    {job.is_running && <span className="text-xs text-blue-300 bg-blue-950/50 border border-blue-800 px-1.5 py-0.5 rounded">● Running</span>}
                    <LagBadge secs={job.event_lag_secs} />
                    <RpsStat batchSize={job.last_batch_size} durationMs={job.last_run_duration_ms} />
                    <ErrorBadge count={job.consecutive_errors}
                      onClick={e => { e.stopPropagation(); setExpanded(x => ({ ...x, [job.id]: true })); setActiveTab(t => ({ ...t, [job.id]: 'logs' })); refreshPipelineLogs(job.id); }} />
                    {dlqCount > 0 && (
                      <button onClick={e => { e.stopPropagation(); setExpanded(x => ({ ...x, [job.id]: true })); setActiveTab(t => ({ ...t, [job.id]: 'dlq' })); }}
                        className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800 hover:bg-amber-900/60 transition-colors">
                        <AlertTriangle size={9} />{fmtNum(dlqCount)} DLQ
                      </button>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate">
                    {job.connection_name} → {job.index_pattern} → {job.clickhouse_database}.{job.clickhouse_table}
                  </div>
                  {/* ETA / progress bar */}
                  <EtaBar job={job} />
                </div>

                <div className="flex items-center gap-4 text-xs flex-shrink-0">
                  {/* Sparkline */}
                  {sparkPts.length >= 2 && <Sparkline data={sparkPts} />}

                  <div className="text-center">
                    <div className="text-slate-400">Today</div>
                    <div className="text-white tabular-nums font-medium">{fmtNum(job.rows_inserted_today)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-slate-400">Total</div>
                    <div className="text-white tabular-nums font-medium">{fmtNum(job.rows_inserted_total)}</div>
                  </div>
                  <div className="text-center min-w-[72px]">
                    <div className="text-slate-400">Data</div>
                    <div className="text-white">{fmtBytes(job.bytes_processed)}</div>
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
                  <button onClick={e => { e.stopPropagation(); resetStats(job); }} disabled={resetting[job.id]}
                    title="Reset row counters" className="icon-btn text-slate-500 hover:text-amber-400 transition-colors">
                    <RotateCcw size={13} />
                  </button>
                  {expanded[job.id] ? <ChevronUp size={13} className="text-slate-500" /> : <ChevronDown size={13} className="text-slate-500" />}
                </div>
              </div>

              {/* Expanded detail */}
              {expanded[job.id] && (
                <div className="px-5 pb-4 bg-slate-900/50 border-t border-slate-800/50">
                  {job.last_error && job.display_status === 'error' && (
                    <div className="mt-3 mb-2 px-3 py-2 bg-red-950/40 border border-red-900 rounded text-xs text-red-300">
                      <span className="font-medium">Last error:</span> {job.last_error}
                    </div>
                  )}

                  {/* Stats strip */}
                  <div className="grid grid-cols-5 gap-2 my-3">
                    {[
                      ['Last batch', job.last_batch_size > 0 ? fmtNum(job.last_batch_size) + ' rows' : '—'],
                      ['Batch time', job.last_run_duration_ms > 0 ? (job.last_run_duration_ms / 1000).toFixed(1) + 's' : '—'],
                      ['Dedup-skip', fmtNum(job.rows_skipped_dedup ?? 0)],
                      ['DLQ total', fmtNum(dlqCount)],
                      ['Data processed', fmtBytes(job.bytes_processed)],
                    ].map(([label, val]) => (
                      <div key={label} className="bg-slate-800/60 rounded-lg px-3 py-2">
                        <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
                        <div className="text-xs text-slate-200 font-medium">{val}</div>
                      </div>
                    ))}
                  </div>

                  {/* Tabs */}
                  <div className="flex items-center gap-1 mb-3 bg-slate-800/40 rounded-lg p-1 w-fit">
                    <PipelineTab id={job.id} label="Recent Logs" tab="logs" />
                    <PipelineTab id={job.id} label="DLQ" tab="dlq" badge={dlqCount} />
                    <PipelineTab id={job.id} label="Indexes" tab="indexes" />
                    <PipelineTab id={job.id} label="Reconcile" tab="recon" />
                  </div>

                  {/* Tab: Logs */}
                  {curTab === 'logs' && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="text-xs text-slate-500 font-medium">Recent log entries</div>
                        <button onClick={() => refreshPipelineLogs(job.id)} className="text-slate-600 hover:text-slate-400 transition-colors"><RefreshCw size={11} /></button>
                      </div>
                      <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
                        {(pipelineLogs[job.id] || []).length === 0 ? (
                          <div className="text-center py-4 text-slate-600 text-xs">No log entries yet</div>
                        ) : (
                          <div className="divide-y divide-slate-800/50 max-h-56 overflow-y-auto">
                            {(pipelineLogs[job.id] || []).map(entry => {
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

                  {/* Tab: DLQ */}
                  {curTab === 'dlq' && (
                    <DlqPanel pipelineId={job.id} dlqCount={dlqCount} tz={tz} />
                  )}

                  {/* Tab: Indexes */}
                  {curTab === 'indexes' && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-xs text-slate-500 font-medium">Per-index progress</div>
                        <button onClick={() => refreshIndexes(job.id)} className="text-slate-600 hover:text-slate-400 transition-colors"><RefreshCw size={11} /></button>
                      </div>
                      <div className="bg-slate-950 border border-slate-800 rounded-lg p-3">
                        <IndexProgress indexes={pipelineIndexes[job.id]} tz={tz} />
                      </div>
                    </div>
                  )}

                  {/* Tab: Reconcile */}
                  {curTab === 'recon' && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
                          <GitCompare size={12} className="text-slate-500" />Reconciliation
                        </div>
                        <div className="flex items-center gap-2">
                          {pipelineRecon[job.id]?.checkedAt && (
                            <span className="text-[10px] text-slate-600">checked {pipelineRecon[job.id].checkedAt.toLocaleTimeString()}</span>
                          )}
                          <button onClick={() => runReconcile(job.id)} disabled={pipelineRecon[job.id]?.loading}
                            className="text-slate-600 hover:text-slate-400 transition-colors disabled:opacity-40">
                            <RefreshCw size={11} className={pipelineRecon[job.id]?.loading ? 'animate-spin' : ''} />
                          </button>
                        </div>
                      </div>
                      {(() => {
                        const recon = pipelineRecon[job.id];
                        if (!recon || recon.loading) return <div className="text-[11px] text-slate-500 italic flex items-center gap-1.5"><RefreshCw size={10} className="animate-spin" /> Checking…</div>;
                        if (recon.error) return <div className="text-[11px] text-red-400">{recon.error}</div>;
                        if (!recon.result) return null;
                        const { overall, indexes } = recon.result;
                        const overallColor = overall === 'MATCH' ? 'text-emerald-400 border-emerald-800 bg-emerald-950/30'
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
                                  {ix.status === 'MISMATCH' && <span className="text-amber-400 flex-shrink-0">Δ {Math.abs((ix.source_count ?? 0) - (ix.dest_count ?? 0)).toLocaleString()}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Live Log Feed */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white flex-1">
            Live Audit Feed
            {hasNew && !autoScroll && <span className="ml-2 text-xs text-brand-400 animate-pulse">● new entries</span>}
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
          <button onClick={clearFeed}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors">
            <Eraser size={11} />Reset
          </button>
          <CopyAllButton logs={visibleLogs} tz={tz} />
        </div>

        <div className="px-5 py-2 border-b border-slate-800/60 flex items-center gap-4 text-xs text-slate-500">
          <span className="text-brand-400 font-medium">[pipeline]</span><span>start · stop · run · edit</span>
          <span className="text-cyan-400 font-medium">[connection]</span><span>OpenSearch source config</span>
          <span className="text-purple-400 font-medium">[cluster]</span><span>ClickHouse destination config</span>
          <span className="text-yellow-400/80 font-medium ml-1">index:</span><span>source OS index per batch</span>
          <span className="text-amber-400 ml-auto">warn = destructive</span>
          <span className="text-red-400">error = failure</span>
        </div>

        <div ref={logRef} className="h-[32rem] overflow-y-auto bg-slate-950 px-4 py-2 font-mono"
          onScroll={e => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (atBottom) setHasNew(false);
            setAutoScroll(atBottom);
            if (el.scrollTop < 80 && hasOlder && !loadingOlder) loadOlderLogs();
          }}>
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
          ) : visibleLogs.map(entry => <LogLine key={entry.id} entry={entry} tz={tz} jobsMap={jobsMap} />)}
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
