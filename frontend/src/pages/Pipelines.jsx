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
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GiB';
  if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MiB';
  if (b >= 1024)       return (b / 1024).toFixed(1) + ' KiB';
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
  // Stopping = pause was requested but the in-process loop hasn't fully exited yet
  const stopping = isRunning && status === 'paused';
  if (stopping) return <span className="w-2.5 h-2.5 rounded-full bg-amber-500 flex-shrink-0" />;
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
  // Stopping = pause requested, loop still draining its current batch
  if (isRunning && status === 'paused') return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-950 text-amber-400 border border-amber-800/60">
      Stopping…
    </span>
  );
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

function MetricsBar({ metrics, chUncompressedTotal }) {
  if (!metrics) return null;
  const eps = metrics.ingestion?.last_60s?.events_per_sec ?? 0;
  const eps5 = metrics.ingestion?.last_5s?.events_per_sec ?? 0;
  const totalToday = metrics.pipelines?.rows_inserted_today ?? 0;
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
        <div className="text-xl font-bold text-white tabular-nums">{fmtBytes(chUncompressedTotal ?? 0)}</div>
        <div className="text-xs text-slate-600 mt-0.5">uncompressed in ClickHouse</div>
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

// ── Live run progress (chunk-queue, in-memory; polled) ─────────────────────────

const WORKER_STATUS_STYLE = {
  IDLE:       'text-slate-500',
  PROCESSING: 'text-brand-400',
  RETRYING:   'text-amber-400',
  COMPLETED:  'text-emerald-400',
  FAILED:     'text-red-400',
};
const FINAL_STATUS_STYLE = {
  COMPLETE:   'bg-emerald-950 text-emerald-400 border-emerald-800/60',
  INCOMPLETE: 'bg-amber-950 text-amber-400 border-amber-800/60',
  FAILED:     'bg-red-950 text-red-400 border-red-800/60',
  CANCELLED:  'bg-slate-800 text-slate-400 border-slate-700',
};
// Compact chunk-boundary label: HH:MM for short windows, MM/DD HH:MM when the window
// spans more than a day (so multi-day backfill chunks don't read as "12:29–10:14").
function chunkTime(iso, multiDay) {
  if (!iso) return '—';
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return multiDay ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hm}` : hm;
}

function RunProgress({ pipelineId, isRunning }) {
  const [prog, setProg] = useState(null);
  const [showChunks, setShowChunks] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const s = await api.getRunProgress(pipelineId);
        if (alive) setProg(s);
      } catch { /* ignore transient */ }
      // Poll fast while a run is live, slowly once it's terminal (to catch the next run).
      const delay = (prog?.running || isRunning) ? 1200 : 5000;
      if (alive) timer = setTimeout(tick, delay);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId, isRunning, prog?.running]);

  if (!prog) return null; // no chunk-queue run recorded for this pipeline

  const maxCompleted = Math.max(1, ...prog.workers.map(w => w.completed));
  const multiDay = (new Date(prog.window.to) - new Date(prog.window.from)) > 24 * 3600 * 1000;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
          <Activity size={11} /> Run Progress
          {prog.running
            ? <span className="text-[10px] font-normal text-brand-400 normal-case tracking-normal animate-pulse">live</span>
            : prog.final_status && (
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border normal-case tracking-normal ${FINAL_STATUS_STYLE[prog.final_status] || 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                  {prog.final_status}
                </span>
              )}
        </div>
        <div className="text-[10px] text-slate-500">
          {prog.index_routed
            ? `index-routed · ${prog.indices_discovered} indices`
            : 'full-pattern'}
          {prog.max_run_minutes > 0 && ` · max ${prog.max_run_minutes}m`}
        </div>
      </div>

      {/* Window + overall */}
      <div className="text-[10px] text-slate-500 mb-1.5">
        Window: <span className="font-mono text-slate-400">{fmtTs(prog.window.from)} → {fmtTs(prog.window.to)}</span>
        {'  ·  '}{prog.worker_count} workers · {prog.chunk_count} chunks
      </div>
      <div className="flex items-center gap-2 mb-2.5">
        <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${prog.failed > 0 ? 'bg-amber-500' : prog.running ? 'bg-brand-500' : 'bg-emerald-500'}`}
            style={{ width: `${prog.pct}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-slate-300 font-medium">{prog.complete}/{prog.total} ({prog.pct}%)</span>
        {prog.failed > 0 && <span className="text-[10px] text-red-400">{prog.failed} failed</span>}
      </div>

      {/* Per-worker bars — reflects the actual shared queue (completed counts differ) */}
      <div className="space-y-1">
        {prog.workers.map(w => (
          <div key={w.id} className="flex items-center gap-2 text-[11px]">
            <span className="w-14 flex-shrink-0 text-slate-400 font-mono">W{w.id}</span>
            <span className={`w-20 flex-shrink-0 font-medium ${WORKER_STATUS_STYLE[w.status] || 'text-slate-500'}`}>{w.status}</span>
            <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-brand-500/70 rounded-full transition-all" style={{ width: `${(w.completed / maxCompleted) * 100}%` }} />
            </div>
            <span className="w-10 flex-shrink-0 text-right tabular-nums text-slate-400">{w.completed}</span>
            <span className="w-40 flex-shrink-0 text-slate-500 font-mono truncate">
              {w.current_range ? `#${w.current_chunk} ${chunkTime(w.current_range.gte, multiDay)}–${chunkTime(w.current_range.end, multiDay)}` : (w.retries > 0 ? `${w.retries} retries` : '')}
            </span>
          </div>
        ))}
      </div>

      {/* Chunk breakdown (collapsible) */}
      <button
        onClick={() => setShowChunks(s => !s)}
        className="mt-2 flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
      >
        {showChunks ? <ChevronUp size={11} /> : <ChevronDown size={11} />} Chunk breakdown ({prog.total})
      </button>
      {showChunks && (
        <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1">
          {prog.chunks.map(c => {
            const col = c.state === 'COMPLETE' ? 'bg-emerald-950/40 border-emerald-800/50 text-emerald-300'
              : c.state === 'IN_PROGRESS' ? 'bg-brand-950/40 border-brand-800/50 text-brand-300'
              : c.state === 'FAILED' ? 'bg-red-950/40 border-red-800/50 text-red-300'
              : 'bg-slate-800/40 border-slate-700 text-slate-400';
            return (
              <div key={c.id} className={`px-2 py-1 rounded border text-[10px] font-mono ${col}`} title={`${c.state} · routed ${c.indices ?? 'all'} idx · inserted ${c.inserted}`}>
                #{c.id} {chunkTime(c.gte, multiDay)}–{chunkTime(c.end, multiDay)}
                {c.redistributions > 0 && <span className="text-amber-400"> ↻{c.redistributions}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Per-run compact history (pipeline detail panel) ──────────────────────────

function fmtDurSecs(s) {
  if (s == null) return null;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function RunHistory({ pipelineId, refreshKey }) {
  const [runs, setRuns] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setRuns(null);
    api.getRuns(pipelineId, 20)
      .then(r => setRuns(r.runs || []))
      .catch(() => setRuns([]));
  }, [pipelineId, refreshKey]);

  if (!runs) return (
    <div className="text-xs text-slate-600 italic flex items-center gap-1.5">
      <span className="w-3 h-3 border-2 border-slate-700 border-t-purple-500 rounded-full animate-spin" />
      Loading…
    </div>
  );
  if (!runs.length) return (
    <div className="text-xs text-slate-600 italic">No runs recorded yet.</div>
  );

  const visible = showAll ? runs : runs.slice(0, 5);

  return (
    <div className="space-y-1">
      <div className="overflow-hidden rounded-lg border border-slate-800/60">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-slate-800/40 text-slate-500">
              <th className="px-3 py-1.5 text-left font-medium">Time</th>
              <th className="px-3 py-1.5 text-left font-medium">Window</th>
              <th className="px-3 py-1.5 text-right font-medium">Inserted</th>
              <th className="px-3 py-1.5 text-right font-medium">Coverage</th>
              <th className="px-3 py-1.5 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run, i) => {
              const dur = run.started_at && run.finished_at
                ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000) : null;
              const pct = run.success_pct;
              const statusColor = run.status === 'complete' ? 'text-emerald-400'
                : run.status === 'failed' ? 'text-red-400'
                : run.status === 'cancelled' ? 'text-amber-400'
                : 'text-slate-400';
              const coverageColor = pct === 100 ? 'text-emerald-400'
                : pct != null && pct >= 95 ? 'text-amber-400' : 'text-red-400';
              const windowStr = run.from_ts && run.to_ts
                ? `${fmtTs(run.from_ts).split(',')[1]?.trim() ?? fmtTs(run.from_ts)} → ${fmtTs(run.to_ts).split(',')[1]?.trim() ?? fmtTs(run.to_ts)}`
                : '—';
              return (
                <tr key={run.id} className={`border-t border-slate-800/40 ${i === 0 ? 'bg-slate-800/20' : 'hover:bg-slate-800/10'} transition-colors`}>
                  <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">
                    {run.started_at ? fmtTs(run.started_at).split(',')[1]?.trim() ?? fmtTs(run.started_at) : '—'}
                    {dur != null && <span className="text-slate-700 ml-1">({fmtDurSecs(dur)})</span>}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-slate-600 text-[10px] whitespace-nowrap">{windowStr}</td>
                  <td className="px-3 py-1.5 text-right text-white font-medium">{(run.inserted ?? 0).toLocaleString()}</td>
                  <td className={`px-3 py-1.5 text-right font-medium ${coverageColor}`}>
                    {pct != null ? `${pct}%` : run.source_count == null ? '—' : 'pending'}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-medium ${statusColor}`}>
                    {run.status === 'complete' ? '✓' : run.status === 'failed' ? '✗' : run.status?.toUpperCase()}
                    {run.dlq > 0 && <span className="text-red-400 ml-1">DLQ:{run.dlq}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {runs.length > 5 && (
        <button onClick={() => setShowAll(s => !s)}
          className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors flex items-center gap-1 pl-1">
          {showAll ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          {showAll ? 'Show less' : `Show all ${runs.length} runs`}
        </button>
      )}
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
  const [runHistoryKey, setRunHistoryKey] = useState(0);
  const [healthWindow, setHealthWindow] = useState('24'); // hours; '' = all-time

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

      {/* Live run progress (chunk-queue) */}
      <RunProgress pipelineId={p.id} isRunning={p.is_running} />

      {/* Per-run reconciliation history */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
            <Activity size={11} /> Run History
          </div>
          <button
            onClick={() => setRunHistoryKey(k => k + 1)}
            title="Refresh run history"
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-purple-300 transition-colors"
          >
            <RefreshCw size={11} />
          </button>
        </div>
        <RunHistory pipelineId={p.id} refreshKey={runHistoryKey} />
      </div>

      {/* Overall Health */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
            <GitCompare size={11} /> Overall Health
            <span className="text-[10px] font-normal text-slate-600 normal-case tracking-normal">auto every 30s</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={healthWindow}
              onChange={e => { setHealthWindow(e.target.value); onRunReconcile(e.target.value); }}
              className="text-[10px] bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-slate-400 hover:text-white transition-colors"
            >
              <option value="1">Last 1 hour</option>
              <option value="6">Last 6 hours</option>
              <option value="24">Last 24 hours</option>
              <option value="168">Last 7 days</option>
              <option value="">All time</option>
            </select>
            <button
              onClick={() => onRunReconcile(healthWindow)}
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
        </div>
        {(!recon || recon.pending) && (
          <div className="text-xs text-slate-600 italic flex items-center gap-1.5">
            <span className="w-3 h-3 border-2 border-slate-700 border-t-purple-500 rounded-full animate-spin" />
            Checking source vs destination counts…
          </div>
        )}
        {recon && !recon.pending && (() => {
          const row = (recon.indexes || [])[0] || {};
          const src = recon.source?.count ?? row.source_count;
          const dst = recon.dest?.count ?? row.dest_count;
          const remaining = recon.remaining != null ? recon.remaining
            : (src != null && dst != null ? Math.max(0, src - dst) : null);
          const excess = recon.excess != null ? recon.excess
            : (src != null && dst != null ? Math.max(0, dst - src) : null);
          const isExcess = recon.overall === 'EXCESS' || (excess != null && excess > 0);
          // % ingested only makes sense while catching up. 100% only when exactly complete;
          // when dst > src we don't show a % (it's an over-count, not progress).
          const pct = !src || isExcess ? null
            : remaining === 0 ? 100
            : Math.min(99.9, Math.floor((dst / src) * 1000) / 10);
          const w = recon.window;
          const rowErr = recon.error || row.error;
          const verdict = recon.overall === 'MATCH' ? 'HEALTHY'
            : recon.overall === 'MISMATCH' ? 'PARTIAL'
            : recon.overall === 'EXCESS' ? 'EXCESS'
            : 'INCONCLUSIVE';
          const verdictColor = recon.overall === 'MATCH' ? 'text-emerald-400'
            : recon.overall === 'MISMATCH' ? 'text-amber-400'
            : recon.overall === 'EXCESS' ? 'text-orange-400'
            : 'text-slate-400';
          return (
            <div className="space-y-2">
              {rowErr && <div className="text-xs text-red-400">{rowErr}</div>}
              {w && (
                <div className="text-[10px] text-slate-500">
                  Window ({w.mode}): {w.from ? fmtTs(w.from) : '—'} → {w.to ? fmtTs(w.to) : 'now / all'}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 bg-slate-800/60 rounded-lg text-xs">
                <span className={`font-medium w-24 flex-shrink-0 ${verdictColor}`}>{verdict}</span>
                <span className="text-slate-400">Source (OpenSearch): <span className="text-white font-medium">{src?.toLocaleString() ?? '?'}</span></span>
                <span className="text-slate-400">Ingested (ClickHouse): <span className="text-white font-medium">{dst?.toLocaleString() ?? '?'}</span></span>
                {isExcess ? (
                  <span className="text-orange-400">
                    Excess: <span className="font-medium">+{excess.toLocaleString()}</span> <span className="text-slate-500">(ClickHouse has more — OpenSearch may have rotated old data via ILM)</span>
                  </span>
                ) : remaining != null && (
                  <span className={remaining > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                    Remaining: <span className="font-medium">{remaining.toLocaleString()}</span>
                  </span>
                )}
                {pct != null && <span className="text-slate-500">({pct}% ingested)</span>}
                {!isExcess && remaining > 0 && (
                  recon.eta_seconds != null
                    ? <span className="text-brand-400" title={`at ~${recon.eta_rate?.toLocaleString()} rows/sec net`}>ETA ~{fmtEtaSecs(recon.eta_seconds)}</span>
                    : <span className="text-slate-600">ETA calculating…</span>
                )}
              </div>
              {(recon.source || recon.dest) && (
                <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-500">
                  <div className="px-3 py-1.5 bg-slate-800/40 rounded">
                    Source span: <span className="font-mono text-slate-400">{recon.source?.oldest_ts ? fmtTs(recon.source.oldest_ts) : '—'}</span> → <span className="font-mono text-slate-400">{recon.source?.newest_ts ? fmtTs(recon.source.newest_ts) : '—'}</span>
                  </div>
                  <div className="px-3 py-1.5 bg-slate-800/40 rounded">
                    Ingested span: <span className="font-mono text-slate-400">{recon.dest?.oldest_ts ? fmtTs(recon.dest.oldest_ts) : '—'}</span> → <span className="font-mono text-slate-400">{recon.dest?.newest_ts ? fmtTs(recon.dest.newest_ts) : '—'}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
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

// Compact ETA from a second count: "3h 28m" / "45m" / "2m 10s" / "40s".
function fmtEtaSecs(secs) {
  if (secs == null || !isFinite(secs) || secs < 0) return '—';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.round((secs % 86400) / 3600)}h`;
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
          onRunReconcile={(windowHours) => onRunReconcile(p, windowHours)}
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
  const [chUncompressedTotal, setChUncompressedTotal] = useState(null);

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

  const loadChTotal = useCallback(async () => {
    try {
      const pipelines = await api.getPipelines();
      const results = await Promise.allSettled(pipelines.map(p => api.getChStats(p.id)));
      const total = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? (r.value?.uncompressed_bytes ?? 0) : 0), 0);
      setChUncompressedTotal(total);
    } catch {}
  }, []);

  useEffect(() => {
    load();
    loadMetrics();
    loadChTotal();
    const t1 = setInterval(load, 8000);
    const t2 = setInterval(loadMetrics, 5000);
    const t3 = setInterval(loadChTotal, 30000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [load, loadMetrics, loadChTotal]);

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
      if (pipeline) runReconcile(pipeline, '24');
    }
  }

  // Refs so the interval callback always sees the latest values without being
  // in the dependency array (which would reset the timer on every poll/re-render).
  const expandedRef = useRef(expanded);
  const listRef     = useRef(list);
  const reconRef    = useRef(reconcilingId);
  // Per-pipeline history of reconciliation snapshots, for ETA via ingested-count delta.
  const reconHistoryRef = useRef({}); // { [pipelineId]: [{ ingested, at }, …] }
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
        if (pipeline && reconRef.current == null) runReconcile(pipeline, '24');
      }
    }, 30000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function runReconcile(p, windowHours) {
    setExpanded(e => ({ ...e, [p.id]: true }));
    if (!partitions[p.id]) {
      try { setPartitions(s => ({ ...s, [p.id]: [] })); } catch {}
    }
    setReconcilingId(p.id);
    setReconcileResult(s => ({ ...s, [p.id]: { pending: true } }));
    try {
      // Pass explicit from/to when a health window is selected.
      const hours = windowHours != null ? windowHours : '24';
      const from = hours ? new Date(Date.now() - Number(hours) * 3600 * 1000).toISOString() : undefined;
      const to   = hours ? new Date().toISOString() : undefined;
      const r = await api.reconcile(p.id, from, to);

      // ── ETA via reconciliation delta ─────────────────────────────────────────
      // Rate = (ingested_now − ingested_earlier) / elapsed, using a short history so
      // one noisy 30s sample doesn't swing the estimate. ETA = remaining / rate.
      const ingested = r?.dest?.count ?? r?.indexes?.[0]?.dest_count;
      const remaining = r?.remaining;
      if (ingested != null && remaining != null && remaining > 0) {
        const now = Date.now();
        const hist = (reconHistoryRef.current[p.id] || []).concat([{ ingested, at: now }]);
        // Keep the last ~5 minutes of samples (≈10 at the 30s cadence).
        const trimmed = hist.filter(h => now - h.at <= 5 * 60 * 1000).slice(-12);
        reconHistoryRef.current[p.id] = trimmed;
        const oldest = trimmed[0];
        const elapsedSec = (now - oldest.at) / 1000;
        const gained = ingested - oldest.ingested;
        if (elapsedSec >= 15 && gained > 0) {
          const rate = gained / elapsedSec;           // rows/sec (net progress)
          r.eta_seconds = Math.round(remaining / rate);
          r.eta_rate = Math.round(rate);
        }
      } else if (remaining === 0) {
        reconHistoryRef.current[p.id] = []; // done — reset so a new run starts fresh
      }

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
      <MetricsBar metrics={metrics} chUncompressedTotal={chUncompressedTotal} />

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
