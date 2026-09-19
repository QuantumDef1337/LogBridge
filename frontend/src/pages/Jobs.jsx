import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Activity, CheckCircle2, XCircle, Clock, AlertTriangle, RefreshCw,
  ChevronDown, ChevronUp, RotateCcw, Trash2, CheckCircle, GitCompare,
  Copy, Check, Eraser, Search, Zap, AlertCircle, BarChart2, X, RotateCw,
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
    <div style={{
      display: 'flex', alignItems: 'center',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 10, padding: 3, gap: 2,
    }}>
      {['local', 'utc'].map(v => (
        <button key={v} onClick={() => onChange(v)} style={{
          padding: '4px 12px', borderRadius: 7,
          fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
          background: pref === v ? 'var(--teal)' : 'transparent',
          color: pref === v ? 'white' : 'var(--ink-3)',
          border: 'none', cursor: 'pointer',
          transition: 'all 200ms cubic-bezier(0.32,0.72,0,1)',
        }}>
          {v === 'utc' ? 'UTC' : 'Local'}
        </button>
      ))}
    </div>
  );
}

function StatusDot({ status }) {
  const colors = {
    running: 'var(--sky)',
    active:  'var(--mint)',
    error:   'var(--coral)',
    paused:  'var(--ink-4)',
  };
  const color = colors[status] || colors.paused;
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7,
      borderRadius: '50%', flexShrink: 0,
      background: color,
      boxShadow: status === 'running' ? `0 0 8px ${color}` : status === 'active' ? `0 0 6px ${color}` : 'none',
      animation: status === 'running' ? 'pulse-dot 2s ease-in-out infinite' : 'none',
    }} />
  );
}

function StatusLabel({ status }) {
  const colors = { running: 'var(--sky)', active: 'var(--mint)', error: 'var(--coral)', paused: 'var(--ink-3)' };
  return (
    <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'capitalize', color: colors[status] || 'var(--text-4)' }}>
      {status}
    </span>
  );
}

function LagBadge({ secs }) {
  if (secs == null) return null;
  const label = fmtLag(secs);
  const style = secs < 300
    ? { color: 'var(--mint)', background: 'var(--mint-tint)', border: '1px solid rgba(30,201,148,0.20)' }
    : secs < 3600
    ? { color: '#a37600', background: 'rgba(245,212,72,0.20)', border: '1px solid rgba(163,118,0,0.20)' }
    : { color: 'var(--coral)', background: 'var(--coral-tint)', border: '1px solid rgba(232,80,58,0.20)' };
  return (
    <span style={{
      fontSize: 10, fontFamily: '"JetBrains Mono", monospace',
      padding: '2px 7px', borderRadius: 999,
      ...style,
    }} title={`Event lag: ${label} behind live`}>
      {label} lag
    </span>
  );
}

function RpsStat({ batchSize, durationMs }) {
  if (!batchSize || !durationMs || durationMs <= 0) return null;
  const rps = Math.round(batchSize / (durationMs / 1000));
  if (!rps) return null;
  return (
    <span style={{
      fontSize: 10, fontFamily: '"JetBrains Mono", monospace',
      color: 'var(--teal)', display: 'flex', alignItems: 'center', gap: 3,
    }} title="Current rows/sec">
      <Zap size={9} />{fmtNum(rps)}/s
    </span>
  );
}

function ErrorBadge({ count, onClick }) {
  if (!count) return null;
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 5,
      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
      background: 'var(--coral-tint)', border: '1px solid rgba(232,80,58,0.22)',
      color: 'var(--coral)', cursor: 'pointer',
      transition: 'background 200ms',
    }} title={`${count} recent errors — click to view logs`}>
      <AlertCircle size={9} />{count} err
    </button>
  );
}

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
    <div style={{ marginTop: 8 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 10, color: 'var(--text-3)', marginBottom: 4,
      }}>
        <span style={{ fontFamily: '"JetBrains Mono", monospace' }}>
          {fmtNum(done)} / {fmtNum(total)} rows ({pct.toFixed(1)}%)
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {rps > 0 && <span style={{ color: '#22d3ee' }}>{fmtNum(Math.round(rps))}/s</span>}
          {etaSecs && <span style={{ color: '#fbbf24' }}>ETA {fmtEta(etaSecs)}</span>}
        </span>
      </div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

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
    <svg width={W} height={H} style={{ flexShrink: 0 }} title="rows/sec over time">
      <polyline points={pts} fill="none" stroke="#14b8a6" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" opacity="0.65" />
    </svg>
  );
}

