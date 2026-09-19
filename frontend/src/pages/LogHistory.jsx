import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Download, RefreshCw, ChevronLeft, ChevronRight, Filter, X, Activity, FileText } from 'lucide-react';
import { api } from '../api';
import { fmtTs, getTzPref, setTzPref } from '../utils/time';

function TzToggle({ pref, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, border: '1px solid var(--border)', borderRadius: 8, padding: 2, background: 'var(--surface)' }}>
      {['local', 'utc'].map(v => (
        <button key={v} onClick={() => onChange(v)}
          style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: pref === v ? '1px solid rgba(20,184,166,0.40)' : '1px solid transparent', background: pref === v ? 'var(--teal-tint)' : 'transparent', color: pref === v ? 'var(--teal)' : 'var(--ink-3)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {v === 'utc' ? 'UTC' : 'Local'}
        </button>
      ))}
    </div>
  );
}

const LEVEL_COLORS = {
  error: { background: 'rgba(232,80,58,0.06)' },
  warn:  { background: 'rgba(245,212,72,0.08)' },
  info:  {},
};

const LEVEL_BADGE = {
  error: { background: 'var(--coral-tint)', color: 'var(--coral)', border: '1px solid rgba(232,80,58,0.30)' },
  warn:  { background: 'rgba(245,212,72,0.18)', color: '#a37600', border: '1px solid rgba(163,118,0,0.25)' },
  info:  { background: 'var(--surface-alt)', color: 'var(--ink-3)', border: '1px solid var(--border)' },
};

function parseBatchInsert(body) {
  const m = body.match(/Batch inserted:\s*([\d,]+)\s*rows/i);
  if (!m) return null;
  const fromM  = body.match(/from:(\d{4}-\d{2}-\d{2}[T ][\d:.]+)/);
  const toM    = body.match(/to:(\d{4}-\d{2}-\d{2}[T ][\d:.]+)/);
  const indexM = body.match(/index:(\S+)/);
  return {
    inserted: parseInt(m[1].replace(/,/g, '')),
    fromTs: fromM?.[1] || null,
    toTs:   toM?.[1]   || null,
    index:  indexM?.[1]|| null,
  };
}

