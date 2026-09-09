import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Play, Pause, Trash2, Edit2, RotateCcw, Search,
  Zap, FlaskConical, X, ChevronDown, ChevronUp, AlertTriangle,
  Activity, Clock, Database, GitCompare, ArrowRight, Server,
  CheckCircle2, XCircle, Circle, HardDrive, TrendingUp, RefreshCw,
} from 'lucide-react';
import { api } from '../api';

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtBytes(b) {
  if (!b) return '0 B';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function parseTs(ts) {
  if (!ts) return null;
  const s = String(ts);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) && !s.endsWith('Z') && !s.includes('+')) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  return new Date(s);
}

function fmtTs(ts) {
  if (!ts) return '—';
  try { return parseTs(ts)?.toLocaleString() ?? '—'; } catch { return ts; }
}

function fmtTsUtc(ts) {
  if (!ts) return null;
  try {
    const d = parseTs(ts);
    if (!d) return null;
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch { return null; }
}

/** Shows local time with UTC underneath — for cursor timestamps */
function CursorTs({ ts }) {
  if (!ts) return <span className="text-slate-600 text-[10px]">from start</span>;
  const local = fmtTs(ts);
  const utc   = fmtTsUtc(ts);
  return (
    <div>
      <div className="font-mono text-slate-300 text-[10px]">{local}</div>
      {utc && <div className="font-mono text-slate-500 text-[10px]">{utc}</div>}
    </div>
  );
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const diff = Math.floor((Date.now() - (parseTs(ts)?.getTime() ?? 0)) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtEta(remainingEvents, eps) {
  if (!eps || eps <= 0 || !remainingEvents) return null;
  const secs = Math.floor(remainingEvents / eps);
  if (secs < 60) return `~${secs}s`;
  if (secs < 3600) return `~${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `~${Math.floor(secs / 3600)}h`;
  return `~${Math.floor(secs / 86400)}d`;
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────

function StatusDot({ status, run, isRunning }) {
  if (isRunning) return (
    <span className="relative flex w-2.5 h-2.5">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
    </span>
  );
  if (run === 'error') return <span className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" />;
  if (status === 'active') return <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />;
  return <span className="w-2.5 h-2.5 rounded-full bg-slate-600 flex-shrink-0" />;
}

function StatusBadge({ status, run, isRunning }) {
  if (isRunning) return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-950 text-blue-300 border border-blue-800/60">
      Running
    </span>
  );
  if (run === 'error') return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-950 text-red-400 border border-red-800/60">
      <XCircle size={11} /> Error
    </span>
  );
  if (status === 'active') return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-950 text-emerald-400 border border-emerald-800/60">
      <CheckCircle2 size={11} /> Active
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
      <Circle size={11} /> Paused
    </span>
  );
}

function IconBtn({ onClick, disabled, title, children, color = '' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`group relative flex items-center justify-center w-7 h-7 rounded-md hover:bg-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${color}`}
    >
      {children}
      <span className="pointer-events-none absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] bg-slate-800 border border-slate-700 text-slate-200 px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity z-10">
        {title}
      </span>
    </button>
  );
}

function ProgressBar({ value, max }) {
  if (!max) return null;
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full bg-brand-600 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-500 tabular-nums w-8 text-right">{pct}%</span>
    </div>
  );
}

// ── Metrics header bar ────────────────────────────────────────────────────────

function MetricsBar({ metrics }) {
  if (!metrics) return null;
  const eps = metrics.ingestion?.last_60s?.events_per_sec ?? 0;
  const eps5 = metrics.ingestion?.last_5s?.events_per_sec ?? 0;
  const totalToday = metrics.pipelines?.rows_inserted_today ?? 0;
  const bytesProcessed = metrics.pipelines?.bytes_processed_total ?? 0;
  // rows_dlq_total = cumulative DLQ counter from pipeline_status (resets with Reset Stats)
  // dlq.pending = actual rows in pipeline_dlq table waiting retry
  const dlqPending = metrics.dlq?.pending ?? 0;
  const dlqTotal = metrics.pipelines?.rows_dlq_total ?? 0;
  const memMb = metrics.process?.rss_mb ?? 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Activity size={13} className={eps5 > 0 ? 'text-emerald-400' : 'text-slate-600'} />
          <span className="text-xs text-slate-500">Events / sec</span>
        </div>
        <div className="text-xl font-bold text-white tabular-nums">{eps.toFixed(1)}</div>
        {eps5 > 0 && <div className="text-xs text-emerald-400 mt-0.5">{eps5.toFixed(1)} right now</div>}
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp size={13} className="text-slate-500" />
          <span className="text-xs text-slate-500">Rows today</span>
        </div>
        <div className="text-xl font-bold text-white tabular-nums">{fmtNum(totalToday)}</div>
        <div className="text-xs text-slate-600 mt-0.5">resets at midnight</div>
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <HardDrive size={13} className="text-slate-500" />
          <span className="text-xs text-slate-500">Data processed</span>
        </div>
        <div className="text-xl font-bold text-white tabular-nums">{fmtBytes(bytesProcessed)}</div>
        <div className="text-xs text-slate-600 mt-0.5">cumulative total</div>
      </div>
      <div className={`bg-slate-900 border rounded-xl px-4 py-3 ${dlqPending > 0 ? 'border-amber-800/60' : 'border-slate-800'}`}>
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={13} className={dlqPending > 0 ? 'text-amber-400' : 'text-slate-600'} />
          <span className="text-xs text-slate-500">DLQ pending retry</span>
        </div>
        <div className={`text-xl font-bold tabular-nums ${dlqPending > 0 ? 'text-amber-400' : 'text-white'}`}>{fmtNum(dlqPending)}</div>
        <div className="text-xs text-slate-600 mt-0.5">{memMb.toFixed(0)} MB RSS</div>
      </div>
    </div>
  );
}

// ── Checkpoint / detail panel ─────────────────────────────────────────────────

function DetailPanel({ p, eps, partitions, reconcileResult, reconcilingId, onRunReconcile, onResetPartitionCursor }) {
  const sort = p.checkpoint_sort ? (() => { try { return JSON.parse(p.checkpoint_sort); } catch { return null; } })() : null;
  const lastTs = sort?.[0];
  const lastId = sort?.[1];

  const [chStats, setChStats] = useState(null);
  const [chLoading, setChLoading] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setChLoading(true);
    api.getChStats(p.id)
      .then(s => setChStats(s))
      .catch(() => setChStats(null))
      .finally(() => setChLoading(false));
  }, [p.id]);

  const remaining = p.source_doc_count && p.rows_inserted_total
    ? Math.max(0, p.source_doc_count - p.rows_inserted_total) : null;
  const eta = remaining !== null ? fmtEta(remaining, eps) : null;
  const progress = p.source_doc_count && p.rows_inserted_total
    ? { value: p.rows_inserted_total, max: p.source_doc_count } : null;

  const recon = reconcileResult?.[p.id];

  return (
    <div className="border-t border-slate-800 bg-slate-900/40 px-6 py-4 space-y-4">
      {/* Checkpoint row */}
      <div>
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2.5 flex items-center gap-2">
          <Clock size={11} /> Checkpoint
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-slate-800/60 rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-slate-500 mb-1">Oldest event (log time)</div>
            {p.oldest_source_ts ? (
              <div className="space-y-0.5">
                <div className="text-xs font-mono text-slate-200">{fmtTs(p.oldest_source_ts)} <span className="text-slate-500">local</span></div>
                <div className="text-xs font-mono text-slate-500">{fmtTsUtc(p.oldest_source_ts)}</div>
              </div>
            ) : <span className="text-xs text-slate-600">—</span>}
          </div>
          <div className="bg-slate-800/60 rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-slate-500 mb-1">Newest event (log time)</div>
            {p.cursor_timestamp ? (
              <div className="space-y-0.5">
                <div className="text-xs font-mono text-slate-200">{fmtTs(p.cursor_timestamp)} <span className="text-slate-500">local</span></div>
                <div className="text-xs font-mono text-slate-500">{fmtTsUtc(p.cursor_timestamp)}</div>
              </div>
            ) : <span className="text-xs text-slate-600">not yet committed</span>}
          </div>
          <div className="bg-slate-800/60 rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-slate-500 mb-1">Checkpoint saved (run time)</div>
            {p.checkpoint_committed_at ? (
              <div className="space-y-0.5">
                <div className="text-xs font-mono text-slate-200">{fmtTs(p.checkpoint_committed_at)} <span className="text-slate-500">local</span></div>
                <div className="text-xs font-mono text-slate-500">{fmtTsUtc(p.checkpoint_committed_at)}</div>
              </div>
            ) : <span className="text-xs text-slate-600">—</span>}
          </div>
          <div className="bg-slate-800/60 rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-slate-500 mb-1">ClickHouse Storage</div>
            {chLoading ? (
              <div className="text-[10px] text-slate-600 animate-pulse">loading…</div>
            ) : chStats ? (
              <div className="space-y-0.5">
                <div className="text-xs text-slate-200 font-medium">{fmtNum(chStats.rows)} rows actual</div>
                <div className="text-[10px] text-slate-300">{fmtBytes(chStats.uncompressed_bytes)} <span className="text-slate-500">uncompressed</span></div>
                <div className="text-[10px] text-emerald-400">{fmtBytes(chStats.compressed_bytes)} <span className="text-slate-500">on-disk</span></div>
                {chStats.compressed_bytes > 0 && chStats.uncompressed_bytes > 0 && (
                  <div className="text-[10px] text-slate-600">
                    {(chStats.uncompressed_bytes / chStats.compressed_bytes).toFixed(1)}× compression ratio
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[10px] text-slate-600">unavailable</div>
            )}
          </div>
        </div>

        {progress && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5 text-xs">
              <span className="text-slate-500">Migration progress</span>
              <span className="text-slate-400 tabular-nums">
                {fmtNum(progress.value)} / {fmtNum(progress.max)}
                {eta && <span className="ml-2 text-brand-400">ETA {eta}</span>}
              </span>
            </div>
            <ProgressBar value={progress.value} max={progress.max} />
          </div>
        )}

        {/* Counters */}
        <div className="flex flex-wrap gap-4 mt-2.5 text-xs text-slate-500">
          <span>
            Tracked: <span className="text-slate-200 font-medium">{fmtNum(p.rows_inserted_total)}</span>
            {chStats && chStats.rows !== p.rows_inserted_total && (
              <span className="ml-1.5 text-amber-400" title="Actual rows in ClickHouse differ from LogBridge tracked count">
                · CH actual: <span className="font-medium">{fmtNum(chStats.rows)}</span>
              </span>
            )}
          </span>
          <span>Today: <span className="text-slate-200 font-medium">{fmtNum(p.rows_inserted_today)}</span></span>
          {(p.rows_skipped_dedup ?? 0) > 0 && <span>Dedup-skipped: <span className="text-slate-200 font-medium">{fmtNum(p.rows_skipped_dedup)}</span></span>}
          {(p.rows_dlq ?? 0) > 0 && <span className="text-amber-400">DLQ: <span className="font-medium">{fmtNum(p.rows_dlq)}</span></span>}
          {lastId && <span className="font-mono">cursor-id: <span className="text-slate-400">{lastId.slice(0, 16)}…</span></span>}
          {p.event_lag_secs != null && (
            <span title="Age of newest processed event vs wall-clock now">
              Event lag: <span className={`font-medium ${p.event_lag_secs < 60 ? 'text-emerald-400' : p.event_lag_secs < 3600 ? 'text-yellow-400' : 'text-slate-300'}`}>{fmtLag(p.event_lag_secs)}</span>
            </span>
          )}
          {p.last_run_duration_ms > 0 && (
            <span title="Wall-clock time for last batch (OpenSearch fetch + ClickHouse write)">
              Last batch: <span className="text-slate-300 font-medium">{fmtDuration(p.last_run_duration_ms)}</span>
            </span>
          )}
        </div>
        {p.last_error && (
          <div className="mt-2 text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded px-3 py-2">{p.last_error}</div>
        )}
      </div>

      {/* Index partitions */}
      {(partitions || []).length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
            <Database size={11} /> Physical Index Partitions
          </div>
          <div className="space-y-1.5">
            {partitions.map(part => (
              <div key={part.index_name} className="flex items-center gap-3 px-3 py-2 bg-slate-800/60 rounded-lg text-xs">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  part.status === 'running' ? 'bg-blue-400 animate-pulse'
                  : part.status === 'complete' ? 'bg-emerald-500'
                  : part.status === 'error' ? 'bg-red-500'
                  : 'bg-slate-600'
                }`} />
                <span className="font-mono text-slate-200 flex-1 truncate">{part.index_name}</span>
                <span className="text-slate-400 tabular-nums">{fmtNum(part.rows_inserted)} rows</span>
                {part.rows_dlq > 0 && <span className="text-amber-400">{fmtNum(part.rows_dlq)} DLQ</span>}
                {part.cursor_timestamp && <span className="text-slate-600 font-mono text-[10px]">{fmtTs(part.cursor_timestamp)}</span>}
                {part.last_error && <span className="text-red-400 truncate max-w-[200px]">{part.last_error.slice(0, 60)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reconciliation */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
            <GitCompare size={11} /> Reconciliation
            <span className="text-[10px] font-normal text-slate-600 normal-case tracking-normal">auto every 30s</span>
          </div>
          <button
            onClick={onRunReconcile}
            disabled={reconcilingId === p.id}
            title="Refresh now"
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-purple-300 disabled:opacity-50 transition-colors"
          >
            {reconcilingId === p.id ? (
              <><span className="w-3 h-3 border-2 border-slate-600 border-t-purple-400 rounded-full animate-spin" /> Checking…</>
            ) : (
              <><RefreshCw size={11} /></>
            )}
          </button>
        </div>
        {(!recon || recon.pending) && (
          <div className="text-xs text-slate-600 italic flex items-center gap-1.5">
            <span className="w-3 h-3 border-2 border-slate-700 border-t-purple-500 rounded-full animate-spin" />
            Checking source vs destination counts…
          </div>
        )}
        {recon && !recon.pending && (
          <div className="space-y-1.5">
            {recon.error && <div className="text-xs text-red-400">{recon.error}</div>}
            {(recon.indexes || []).map(ix => (
              <div key={ix.index} className="flex items-center gap-3 px-3 py-2 bg-slate-800/60 rounded-lg text-xs">
                <span className={`font-medium w-16 flex-shrink-0 ${
                  ix.status === 'MATCH' ? 'text-emerald-400'
                  : ix.status === 'MISMATCH' ? 'text-red-400'
                  : 'text-slate-400'
                }`}>{ix.status}</span>
                <span className="font-mono text-slate-300 flex-1 truncate">{ix.index}</span>
                <span className="text-slate-400">src: <span className="text-white">{ix.source_count?.toLocaleString() ?? '?'}</span></span>
                <span className="text-slate-400">dst: <span className="text-white">{ix.dest_count?.toLocaleString() ?? '?'}</span></span>
                {ix.status === 'MISMATCH' && <span className="text-red-400">Δ {Math.abs((ix.source_count||0) - (ix.dest_count||0)).toLocaleString()}</span>}
                {ix.error && <span className="text-red-400 truncate max-w-[200px]">{ix.error.slice(0, 60)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pipeline card ─────────────────────────────────────────────────────────────

function fmtLag(secs) {
  if (secs == null) return null;
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

function fmtDuration(ms) {
  if (!ms) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function PipelineCard({
  p, eps, acting, expanded, partitions, reconcileResult, reconcilingId,
  onToggleExpand, onAction, onTestRun, onRunNow, onRunReconcile, onDel, onResetStats, navigate,
}) {
  const isExpanded = expanded[p.id];

  const [chStats, setChStats] = useState(null);
  useEffect(() => {
    api.getChStats(p.id).then(s => setChStats(s)).catch(() => {});
  }, [p.id, p.last_success_at]); // refetch when pipeline completes a run

  return (
    <div className={`bg-slate-900 border rounded-xl overflow-hidden transition-all ${
      p.is_running ? 'border-blue-800/60'
      : p.run_status === 'error' ? 'border-red-800/40'
      : p.status === 'active' ? 'border-slate-700'
      : 'border-slate-800'
    }`}>
      {/* Card header */}
      <div className="flex items-start gap-4 px-5 py-4">
        {/* Status dot + name */}
        <div className="flex items-center gap-2.5 mt-0.5 flex-shrink-0">
          <StatusDot status={p.status} run={p.run_status} isRunning={p.is_running} />
        </div>

        <div className="flex-1 min-w-0">
          {/* Row 1: name + badge */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="font-semibold text-white truncate">{p.name}</span>
            <StatusBadge status={p.status} run={p.run_status} isRunning={p.is_running} />
            {(p.rows_dlq ?? 0) > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-400 bg-amber-950/40 border border-amber-800/40 px-2 py-0.5 rounded-full" title="Historical DLQ counter — rows that failed to insert. Use Reset Stats to clear.">
                <AlertTriangle size={10} /> {fmtNum(p.rows_dlq)} failed (historical)
              </span>
            )}
          </div>
          {p.description && (
            <div className="text-xs text-slate-500 mt-0.5 truncate">{p.description}</div>
          )}

          {/* Row 2: source → dest */}
          <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
            <span className="flex items-center gap-1 bg-slate-800 px-2 py-1 rounded-md">
              <Server size={10} className="text-slate-500" />
              <span className="text-slate-400">{p.connection_name || '—'}</span>
              <span className="text-slate-600 font-mono ml-1 truncate max-w-[140px]">{p.index_pattern}</span>
            </span>
            <ArrowRight size={11} className="text-slate-600 flex-shrink-0" />
            <span className="flex items-center gap-1 bg-slate-800 px-2 py-1 rounded-md">
              <Database size={10} className="text-slate-500" />
              <span className="text-slate-400">{p.cluster_name || '—'}</span>
              <span className="text-slate-600 font-mono ml-1">{p.clickhouse_database}.{p.clickhouse_table}</span>
            </span>
          </div>
        </div>

        {/* Stats block — CH Storage + Event Lag */}
        <div className="hidden sm:flex items-center gap-5 flex-shrink-0 text-center">
          <div>
            <div className="text-xs text-slate-500 mb-0.5">Rows (CH)</div>
            <div className="text-lg font-bold text-white tabular-nums">
              {chStats ? fmtNum(chStats.rows) : <span className="text-slate-600 text-sm">—</span>}
            </div>
          </div>
          <div className="w-px h-8 bg-slate-800" />
          <div>
            <div className="text-xs text-slate-500 mb-0.5">Uncompressed</div>
            <div className="text-sm font-semibold text-slate-300 tabular-nums">
              {chStats ? fmtBytes(chStats.uncompressed_bytes) : '—'}
            </div>
          </div>
          <div className="w-px h-8 bg-slate-800" />
          <div>
            <div className="text-xs text-slate-500 mb-0.5">Compressed</div>
            <div className="text-sm font-semibold text-emerald-400 tabular-nums">
              {chStats ? fmtBytes(chStats.compressed_bytes) : '—'}
            </div>
          </div>
          <div className="w-px h-8 bg-slate-800" />
          <div title="How far behind real-time the newest processed event is">
            <div className="text-xs text-slate-500 mb-0.5">Event Lag</div>
            <div className={`text-sm font-semibold tabular-nums ${
              p.event_lag_secs == null ? 'text-slate-600'
              : p.event_lag_secs < 60 ? 'text-emerald-400'
              : p.event_lag_secs < 3600 ? 'text-yellow-400'
              : 'text-slate-400'
            }`}>
              {p.event_lag_secs != null ? fmtLag(p.event_lag_secs) : '—'}
            </div>
          </div>
        </div>

        {/* Cursor + Last run */}
        <div className="hidden md:block flex-shrink-0 text-right text-xs space-y-1.5">
          <div>
            <div className="text-slate-500">Last run</div>
            <div className="text-slate-300 mt-0.5">{p.last_run_at ? fmtRelative(p.last_run_at) : '—'}</div>
            {p.last_success_at && (
              <div className="text-slate-600">ok {fmtRelative(p.last_success_at)}</div>
            )}
          </div>
          <div className="border-t border-slate-800/60 pt-1.5">
            <div className="text-slate-500 mb-0.5">Checkpoint saved</div>
            {p.checkpoint_committed_at ? (
              <div className="font-mono text-slate-300 text-[10px]">{fmtTs(p.checkpoint_committed_at)}</div>
            ) : (
              <div className="text-slate-600 text-[10px]">never</div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <IconBtn onClick={() => onTestRun(p)} disabled={acting[p.id]} title="Test run (no insert)">
            <FlaskConical size={13} className="text-brand-400" />
          </IconBtn>
          <IconBtn onClick={() => onRunNow(p)} disabled={acting[p.id]} title="Run now (insert)">
            <Zap size={13} className="text-yellow-400" />
          </IconBtn>
          {p.status === 'active' ? (
            <IconBtn onClick={() => onAction(api.pausePipeline, p.id)} disabled={acting[p.id]} title="Pause">
              <Pause size={13} className="text-slate-300" />
            </IconBtn>
          ) : (
            <IconBtn onClick={() => onAction(api.startPipeline, p.id)} disabled={acting[p.id]} title="Start">
              <Play size={13} className="text-emerald-400" />
            </IconBtn>
          )}
          <IconBtn onClick={() => onAction(() => api.resetCursor(p.id), p.id)} disabled={acting[p.id]} title="Reset cursor (re-pull from start)">
            <RotateCcw size={13} className="text-slate-400" />
          </IconBtn>
          <IconBtn onClick={() => onResetStats(p.id, p.name)} disabled={acting[p.id]} title="Reset stats (clear Today/Total/DLQ counters)">
            <RefreshCw size={13} className="text-slate-500" />
          </IconBtn>
          <IconBtn onClick={() => navigate(`/pipelines/${p.id}/edit`)} title="Edit">
            <Edit2 size={13} className="text-slate-400" />
          </IconBtn>
          <IconBtn onClick={() => onDel(p.id, p.name)} disabled={acting[p.id]} title="Delete">
            <Trash2 size={13} className="text-red-400" />
          </IconBtn>
          <div className="w-px h-5 bg-slate-800 mx-0.5" />
          <IconBtn onClick={() => onToggleExpand(p.id)} title={isExpanded ? 'Collapse details' : 'Expand details'}>
            {isExpanded ? <ChevronUp size={13} className="text-slate-400" /> : <ChevronDown size={13} className="text-slate-400" />}
          </IconBtn>
        </div>
      </div>

      {/* Mobile stats row */}
      <div className="sm:hidden flex flex-wrap items-center gap-3 px-5 pb-3 text-xs border-t border-slate-800/60 pt-3">
        {chStats && <span className="text-slate-500">CH: <span className="text-white font-medium">{fmtNum(chStats.rows)} rows</span></span>}
        {chStats && <span className="text-slate-500">{fmtBytes(chStats.uncompressed_bytes)} raw</span>}
        {p.event_lag_secs != null && <span className="text-slate-500">Lag: <span className="text-slate-300 font-medium">{fmtLag(p.event_lag_secs)}</span></span>}
        <span className="ml-auto text-slate-500 text-right">
          <span className="block text-[10px]">checkpoint</span>
          <span className="font-mono text-slate-400 text-[10px]">{p.checkpoint_committed_at ? fmtRelative(p.checkpoint_committed_at) : '—'}</span>
        </span>
      </div>

      {/* Expanded detail panel */}
      {isExpanded && (
        <DetailPanel
          p={p}
          eps={eps}
          partitions={partitions[p.id]}
          reconcileResult={reconcileResult}
          reconcilingId={reconcilingId}
          onRunReconcile={() => onRunReconcile(p)}
        />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Pipelines() {
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [acting, setActing] = useState({});
  const [result, setResult] = useState(null); // { pipeline, ok, msg, sample }
  const [expanded, setExpanded] = useState({});
  const [partitions, setPartitions] = useState({});
  const [reconcileResult, setReconcileResult] = useState({});
  const [reconcilingId, setReconcilingId] = useState(null);

  const eps = metrics?.ingestion?.last_60s?.events_per_sec ?? 0;

  const load = useCallback(async () => {
    const params = {};
    if (search) params.search = search;
    if (statusFilter) params.status = statusFilter;
    setList(await api.getPipelines(params));
  }, [search, statusFilter]);

  const loadMetrics = useCallback(async () => {
    try { setMetrics(await api.getMetrics()); } catch {}
  }, []);

  useEffect(() => {
    load();
    loadMetrics();
    const t1 = setInterval(load, 8000);
    const t2 = setInterval(loadMetrics, 5000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [load, loadMetrics]);

  async function action(fn, id) {
    setActing(a => ({ ...a, [id]: true }));
    try { await fn(id); await load(); } finally { setActing(a => ({ ...a, [id]: false })); }
  }

  async function testRun(p) {
    setActing(a => ({ ...a, [p.id]: true }));
    setResult({ pipeline: p.name, ok: null, msg: 'Pulling a sample (no insert)…' });
    try {
      const r = await api.testRun(p.id);
      const sample = JSON.stringify(r.sampleRows?.[0] || {}, null, 2);
      setResult({ pipeline: p.name, ok: true, msg: `Fetched ${r.fetched} docs. Sample transformed row:`, sample });
    } catch (e) {
      setResult({ pipeline: p.name, ok: false, msg: e.message });
    } finally {
      setActing(a => ({ ...a, [p.id]: false }));
    }
  }

  async function runNow(p) {
    if (p.is_running) {
      setResult({ pipeline: p.name, ok: false, msg: 'Already running — wait for it to finish or pause it first.' });
      return;
    }
    if (!p.cursor_timestamp) {
      const confirmed = window.confirm(
        `⚠️  No cursor saved for "${p.name}".\n\nThis will pull ALL logs from the beginning of the index and may re-insert rows already in ClickHouse.\n\nContinue?`
      );
      if (!confirmed) return;
    }
    setActing(a => ({ ...a, [p.id]: true }));
    setResult({ pipeline: p.name, ok: null, msg: 'Running — pulling and inserting into ClickHouse…' });
    try {
      const r = await api.runNow(p.id);
      if (r.alreadyRunning) {
        setResult({ pipeline: p.name, ok: false, msg: 'Already running — wait for it to finish or pause it first.' });
      } else if (r.fetched === 0) {
        const cpTs = p.cursor_timestamp ? ` (checkpoint: ${parseTs(p.cursor_timestamp)?.toLocaleString()})` : '';
        setResult({ pipeline: p.name, ok: true, msg: `Already caught up — no new events since last checkpoint${cpTs}.` });
      } else {
        setResult({
          pipeline: p.name,
          ok: true,
          msg: `Fetched ${r.fetched}, inserted ${r.inserted} rows.${r.dlq > 0 ? ` DLQ: ${r.dlq}.` : ''}${r.skipped > 0 ? ` Dedup-skipped: ${r.skipped}.` : ''}`,
        });
      }
      await load();
      await loadMetrics();
    } catch (e) {
      setResult({ pipeline: p.name, ok: false, msg: e.message });
    } finally {
      setActing(a => ({ ...a, [p.id]: false }));
    }
  }

  async function del(id, name) {
    if (!confirm(`Delete pipeline "${name}"?`)) return;
    await action(api.deletePipeline, id);
  }

  async function resetStats(id, name) {
    if (!confirm(`Reset stats for "${name}"?\n\nThis clears Today/Total/DLQ counters. It does NOT affect data in ClickHouse.`)) return;
    setActing(a => ({ ...a, [id]: true }));
    try { await api.resetStats(id); await load(); await loadMetrics(); } finally { setActing(a => ({ ...a, [id]: false })); }
  }

  async function toggleExpand(id) {
    const nowOpen = !expanded[id];
    setExpanded(e => ({ ...e, [id]: nowOpen }));
    if (nowOpen) {
      if (!partitions[id]) {
        try {
          const rows = await api.getPartitions(id);
          setPartitions(p => ({ ...p, [id]: rows }));
        } catch {}
      }
      // Auto-run reconciliation when opening
      const pipeline = list.find(p => p.id === id);
      if (pipeline) runReconcile(pipeline);
    }
  }

  // Refs so the interval callback always sees the latest values without being
  // in the dependency array (which would reset the timer on every poll/re-render).
  const expandedRef = useRef(expanded);
  const listRef     = useRef(list);
  const reconRef    = useRef(reconcilingId);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { listRef.current = list; }, [list]);
  useEffect(() => { reconRef.current = reconcilingId; }, [reconcilingId]);

  // Single stable 30s interval — created once, never reset by re-renders.
  useEffect(() => {
    const t = setInterval(() => {
      const openIds = Object.keys(expandedRef.current)
        .filter(id => expandedRef.current[id]).map(Number);
      for (const id of openIds) {
        const pipeline = listRef.current.find(p => p.id === id);
        if (pipeline && reconRef.current == null) runReconcile(pipeline);
      }
    }, 30000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function runReconcile(p) {
    setExpanded(e => ({ ...e, [p.id]: true }));
    if (!partitions[p.id]) {
      try { setPartitions(s => ({ ...s, [p.id]: [] })); } catch {}
    }
    setReconcilingId(p.id);
    setReconcileResult(s => ({ ...s, [p.id]: { pending: true } }));
    try {
      const r = await api.reconcile(p.id);
      setReconcileResult(s => ({ ...s, [p.id]: r }));
    } catch (e) {
      setReconcileResult(s => ({ ...s, [p.id]: { ok: false, error: e.message } }));
    } finally {
      setReconcilingId(null);
    }
  }

  const active = list.filter(p => p.status === 'active').length;
  const erroring = list.filter(p => p.run_status === 'error').length;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Pipelines</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {list.length} total
            {active > 0 && <span className="ml-2 text-emerald-400">{active} active</span>}
            {erroring > 0 && <span className="ml-2 text-red-400">{erroring} erroring</span>}
          </p>
        </div>
        <button
          onClick={() => navigate('/pipelines/new')}
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
        >
          <Plus size={15} /> New Pipeline
        </button>
      </div>

      {/* Metrics cards */}
      <MetricsBar metrics={metrics} />

      {/* Run result banner */}
      {result && (
        <div className={`mb-5 rounded-xl border px-4 py-3 ${
          result.ok === null ? 'bg-slate-800 border-slate-700'
          : result.ok ? 'bg-emerald-950/30 border-emerald-800/60'
          : 'bg-red-950/30 border-red-800/60'
        }`}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-white">{result.pipeline}</div>
              <div className={`text-xs mt-0.5 ${result.ok === false ? 'text-red-400' : 'text-slate-300'}`}>{result.msg}</div>
              {result.sample && (
                <pre className="mt-2 text-xs bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto text-slate-300 max-h-64">{result.sample}</pre>
              )}
            </div>
            <button onClick={() => setResult(null)} className="icon-btn flex-shrink-0"><X size={14} /></button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input w-full pl-9 text-sm"
            placeholder="Search pipelines…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="input text-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
        </select>
      </div>

      {/* Pipeline cards */}
      {list.length === 0 ? (
        <div className="text-center py-20 text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-xl">
          No pipelines.{' '}
          <button onClick={() => navigate('/pipelines/new')} className="text-brand-400 hover:underline">Create one →</button>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map(p => (
            <PipelineCard
              key={p.id}
              p={p}
              eps={eps}
              acting={acting}
              expanded={expanded}
              partitions={partitions}
              reconcileResult={reconcileResult}
              reconcilingId={reconcilingId}
              onToggleExpand={toggleExpand}
              onAction={action}
              onTestRun={testRun}
              onRunNow={runNow}
              onRunReconcile={runReconcile}
              onDel={del}
              onResetStats={resetStats}
              navigate={navigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