function IndexProgress({ indexes, tz }) {
  if (!indexes || indexes.length === 0) return (
    <div style={{ fontSize: 11, color: 'var(--text-4)', fontStyle: 'italic', padding: '8px 0' }}>No per-index data yet</div>
  );
  const total = indexes.reduce((s, ix) => s + (ix.rows_inserted || 0), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {indexes.map(ix => {
        const pct = total > 0 ? Math.min(100, ((ix.rows_inserted || 0) / total) * 100) : 0;
        const statusColor = ix.status === 'running' ? '#60a5fa'
          : ix.status === 'done' ? '#34d399'
          : ix.last_error ? '#f87171' : 'var(--text-4)';
        return (
          <div key={ix.index_name}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontSize: 10, marginBottom: 3,
            }}>
              <span style={{
                fontFamily: '"JetBrains Mono", monospace', color: 'var(--text-2)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200,
              }} title={ix.index_name}>{ix.index_name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <span style={{ color: statusColor }}>{ix.status}</span>
                <span style={{ color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(ix.rows_inserted || 0)}</span>
                {ix.cursor_timestamp && <span style={{ color: 'var(--text-4)', fontFamily: '"JetBrains Mono", monospace' }}>{fmtTs(ix.cursor_timestamp, tz)}</span>}
              </div>
            </div>
            <div className="progress-track">
              <div style={{
                height: '100%', borderRadius: 999,
                width: `${pct}%`,
                background: ix.last_error ? '#ef4444' : ix.status === 'done' ? '#10b981' : '#3b82f6',
                transition: 'width 300ms',
              }} />
            </div>
            {ix.last_error && (
              <div style={{ fontSize: 10, color: '#f87171', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {ix.last_error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DlqPanel({ pipelineId, dlqCount, tz }) {
  const [entries, setEntries]   = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(false);
  const [expanded, setExpanded] = useState(null);

  const [retrying, setRetrying] = useState(false);

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

  async function retryAll() {
    if (!confirm('Retry all pending DLQ entries? This will attempt to re-insert them into ClickHouse.')) return;
    setRetrying(true);
    try {
      await api.retryDlq(pipelineId);
      await load();
    } catch (err) {
      console.error('DLQ retry failed', err);
    } finally {
      setRetrying(false);
    }
  }

  if (!dlqCount) return (
    <div style={{ fontSize: 12, color: 'var(--mint)', display: 'flex', alignItems: 'center', gap: 6 }}>
      <CheckCircle size={12} />No DLQ entries — all events processed cleanly
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 5 }}>
          <AlertTriangle size={12} />{total} DLQ {total === 1 ? 'entry' : 'entries'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={load} style={{ color: 'var(--text-4)', background: 'none', border: 'none', cursor: 'pointer' }}>
            <RefreshCw size={10} />
          </button>
          {total > 0 && (
            <button onClick={retryAll} disabled={retrying} style={{
              fontSize: 10, color: retrying ? 'var(--text-4)' : 'var(--teal)', background: 'none',
              border: '1px solid var(--teal)', padding: '2px 8px', borderRadius: 6, cursor: retrying ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 4,
              transition: 'color 200ms, border-color 200ms',
            }}>
              <RotateCw size={9} style={{ animation: retrying ? 'spin 1s linear infinite' : 'none' }} />
              {retrying ? 'Retrying…' : 'Retry all'}
            </button>
          )}
          {total > 0 && (
            <button onClick={dismissAll} style={{
              fontSize: 10, color: 'var(--text-3)', background: 'none',
              border: '1px solid var(--border)', padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
              transition: 'color 200ms',
            }}>
              Dismiss all
            </button>
          )}
        </div>
      </div>
      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entries.map(e => (
            <div key={e.id} style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10, padding: '10px 13px',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{
                      fontSize: 10, fontFamily: '"JetBrains Mono", monospace',
                      color: '#a37600', background: 'rgba(245,212,72,0.18)',
                      padding: '1px 6px', borderRadius: 5,
                    }}>{e.error_category}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-4)' }}>{fmtTs(e.first_failure_at, tz)}</span>
                    {e.retry_count > 0 && <span style={{ fontSize: 10, color: 'var(--text-4)' }}>{e.retry_count}× retried</span>}
                  </div>
                  <div style={{ fontSize: 12, color: '#fca5a5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.error_message}</div>
                  {e.source_index && <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3, fontFamily: '"JetBrains Mono", monospace' }}>index: {e.source_index}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {e.document_preview && (
                    <button onClick={() => setExpanded(expanded === e.id ? null : e.id)} style={{
                      fontSize: 10, color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer',
                    }}>
                      {expanded === e.id ? 'hide' : 'doc'}
                    </button>
                  )}
                  <button onClick={() => dismiss(e.id)} style={{ color: 'var(--text-4)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 200ms' }}
                    onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--text-4)'}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
              {expanded === e.id && e.document_preview && (
                <pre style={{
                  marginTop: 8, fontSize: 10, color: 'var(--ink-2)',
                  background: 'var(--canvas)', borderRadius: 7,
                  padding: '8px 10px', overflowX: 'auto', maxHeight: 120,
                  fontFamily: '"JetBrains Mono", monospace',
                }}>
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

// ─── Log line components ─────────────────────────────────────────────────────

function parseLogEntry(entry) {
  const match = entry.message?.match(/^\[(\w+)\]\s*/);
  return { category: match ? match[1] : null, body: match ? entry.message.slice(match[0].length) : entry.message };
}

const CATEGORY_STYLE = {
  pipeline:   { color: '#14b8a6' },
  connection: { color: '#22d3ee' },
  cluster:    { color: '#a78bfa' },
  system:     { color: 'var(--text-3)' },
};
const LEVEL_STYLE = {
  error: { color: '#f87171' },
  warn:  { color: '#fbbf24' },
  info:  { color: 'var(--text-2)' },
};

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
  function copy() {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return (
    <button onClick={copy} title="Copy" style={{
      opacity: 0, transition: 'opacity 200ms',
      color: 'var(--text-4)', background: 'none', border: 'none',
      cursor: 'pointer', flexShrink: 0, marginLeft: 4,
      display: 'flex', alignItems: 'center',
    }}
    className="log-copy-btn"
    >
      {copied ? <Check size={11} style={{ color: '#34d399' }} /> : <Copy size={11} />}
    </button>
  );
}

function LogLine({ entry, tz, jobsMap }) {
  const { category, body } = parseLogEntry(entry);
  const isSystem = !entry.pipeline_id || entry.pipeline_name === '[system]';
  const cat = CATEGORY_STYLE[category] || {};
  const lv  = LEVEL_STYLE[entry.level]  || LEVEL_STYLE.info;
  const job = jobsMap && entry.pipeline_id != null ? jobsMap.get(Number(entry.pipeline_id)) : null;
  const batchInfo = body ? parseBatchInsert(body) : null;
  const copyText = [fmtTs(entry.created_at, tz), entry.pipeline_name, category ? `[${category}]` : '', entry.level, body].filter(Boolean).join('  ');

  return (
    <div
      style={{
        padding: '5px 0',
        borderBottom: '1px solid var(--border-soft)',
        opacity: isSystem ? 0.75 : 1,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'var(--surface-alt)';
        const btn = e.currentTarget.querySelector('.log-copy-btn');
        if (btn) btn.style.opacity = '1';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent';
        const btn = e.currentTarget.querySelector('.log-copy-btn');
        if (btn) btn.style.opacity = '0';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 11, fontFamily: '"JetBrains Mono", monospace' }}>
        <span style={{ color: 'var(--text-4)', width: 160, flexShrink: 0 }}>{fmtTs(entry.created_at, tz)}</span>
        <span style={{
          width: 96, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontWeight: 600, color: isSystem ? 'var(--text-4)' : '#14b8a6',
        }}>{entry.pipeline_name}</span>
        {category && (
          <span style={{ width: 80, flexShrink: 0, ...cat }}>[{category}]</span>
        )}
        <span style={{ width: 36, flexShrink: 0, ...lv }}>{entry.level}</span>
        <span style={{ flex: 1, wordBreak: 'break-all', ...lv }}>{body}</span>
        <CopyButton text={copyText} />
      </div>
      {batchInfo && job && (
        <div style={{
          marginLeft: 316, marginTop: 3,
          display: 'flex', flexWrap: 'wrap', alignItems: 'center',
          gap: '3px 14px', fontSize: 10,
          fontFamily: '"JetBrains Mono", monospace',
        }}>
          {batchInfo.index && <span style={{ color: 'var(--text-3)' }}>from <span style={{ color: '#fbbf24' }}>{batchInfo.index}</span></span>}
          <span style={{ color: '#34d399' }}>→ {job.clickhouse_database}.{job.clickhouse_table}</span>
          <span style={{ color: 'var(--text-3)' }}>inserted <span style={{ color: 'var(--text-1)' }}>{batchInfo.inserted.toLocaleString()}</span></span>
          {batchInfo.skipped > 0 && <span style={{ color: '#fbbf24' }}>dedup-skipped {batchInfo.skipped.toLocaleString()}</span>}
          {batchInfo.fromTs && <span style={{ color: 'var(--text-4)' }}>from <span style={{ color: '#93c5fd' }}>{fmtTs(batchInfo.fromTs, tz)}</span></span>}
          {batchInfo.toTs && <span style={{ color: 'var(--text-4)' }}>to <span style={{ color: '#93c5fd' }}>{fmtTs(batchInfo.toTs, tz)}</span></span>}
        </div>
      )}
    </div>
  );
}

function CopyAllButton({ logs, tz }) {
  const [copied, setCopied] = useState(false);
  function copyAll() {
    const lines = logs.map(e => {
      const { category, body } = parseLogEntry(e);
      return [fmtTs(e.created_at, tz), e.pipeline_name, category ? `[${category}]` : '', e.level, body].filter(Boolean).join('  ');
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }
  return (
    <button onClick={copyAll} className="btn-ghost" style={{ fontSize: 11, padding: '5px 12px', gap: 5 }}>
      {copied ? <Check size={11} style={{ color: '#34d399' }} /> : <Copy size={11} />}
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
  const [activeTab, setActiveTab]         = useState({});
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
  const sparklines   = useRef(new Map());
  const prevJobs     = useRef(new Map());
  const [hasNew, setHasNew]               = useState(false);
  const [loadingOlder, setLoadingOlder]   = useState(false);
  const [hasOlder, setHasOlder]           = useState(true);

  function changeTz(v) { setTzPref(v); setTzState(v); }

  const loadJobs = useCallback(async () => {
    try {
      const fresh = await api.getJobs();
      fresh.forEach(job => {
        if (!job.last_batch_size || !job.last_run_duration_ms || job.last_run_duration_ms <= 0) return;
        const prev = prevJobs.current.get(job.id);
        if (prev && prev.rows_inserted_total === job.rows_inserted_total) return;
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

  const visibleLogs  = clearedAt.current ? logs.filter(e => e.created_at > clearedAt.current) : logs;
  const jobsMap      = new Map(jobs.map(j => [j.id, j]));
  const filteredJobs = search
    ? jobs.filter(j => j.name.toLowerCase().includes(search.toLowerCase()) || (j.index_pattern || '').toLowerCase().includes(search.toLowerCase()))
    : jobs;

  const running  = jobs.filter(j => j.is_running);
  const erroring = jobs.filter(j => !j.is_running && j.display_status === 'error');
  const active   = jobs.filter(j => !j.is_running && j.display_status === 'active');
  const paused   = jobs.filter(j => j.display_status === 'paused');

  function PipelineTab({ id, label, tab, badge }) {
    const isActive = activeTab[id] === tab;
    return (
      <button
        onClick={() => setActiveTab(t => ({ ...t, [id]: tab }))}
        style={{
          padding: '4px 12px', borderRadius: 8,
          fontSize: 11, fontWeight: 500,
          background: isActive ? 'var(--teal-tint)' : 'transparent',
          border: isActive ? '1px solid rgba(20,184,166,0.30)' : '1px solid transparent',
          color: isActive ? 'var(--teal)' : 'var(--ink-3)',
          cursor: 'pointer', transition: 'all 200ms',
          display: 'flex', alignItems: 'center', gap: 5,
        }}
      >
        {label}
        {badge > 0 && (
          <span style={{
            fontSize: 9, background: '#d97706', color: 'white',
            borderRadius: 999, padding: '1px 5px', fontWeight: 700,
          }}>{badge}</span>
        )}
      </button>
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ padding: '48px 48px 40px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
        <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--teal)', marginBottom: 8 }}>Jobs</div>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--ink)', lineHeight: 1, margin: 0 }}>Pipeline Execution</h1>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8, letterSpacing: '0.01em' }}>
            Live status and full audit trail
          </p>
        </div>
        <div style={{ paddingTop: 4 }}><TzToggle pref={tz} onChange={changeTz} /></div>
      </div>

      <div style={{ padding: '0 48px', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Summary metric band ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 4 }}>
        {[
          { label: 'Running now', value: running.length,  tone: 'sky',     accent: running.length > 0 ? 'var(--sky)' : 'var(--ink)' },
          { label: 'Active',      value: active.length,   tone: 'mint',    accent: active.length > 0 ? 'var(--mint)' : 'var(--ink)' },
          { label: 'Errors',      value: erroring.length, tone: 'coral',   accent: erroring.length > 0 ? 'var(--coral)' : 'var(--ink)' },
          { label: 'Paused',      value: paused.length,   tone: 'default', accent: 'var(--ink)' },
        ].map(({ label, value, tone, accent }) => {
          const bg = tone === 'sky' ? 'var(--sky-tint)' : tone === 'mint' ? 'var(--mint-tint)' : tone === 'coral' ? 'var(--coral-tint)' : 'var(--surface)';
          return (
            <div key={label} style={{
              background: bg,
              border: '1px solid var(--border)',
              borderRadius: 16, padding: '20px 22px',
              boxShadow: 'var(--shadow-card)',
            }}>
              <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1, color: accent, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 6 }}>{label}</div>
            </div>
          );
        })}
      </div>

      {/* ── Pipeline table ── */}
      <div className="card-shell">
        <div className="card-inner" style={{ overflow: 'hidden' }}>

          {/* Table header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 18px',
            borderBottom: '1px solid var(--border-soft)',
          }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)', flex: 1, margin: 0 }}>
              All Pipelines
            </h2>
            <div style={{ position: 'relative', flex: '0 0 240px' }}>
              <Search size={12} style={{
                position: 'absolute', left: 10, top: '50%',
                transform: 'translateY(-50%)', color: 'var(--text-4)', pointerEvents: 'none',
              }} />
              <input
                type="text" value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter by name or index…"
                className="input"
                style={{ paddingLeft: 30, fontSize: 12, padding: '6px 12px 6px 30px' }}
              />
            </div>
            <button onClick={loadJobs} className="icon-btn" title="Refresh">
              <RefreshCw size={13} />
            </button>
          </div>

          {/* Pipeline rows */}
          {filteredJobs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 24px', fontSize: 13, color: 'var(--text-3)' }}>
              {search ? 'No pipelines match your search.' : 'No pipelines configured yet.'}
            </div>
          ) : filteredJobs.map(job => {
            const sparkPts = sparklines.current.get(job.id) || [];
            const curTab   = activeTab[job.id] || 'logs';
            const dlqCount = job.rows_dlq || 0;

            return (
              <div key={job.id} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                {/* Pipeline row */}
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    padding: '12px 18px', cursor: 'pointer',
                    transition: 'background 180ms',
                  }}
                  onClick={() => toggleExpand(job.id)}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-alt)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <StatusDot status={job.display_status} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{job.name}</span>
                      <StatusLabel status={job.display_status} />
                      {job.is_running && (
                        <span style={{
                          fontSize: 10, color: 'var(--sky)',
                          background: 'var(--sky-tint)',
                          border: '1px solid rgba(96,165,250,0.22)',
                          padding: '2px 8px', borderRadius: 999,
                        }}>● Running</span>
                      )}
                      <LagBadge secs={job.event_lag_secs} />
                      <RpsStat batchSize={job.last_batch_size} durationMs={job.last_run_duration_ms} />
                      <ErrorBadge count={job.consecutive_errors}
                        onClick={e => { e.stopPropagation(); setExpanded(x => ({ ...x, [job.id]: true })); setActiveTab(t => ({ ...t, [job.id]: 'logs' })); refreshPipelineLogs(job.id); }} />
                      {dlqCount > 0 && (
                        <button onClick={e => { e.stopPropagation(); setExpanded(x => ({ ...x, [job.id]: true })); setActiveTab(t => ({ ...t, [job.id]: 'dlq' })); }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 5,
                            fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                            background: 'rgba(245,212,72,0.18)', border: '1px solid rgba(163,118,0,0.22)',
                            color: '#a37600', cursor: 'pointer',
                          }}>
                          <AlertTriangle size={9} />{fmtNum(dlqCount)} DLQ
                        </button>
                      )}
                    </div>
                    <div style={{
                      fontSize: 11, color: 'var(--text-3)', marginTop: 3,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: '"JetBrains Mono", monospace',
                    }}>
                      {job.connection_name} → {job.index_pattern} → {job.clickhouse_database}.{job.clickhouse_table}
                    </div>
                    <EtaBar job={job} />
                  </div>

                  {/* Right metrics */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 11, flexShrink: 0 }}>
                    {sparkPts.length >= 2 && <Sparkline data={sparkPts} />}

                    {[
                      { label: 'Today', val: fmtNum(job.rows_inserted_today) },
                      { label: 'Total', val: fmtNum(job.rows_inserted_total) },
                      { label: 'Data',  val: fmtBytes(job.bytes_processed) },
                    ].map(({ label, val }) => (
                      <div key={label} style={{ textAlign: 'center', minWidth: 52 }}>
                        <div style={{ fontSize: 9.5, color: 'var(--text-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
                        <div style={{ color: 'var(--text-1)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
                      </div>
                    ))}

                    <div style={{ textAlign: 'center', minWidth: 72 }}>
                      <div style={{ fontSize: 9.5, color: 'var(--text-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Last run</div>
                      <div style={{ color: 'var(--text-1)', fontWeight: 600 }}>{fmtRelative(job.last_run_at)}</div>
                    </div>

                    <div style={{ textAlign: 'center', minWidth: 130 }}>
                      <div style={{ fontSize: 9.5, color: 'var(--text-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Checkpoint</div>
                      <div style={{
                        color: 'var(--text-1)', fontWeight: 600,
                        fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140,
                      }}>
                        {job.cursor_timestamp ? fmtTs(job.cursor_timestamp, tz) : 'none'}
                      </div>
                    </div>

                    <button
                      onClick={e => { e.stopPropagation(); resetStats(job); }}
                      disabled={resetting[job.id]}
                      className="icon-btn"
                      title="Reset row counters"
                      style={{ color: 'rgba(251,191,36,0.35)' }}
                      onMouseEnter={e => { e.stopPropagation(); e.currentTarget.style.color = '#fbbf24'; }}
                      onMouseLeave={e => e.currentTarget.style.color = 'rgba(251,191,36,0.35)'}
                    >
                      <RotateCcw size={13} />
                    </button>
                    <span style={{ color: 'var(--text-4)' }}>
                      {expanded[job.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </span>
                  </div>
                </div>

                {/* Expanded detail — CSS spring expand (grid-template-rows trick)
                    Animates height smoothly without layout thrash or JS height
                    measurement. Apple principle: motion from current value, spring
                    easing, interruptible. */}
                <div className={`expand-spring${expanded[job.id] ? ' is-open' : ''}`}
                  style={{ borderTop: expanded[job.id] ? '1px solid var(--border-soft)' : 'none' }}
                >
                  <div className="expand-inner">
                  <div style={{
                    padding: '16px 20px 20px',
                    background: 'var(--surface-alt)',
                  }}>
                    {job.last_error && job.display_status === 'error' && (
                      <div style={{
                        marginBottom: 12, padding: '10px 14px',
                        background: 'var(--coral-tint)',
                        border: '1px solid rgba(232,80,58,0.20)',
                        borderRadius: 10, fontSize: 12, color: 'var(--coral)',
                      }}>
                        <span style={{ fontWeight: 600 }}>Last error:</span> {job.last_error}
                      </div>
                    )}

                    {/* Stats strip */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 14 }}>
                      {[
                        ['Last batch', job.last_batch_size > 0 ? fmtNum(job.last_batch_size) + ' rows' : '—'],
                        ['Batch time', job.last_run_duration_ms > 0 ? (job.last_run_duration_ms / 1000).toFixed(1) + 's' : '—'],
                        ['Rows week',  fmtNum(job.rows_inserted_week ?? 0)],
                        ['Dedup-skip', fmtNum(job.rows_skipped_dedup ?? 0)],
                        ['DLQ total',  fmtNum(dlqCount)],
                        ['Data',       fmtBytes(job.bytes_processed)],
                      ].map(([label, val]) => (
                        <div key={label} style={{
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 9, padding: '8px 12px',
                        }}>
                          <div style={{ fontSize: 9.5, color: 'var(--text-4)', marginBottom: 4, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
                        </div>
                      ))}
                    </div>

                    {/* Tabs */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 4, marginBottom: 14,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 10, padding: 4, width: 'fit-content',
                    }}>
                      <PipelineTab id={job.id} label="Recent Logs" tab="logs" />
                      <PipelineTab id={job.id} label="DLQ" tab="dlq" badge={dlqCount} />
                      <PipelineTab id={job.id} label="Indexes" tab="indexes" />
                      <PipelineTab id={job.id} label="Reconcile" tab="recon" />
                    </div>

                    {/* Tab: Logs */}
                    {curTab === 'logs' && (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>Recent log entries</span>
                          <button onClick={() => refreshPipelineLogs(job.id)} className="icon-btn" style={{ width: 24, height: 24 }}>
                            <RefreshCw size={11} />
                          </button>
                        </div>
                        <div style={{
                          background: 'var(--canvas)',
                          border: '1px solid var(--border)',
                          borderRadius: 10, overflow: 'hidden',
                        }}>
                          {(pipelineLogs[job.id] || []).length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '16px', fontSize: 11, color: 'var(--text-4)' }}>No log entries yet</div>
                          ) : (
                            <div style={{ maxHeight: 224, overflowY: 'auto' }}>
                              {(pipelineLogs[job.id] || []).map(entry => {
                                const { body } = parseLogEntry(entry);
                                return (
                                  <div key={entry.id} style={{
                                    display: 'flex', alignItems: 'flex-start', gap: 12,
                                    padding: '5px 12px', fontSize: 11,
                                    fontFamily: '"JetBrains Mono", monospace',
                                    background: entry.level === 'error' ? 'rgba(248,113,113,0.05)' : 'transparent',
                                    borderBottom: '1px solid var(--border-soft)',
                                  }}>
                                    <span style={{ color: 'var(--text-4)', flexShrink: 0 }}>{fmtTs(entry.created_at, tz)}</span>
                                    <span style={{
                                      width: 32, flexShrink: 0,
                                      color: entry.level === 'error' ? '#f87171' : entry.level === 'warn' ? '#fbbf24' : 'var(--text-4)',
                                    }}>{entry.level}</span>
                                    <span style={{
                                      flex: 1, wordBreak: 'break-all',
                                      color: entry.level === 'error' ? '#fca5a5' : 'var(--text-2)',
                                    }}>{body}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {curTab === 'dlq' && <DlqPanel pipelineId={job.id} dlqCount={dlqCount} tz={tz} />}

                    {curTab === 'indexes' && (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>Per-index progress</span>
                          <button onClick={() => refreshIndexes(job.id)} className="icon-btn" style={{ width: 24, height: 24 }}>
                            <RefreshCw size={11} />
                          </button>
                        </div>
                        <div style={{
                          background: 'var(--canvas)', border: '1px solid var(--border)',
                          borderRadius: 10, padding: '12px 14px',
                        }}>
                          <IndexProgress indexes={pipelineIndexes[job.id]} tz={tz} />
                        </div>
                      </div>
                    )}

                    {curTab === 'recon' && (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: 'var(--text-2)' }}>
                            <GitCompare size={12} style={{ color: 'var(--text-3)' }} />
                            Reconciliation
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            {pipelineRecon[job.id]?.checkedAt && (
                              <span style={{ fontSize: 10, color: 'var(--text-4)' }}>
                                checked {pipelineRecon[job.id].checkedAt.toLocaleTimeString()}
                              </span>
                            )}
                            <button onClick={() => runReconcile(job.id)} disabled={pipelineRecon[job.id]?.loading} className="icon-btn" style={{ width: 24, height: 24 }}>
                              <RefreshCw size={11} style={{ animation: pipelineRecon[job.id]?.loading ? 'spin 1s linear infinite' : 'none' }} />
                            </button>
                          </div>
                        </div>
                        {(() => {
                          const recon = pipelineRecon[job.id];
                          if (!recon || recon.loading) return (
                            <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <RefreshCw size={10} /> Checking…
                            </div>
                          );
                          if (recon.error) return <div style={{ fontSize: 11, color: '#f87171' }}>{recon.error}</div>;
                          if (!recon.result) return null;
                          const { overall, indexes } = recon.result;
                          const overallStyle = overall === 'MATCH'
                            ? { color: '#34d399', background: 'rgba(52,211,153,0.10)', border: '1px solid rgba(52,211,153,0.22)' }
                            : overall === 'MISMATCH'
                            ? { color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.22)' }
                            : { color: 'var(--text-2)', background: 'var(--bg-overlay)', border: '1px solid var(--border)' };
                          return (
                            <div>
                              <div style={{
                                display: 'inline-flex', alignItems: 'center', gap: 6,
                                padding: '3px 10px', borderRadius: 999,
                                fontSize: 10, fontWeight: 700, marginBottom: 10, ...overallStyle,
                              }}>
                                {overall === 'MATCH' ? <CheckCircle size={10} /> : overall === 'MISMATCH' ? <XCircle size={10} /> : <AlertTriangle size={10} />}
                                {overall}
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {indexes.map((ix, i) => (
                                  <div key={i} style={{
                                    display: 'flex', alignItems: 'center', gap: 10,
                                    fontSize: 10, fontFamily: '"JetBrains Mono", monospace',
                                    background: 'var(--surface)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 7, padding: '5px 10px',
                                  }}>
                                    <span style={{
                                      width: 64, flexShrink: 0, fontWeight: 700,
                                      color: ix.status === 'MATCH' ? '#34d399' : ix.status === 'MISMATCH' ? '#f87171' : 'var(--text-3)',
                                    }}>{ix.status}</span>
                                    <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{ix.index}</span>
                                    <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>OS <span style={{ color: 'var(--text-1)' }}>{ix.source_count?.toLocaleString() ?? '?'}</span></span>
                                    <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>CH <span style={{ color: 'var(--text-1)' }}>{ix.dest_count?.toLocaleString() ?? '?'}</span></span>
                                    {ix.status === 'MISMATCH' && <span style={{ color: '#fbbf24', flexShrink: 0 }}>Δ {Math.abs((ix.source_count ?? 0) - (ix.dest_count ?? 0)).toLocaleString()}</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>{/* /padding wrapper */}
                  </div>{/* /expand-inner */}
                </div>{/* /expand-spring */}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Live Audit Feed ── */}
      <div className="card-shell">
        <div className="card-inner" style={{ overflow: 'hidden' }}>

          {/* Feed header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 18px',
            borderBottom: '1px solid var(--border-soft)',
            flexWrap: 'wrap',
          }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)', flex: 1, margin: 0 }}>
              Live Audit Feed
              {hasNew && !autoScroll && (
                <span style={{
                  marginLeft: 10, fontSize: 10, color: 'var(--teal)',
                  animation: 'pulse-dot 2s ease-in-out infinite',
                }}>● new entries</span>
              )}
            </h2>

            <select
              className="select"
              style={{ width: 130, padding: '5px 28px 5px 10px', fontSize: 11 }}
              value={levelFilter}
              onChange={e => setLevelFilter(e.target.value)}
            >
              <option value="">All levels</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error only</option>
            </select>

            <select
              className="select"
              style={{ width: 200, padding: '5px 28px 5px 10px', fontSize: 11 }}
              value={logFilter}
              onChange={e => setLogFilter(e.target.value)}
            >
              <option value="">All pipelines + system</option>
              {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>

            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11, color: 'var(--text-3)', cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
              <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
              Auto-scroll
            </label>

            <button onClick={clearFeed} className="btn-ghost" style={{ fontSize: 11, padding: '5px 12px', gap: 5 }}>
              <Eraser size={11} />Reset
            </button>

            <CopyAllButton logs={visibleLogs} tz={tz} />
          </div>

          {/* Category legend */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 16,
            padding: '7px 18px',
            borderBottom: '1px solid var(--border-soft)',
            fontSize: 10, color: 'var(--ink-3)',
            fontFamily: '"JetBrains Mono", monospace',
            flexWrap: 'wrap',
          }}>
            <span style={{ color: '#14b8a6', fontWeight: 600 }}>[pipeline]</span><span>start · stop · run · edit</span>
            <span style={{ color: '#22d3ee', fontWeight: 600 }}>[connection]</span><span>OpenSearch source config</span>
            <span style={{ color: '#a78bfa', fontWeight: 600 }}>[cluster]</span><span>ClickHouse destination config</span>
            <span style={{ color: '#fbbf24', marginLeft: 8 }}>warn = destructive</span>
            <span style={{ color: '#f87171' }}>error = failure</span>
          </div>

          {/* Log stream */}
          <div
            ref={logRef}
            style={{
              height: 520, overflowY: 'auto',
              background: 'var(--surface-alt)',
              padding: '8px 18px',
            }}
            onScroll={e => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (atBottom) setHasNew(false);
              setAutoScroll(atBottom);
              if (el.scrollTop < 80 && hasOlder && !loadingOlder) loadOlderLogs();
            }}
          >
            {visibleLogs.length > 0 && (
              <div style={{ textAlign: 'center', padding: '8px 0 12px' }}>
                {hasOlder ? (
                  <button
                    onClick={loadOlderLogs}
                    disabled={loadingOlder}
                    style={{
                      fontSize: 10, color: 'var(--text-3)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      padding: '3px 12px', background: 'none', cursor: 'pointer',
                      transition: 'color 200ms', opacity: loadingOlder ? 0.4 : 1,
                    }}
                  >
                    {loadingOlder ? 'Loading…' : '↑ Load older logs'}
                  </button>
                ) : (
                  <span style={{ fontSize: 10, color: 'var(--text-4)' }}>— beginning of log history —</span>
                )}
              </div>
            )}
            {visibleLogs.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-4)', textAlign: 'center', padding: '48px 0', fontFamily: '"JetBrains Mono", monospace' }}>
                {clearedAt.current ? 'Feed cleared — new events will appear here.' : 'No events yet — actions appear here immediately.'}
              </div>
            ) : visibleLogs.map(entry => (
              <LogLine key={entry.id} entry={entry} tz={tz} jobsMap={jobsMap} />
            ))}
          </div>

          {/* Feed footer */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 18px',
            borderTop: '1px solid var(--border-soft)',
            fontSize: 10, color: 'var(--text-4)',
            fontFamily: '"JetBrains Mono", monospace',
          }}>
            <span>
              {visibleLogs.length.toLocaleString()} entries · polling 1.5s
              {clearedAt.current && <span style={{ marginLeft: 10, color: 'var(--text-4)' }}>cleared {new Date(clearedAt.current).toLocaleTimeString()}</span>}
            </span>
            <a href="/log-history" style={{
              color: 'var(--text-4)', textDecoration: 'none', transition: 'color 200ms',
              fontFamily: 'inherit',
            }}
            onMouseEnter={e => e.currentTarget.style.color = '#14b8a6'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-4)'}
            >
              View full log history →
            </a>
          </div>
        </div>
      </div>

      </div>{/* /padding wrapper */}
    </div>
  );
}