function LogRow({ entry, tz }) {
  const [expanded, setExpanded] = useState(false);
  const batch = parseBatchInsert(entry.message || '');
  const hasDetail = batch && (batch.index || batch.fromTs);

  return (
    <>
      <tr
        style={{ borderBottom: '1px solid var(--border-soft)', cursor: hasDetail ? 'pointer' : 'default', transition: 'background 150ms', ...(LEVEL_COLORS[entry.level] || {}) }}
        onClick={() => hasDetail && setExpanded(e => !e)}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-alt)'}
        onMouseLeave={e => e.currentTarget.style.background = (LEVEL_COLORS[entry.level] || {}).background || 'transparent'}
      >
        <td style={{ padding: '6px 16px', fontSize: 11, fontFamily: '"JetBrains Mono", monospace', color: 'var(--ink-3)', whiteSpace: 'nowrap', width: 176 }}>{fmtTs(entry.created_at, tz)}</td>
        <td style={{ padding: '6px 12px', width: 128 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--teal)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 120 }} title={entry.pipeline_name}>{entry.pipeline_name}</span>
        </td>
        <td style={{ padding: '6px 12px', width: 64 }}>
          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 6, ...(LEVEL_BADGE[entry.level] || LEVEL_BADGE.info) }}>{entry.level}</span>
        </td>
        <td style={{ padding: '6px 12px', fontSize: 11, fontFamily: '"JetBrains Mono", monospace', color: 'var(--ink-2)', maxWidth: 0 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.message}</div>
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr style={{ background: 'var(--surface-alt)', borderBottom: '1px solid var(--border-soft)' }}>
          <td colSpan={4} style={{ padding: '8px 32px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 11, fontFamily: '"JetBrains Mono", monospace', color: 'var(--ink-3)' }}>
              {batch.index && <span>index: <span style={{ color: '#a37600' }}>{batch.index}</span></span>}
              {batch.fromTs && <span>from: <span style={{ color: 'var(--sky)' }}>{fmtTs(batch.fromTs, tz)}</span></span>}
              {batch.toTs && <span>to: <span style={{ color: 'var(--sky)' }}>{fmtTs(batch.toTs, tz)}</span></span>}
              {batch.inserted && <span>inserted: <span style={{ color: 'var(--mint)', fontWeight: 600 }}>{batch.inserted.toLocaleString()}</span></span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function fmtDurSecs(started, finished) {
  if (!started || !finished) return null;
  const s = Math.round((new Date(finished) - new Date(started)) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function RunHistoryTab({ tz }) {
  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [pipelineId, setPipelineId] = useState('');
  const [jobs, setJobs] = useState([]);
  const [expanded, setExpanded] = useState({});
  const limit = 50;

  useEffect(() => { api.getJobs().then(setJobs).catch(() => {}); }, []);

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params = { page: p, limit };
      if (pipelineId) params.pipeline_id = pipelineId;
      const data = await api.getAllRuns(params);
      setRuns(data.runs || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setPage(data.page || 1);
    } catch {} finally { setLoading(false); }
  }, [pipelineId]);

  useEffect(() => { load(1); }, [pipelineId]);

  function goPage(p) { if (p >= 1 && p <= pages) load(p); }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: 'var(--surface)', marginBottom: 12 }}>
        <Filter size={13} className="text-slate-500" />
        <select value={pipelineId} onChange={e => setPipelineId(e.target.value)} className="input" style={{ fontSize: 12, height: 32, width: 220, flexShrink: 0 }}>
          <option value="">All pipelines</option>
          {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
        <button onClick={() => load(1)} disabled={loading}
          className="btn-ghost" style={{ fontSize: 11, gap: 6, marginLeft: 'auto', opacity: loading ? 0.4 : 1 }}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{total.toLocaleString()} total runs</span>
      </div>

      {/* Table */}
      <div className="card-shell" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            {total > 0 ? `Showing ${((page-1)*limit+1).toLocaleString()}–${Math.min(page*limit,total).toLocaleString()} of ${total.toLocaleString()}` : 'No runs'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button onClick={() => goPage(1)} disabled={page<=1||loading} className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, opacity: page<=1||loading ? 0.3 : 1 }}>«</button>
            <button onClick={() => goPage(page-1)} disabled={page<=1||loading} className="btn-ghost" style={{ padding: '4px 6px', opacity: page<=1||loading ? 0.3 : 1 }}><ChevronLeft size={13}/></button>
            <span style={{ fontSize: 11, color: 'var(--ink-3)', padding: '0 8px' }}>Page {page} of {pages}</span>
            <button onClick={() => goPage(page+1)} disabled={page>=pages||loading} className="btn-ghost" style={{ padding: '4px 6px', opacity: page>=pages||loading ? 0.3 : 1 }}><ChevronRight size={13}/></button>
            <button onClick={() => goPage(pages)} disabled={page>=pages||loading} className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, opacity: page>=pages||loading ? 0.3 : 1 }}>»</button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' }}>
                {['Started','Pipeline','Window','Fetched','Inserted','Dedup','Coverage','Duration','Status'].map((h,i) => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: i >= 3 ? (i === 8 ? 'center' : 'right') : 'left', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && !runs.length ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-500 text-sm">Loading…</td></tr>
              ) : !runs.length ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-500 text-sm">No run history yet. Runs appear here after the pipeline executes.</td></tr>
              ) : runs.map(run => {
                const isExpanded = expanded[run.id];
                const statusColor = run.status === 'complete' ? 'var(--mint)'
                  : run.status === 'failed' ? 'var(--coral)'
                  : run.status === 'cancelled' ? '#a37600'
                  : 'var(--ink-3)';
                const pct = run.success_pct;
                const coverageColor = pct === 100 ? 'var(--mint)'
                  : pct != null && pct >= 95 ? '#a37600' : pct != null ? 'var(--coral)' : 'var(--ink-3)';
                const dur = fmtDurSecs(run.started_at, run.finished_at);
                return (
                  <React.Fragment key={run.id}>
                    <tr
                      style={{ borderBottom: '1px solid var(--border-soft)', cursor: 'pointer', transition: 'background 150ms' }}
                      onClick={() => setExpanded(e => ({ ...e, [run.id]: !e[run.id] }))}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-alt)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '7px 16px', fontSize: 11, fontFamily: '"JetBrains Mono", monospace', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{fmtTs(run.started_at, tz)}</td>
                      <td style={{ padding: '7px 12px', fontSize: 11, fontWeight: 600, color: 'var(--teal)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>{run.pipeline_name}</td>
                      <td style={{ padding: '7px 12px', fontSize: 10, fontFamily: '"JetBrains Mono", monospace', color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>
                        {run.from_ts ? fmtTs(run.from_ts, tz) : '—'} → {run.to_ts ? fmtTs(run.to_ts, tz) : '—'}
                      </td>
                      <td style={{ padding: '7px 12px', fontSize: 11, textAlign: 'right', color: 'var(--ink-3)' }}>{(run.fetched ?? 0).toLocaleString()}</td>
                      <td style={{ padding: '7px 12px', fontSize: 11, textAlign: 'right', color: 'var(--ink)', fontWeight: 600 }}>{(run.inserted ?? 0).toLocaleString()}</td>
                      <td style={{ padding: '7px 12px', fontSize: 11, textAlign: 'right', color: 'var(--ink-3)' }}>{run.skipped > 0 ? run.skipped.toLocaleString() : '—'}</td>
                      <td style={{ padding: '7px 12px', fontSize: 11, textAlign: 'right', fontWeight: 600, color: coverageColor }}>
                        {pct != null ? `${pct}%` : run.source_count == null ? '—' : 'pending'}
                      </td>
                      <td style={{ padding: '7px 12px', fontSize: 11, textAlign: 'right', color: 'var(--ink-3)' }}>{dur ?? '—'}</td>
                      <td style={{ padding: '7px 12px', fontSize: 11, textAlign: 'center', fontWeight: 700, color: statusColor }}>
                        {run.status === 'complete' ? '✓ OK' : run.status === 'failed' ? '✗ FAIL' : run.status?.toUpperCase()}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr style={{ background: 'var(--surface-alt)', borderBottom: '1px solid var(--border-soft)' }}>
                        <td colSpan={9} style={{ padding: '12px 32px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, fontSize: 11 }}>
                            <div>
                              <div style={{ color: 'var(--ink-3)', marginBottom: 4, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Run window</div>
                              <div style={{ fontFamily: '"JetBrains Mono", monospace', color: 'var(--ink-2)' }}>{run.from_ts ? fmtTs(run.from_ts, tz) : '—'}</div>
                              <div style={{ fontFamily: '"JetBrains Mono", monospace', color: 'var(--ink-2)' }}>→ {run.to_ts ? fmtTs(run.to_ts, tz) : '—'}</div>
                            </div>
                            <div>
                              <div style={{ color: 'var(--ink-3)', marginBottom: 4, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Ingestion</div>
                              <div>Fetched: <span style={{ color: 'var(--ink-2)' }}>{(run.fetched ?? 0).toLocaleString()}</span></div>
                              <div>Inserted: <span style={{ color: 'var(--mint)', fontWeight: 600 }}>{(run.inserted ?? 0).toLocaleString()}</span></div>
                              {run.skipped > 0 && <div>Dedup-skipped: <span style={{ color: 'var(--ink-3)' }}>{run.skipped.toLocaleString()}</span></div>}
                              {run.dlq > 0 && <div>DLQ: <span style={{ color: 'var(--coral)' }}>{run.dlq.toLocaleString()}</span></div>}
                            </div>
                            <div>
                              <div style={{ color: 'var(--ink-3)', marginBottom: 4, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Reconciliation</div>
                              {run.source_count != null ? (
                                <>
                                  <div>Source (OS): <span style={{ color: 'var(--ink-2)' }}>{run.source_count.toLocaleString()}</span></div>
                                  <div>ClickHouse: <span style={{ color: 'var(--ink-2)' }}>{run.destination_count?.toLocaleString() ?? '?'}</span></div>
                                  <div>Pending: <span style={{ color: run.remaining === 0 ? 'var(--mint)' : '#a37600' }}>{run.remaining?.toLocaleString() ?? '?'}</span></div>
                                  {pct != null && <div>Coverage: <span style={{ color: coverageColor }}>{pct}%</span></div>}
                                </>
                              ) : <div style={{ color: 'var(--ink-4)', fontStyle: 'italic' }}>Pending…</div>}
                            </div>
                            <div>
                              <div style={{ color: 'var(--ink-3)', marginBottom: 4, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Timing</div>
                              <div>Started: <span style={{ color: 'var(--ink-2)' }}>{fmtTs(run.started_at, tz)}</span></div>
                              <div>Finished: <span style={{ color: 'var(--ink-2)' }}>{run.finished_at ? fmtTs(run.finished_at, tz) : '—'}</span></div>
                              <div>Duration: <span style={{ color: 'var(--ink-2)' }}>{dur ?? '—'}</span></div>
                            </div>
                          </div>
                          {run.error_msg && (
                            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--coral)', fontFamily: '"JetBrains Mono", monospace', background: 'var(--coral-tint)', padding: '6px 12px', borderRadius: 6 }}>{run.error_msg}</div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function LogHistory() {
  const [tab, setTab] = useState('logs'); // 'logs' | 'runs'
  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [pages, setPages]     = useState(1);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs]       = useState([]);
  const [tz, setTzState]      = useState(getTzPref);

  // Filters
  const [search, setSearch]         = useState('');
  const [level, setLevel]           = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [dateFrom, setDateFrom]     = useState('');
  const [dateTo, setDateTo]         = useState('');
  const [limit, setLimit]           = useState(200);

  const searchRef = useRef(null);

  function changeTz(v) { setTzPref(v); setTzState(v); }

  const load = useCallback(async (p = page) => {
    setLoading(true);
    try {
      const params = { page: p, limit };
      if (search)     params.search      = search;
      if (level)      params.level       = level;
      if (pipelineId) params.pipeline_id = pipelineId;
      if (dateFrom)   params.date_from   = dateFrom;
      if (dateTo)     params.date_to     = dateTo;
      const data = await api.getLogHistory(params);
      setRows(data.rows);
      setTotal(data.total);
      setPages(data.pages);
      setPage(data.page);
    } catch {} finally { setLoading(false); }
  }, [page, limit, search, level, pipelineId, dateFrom, dateTo]);

  useEffect(() => {
    api.getJobs().then(setJobs).catch(() => {});
  }, []);

  useEffect(() => { if (tab === 'logs') load(1); }, [tab, level, pipelineId, dateFrom, dateTo, limit]);

  // Debounced search
  useEffect(() => {
    if (tab !== 'logs') return;
    const t = setTimeout(() => load(1), 400);
    return () => clearTimeout(t);
  }, [search, tab]);

  function goPage(p) {
    if (p < 1 || p > pages) return;
    load(p);
  }

  function clearFilters() {
    setSearch(''); setLevel(''); setPipelineId('');
    setDateFrom(''); setDateTo('');
  }

  function exportCsv() {
    const header = 'timestamp,pipeline,level,message';
    const lines = rows.map(r =>
      [fmtTs(r.created_at, tz), r.pipeline_name, r.level, `"${(r.message || '').replace(/"/g, '""')}"`].join(',')
    );
    const blob = new Blob([header + '\n' + lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `logbridge-logs-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  const hasFilters = search || level || pipelineId || dateFrom || dateTo;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ padding: '48px 48px 40px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--mint)', marginBottom: 8 }}>Log History</div>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--ink)', lineHeight: 1, margin: 0 }}>Audit Trail</h1>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8, letterSpacing: '0.01em' }}>Pipeline logs and run history</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }}>
          <TzToggle pref={tz} onChange={changeTz} />
          {tab === 'logs' && <>
            <button onClick={exportCsv} title="Export current page as CSV" className="btn-ghost" style={{ fontSize: 12, gap: 6 }}>
              <Download size={12} /> Export CSV
            </button>
            <button onClick={() => load(page)} disabled={loading} className="btn-ghost" style={{ fontSize: 12, gap: 6, opacity: loading ? 0.4 : 1 }}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </>}
        </div>
      </div>

      {/* Tab switcher */}
      <div style={{ padding: '0 48px 24px', display: 'flex', gap: 4 }}>
        <button onClick={() => setTab('logs')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: tab === 'logs' ? '1px solid rgba(20,184,166,0.40)' : '1px solid var(--border)', background: tab === 'logs' ? 'var(--teal-tint)' : 'var(--surface)', color: tab === 'logs' ? 'var(--teal)' : 'var(--ink-3)', transition: 'all 150ms' }}>
          <FileText size={12} /> Pipeline Logs
        </button>
        <button onClick={() => setTab('runs')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: tab === 'runs' ? '1px solid rgba(20,184,166,0.40)' : '1px solid var(--border)', background: tab === 'runs' ? 'var(--teal-tint)' : 'var(--surface)', color: tab === 'runs' ? 'var(--teal)' : 'var(--ink-3)', transition: 'all 150ms' }}>
          <Activity size={12} /> Run History
        </button>
      </div>

      {tab === 'runs' && <div style={{ padding: '0 48px 48px' }}><RunHistoryTab tz={tz} /></div>}

      {tab === 'logs' && <div style={{ padding: '0 48px 48px' }}>
      {/* Filters */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16, background: 'var(--surface)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Filter size={13} style={{ color: 'var(--ink-3)' }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-2)' }}>Filters</span>
          {hasFilters && (
            <button onClick={clearFilters} className="btn-ghost" style={{ fontSize: 11, gap: 4, marginLeft: 'auto' }}>
              <X size={11} /> Clear all
            </button>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 10 }}>
          {/* Search */}
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-4)', pointerEvents: 'none' }} />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search message…"
              className="input" style={{ paddingLeft: 28, fontSize: 12, width: '100%', height: 32 }}
            />
          </div>
          {/* Level */}
          <select value={level} onChange={e => setLevel(e.target.value)} className="select" style={{ fontSize: 12, height: 32 }}>
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <select value={pipelineId} onChange={e => setPipelineId(e.target.value)} className="select" style={{ fontSize: 12, height: 32 }}>
            <option value="">All pipelines</option>
            {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="input" style={{ fontSize: 12, height: 32 }} title="From date" />
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="input" style={{ fontSize: 12, height: 32 }} title="To date" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>Rows per page:</span>
          {[100, 200, 500, 1000].map(n => (
            <button key={n} onClick={() => setLimit(n)}
              style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: limit === n ? '1px solid rgba(20,184,166,0.40)' : '1px solid var(--border)', background: limit === n ? 'var(--teal-tint)' : 'transparent', color: limit === n ? 'var(--teal)' : 'var(--ink-3)' }}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="card-shell" style={{ overflow: 'hidden' }}>
        {/* Pagination top */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            {total > 0
              ? `Showing ${((page - 1) * limit + 1).toLocaleString()}–${Math.min(page * limit, total).toLocaleString()} of ${total.toLocaleString()}`
              : 'No results'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button onClick={() => goPage(1)} disabled={page <= 1 || loading} className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, opacity: page<=1||loading ? 0.3 : 1 }}>«</button>
            <button onClick={() => goPage(page - 1)} disabled={page <= 1 || loading} className="btn-ghost" style={{ padding: '4px 6px', opacity: page<=1||loading ? 0.3 : 1 }}><ChevronLeft size={13} /></button>
            <span style={{ fontSize: 11, color: 'var(--ink-3)', padding: '0 8px' }}>Page {page} of {pages}</span>
            <button onClick={() => goPage(page + 1)} disabled={page >= pages || loading} className="btn-ghost" style={{ padding: '4px 6px', opacity: page>=pages||loading ? 0.3 : 1 }}><ChevronRight size={13} /></button>
            <button onClick={() => goPage(pages)} disabled={page >= pages || loading} className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, opacity: page>=pages||loading ? 0.3 : 1 }}>»</button>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' }}>
                <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', width: 176 }}>Timestamp</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', width: 128 }}>Pipeline</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', width: 64 }}>Level</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Message</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: '48px 0', fontSize: 12, color: 'var(--ink-3)' }}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: '48px 0', fontSize: 12, color: 'var(--ink-3)' }}>No log entries match your filters.</td></tr>
              ) : (
                rows.map(entry => <LogRow key={entry.id} entry={entry} tz={tz} />)
              )}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
            <button onClick={() => goPage(1)} disabled={page <= 1 || loading} className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, opacity: page<=1||loading ? 0.3 : 1 }}>«</button>
            <button onClick={() => goPage(page - 1)} disabled={page <= 1 || loading} className="btn-ghost" style={{ padding: '4px 6px', opacity: page<=1||loading ? 0.3 : 1 }}><ChevronLeft size={13} /></button>
            <span style={{ fontSize: 11, color: 'var(--ink-3)', padding: '0 8px' }}>Page {page} of {pages}</span>
            <button onClick={() => goPage(page + 1)} disabled={page >= pages || loading} className="btn-ghost" style={{ padding: '4px 6px', opacity: page>=pages||loading ? 0.3 : 1 }}><ChevronRight size={13} /></button>
            <button onClick={() => goPage(pages)} disabled={page >= pages || loading} className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, opacity: page>=pages||loading ? 0.3 : 1 }}>»</button>
          </div>
        )}
      </div>
      </div>}
    </div>
  );
}
