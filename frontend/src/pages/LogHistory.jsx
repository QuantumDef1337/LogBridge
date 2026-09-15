import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Download, RefreshCw, ChevronLeft, ChevronRight, Filter, X, Activity, FileText } from 'lucide-react';
import { api } from '../api';
import { fmtTs, getTzPref, setTzPref } from '../utils/time';

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

const LEVEL_COLORS = {
  error: 'text-red-400 bg-red-950/30',
  warn:  'text-amber-400 bg-amber-950/20',
  info:  'text-slate-300',
};

const LEVEL_BADGE = {
  error: 'bg-red-900/60 text-red-300 border border-red-800',
  warn:  'bg-amber-900/40 text-amber-300 border border-amber-800',
  info:  'bg-slate-800 text-slate-400 border border-slate-700',
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
        className={`border-b border-slate-800/60 hover:bg-slate-800/20 cursor-pointer transition-colors ${entry.level === 'error' ? 'bg-red-950/10' : entry.level === 'warn' ? 'bg-amber-950/10' : ''}`}
        onClick={() => hasDetail && setExpanded(e => !e)}
      >
        <td className="px-4 py-2 text-xs font-mono text-slate-500 whitespace-nowrap w-44">{fmtTs(entry.created_at, tz)}</td>
        <td className="px-3 py-2 w-32">
          <span className="text-xs font-medium text-brand-400 truncate block max-w-[120px]" title={entry.pipeline_name}>{entry.pipeline_name}</span>
        </td>
        <td className="px-3 py-2 w-16">
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${LEVEL_BADGE[entry.level] || LEVEL_BADGE.info}`}>{entry.level}</span>
        </td>
        <td className="px-3 py-2 text-xs font-mono text-slate-300 max-w-0">
          <div className="truncate">{entry.message}</div>
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr className="bg-slate-900/60 border-b border-slate-800/40">
          <td colSpan={4} className="px-8 py-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-slate-400">
              {batch.index && <span>index: <span className="text-yellow-400">{batch.index}</span></span>}
              {batch.fromTs && <span>from: <span className="text-blue-300">{fmtTs(batch.fromTs, tz)}</span></span>}
              {batch.toTs && <span>to: <span className="text-blue-300">{fmtTs(batch.toTs, tz)}</span></span>}
              {batch.inserted && <span>inserted: <span className="text-emerald-400">{batch.inserted.toLocaleString()}</span></span>}
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
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center gap-3 flex-wrap">
        <Filter size={13} className="text-slate-500" />
        <select value={pipelineId} onChange={e => setPipelineId(e.target.value)} className="input text-xs h-8">
          <option value="">All pipelines</option>
          {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
        <button onClick={() => load(1)} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors disabled:opacity-40 ml-auto">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
        <span className="text-xs text-slate-500">{total.toLocaleString()} total runs</span>
      </div>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {total > 0 ? `Showing ${((page-1)*limit+1).toLocaleString()}–${Math.min(page*limit,total).toLocaleString()} of ${total.toLocaleString()}` : 'No runs'}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => goPage(1)} disabled={page<=1||loading} className="px-2 py-1 rounded text-xs text-slate-400 hover:text-white disabled:opacity-30">«</button>
            <button onClick={() => goPage(page-1)} disabled={page<=1||loading} className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30"><ChevronLeft size={14}/></button>
            <span className="text-xs text-slate-400 px-2">Page {page} of {pages}</span>
            <button onClick={() => goPage(page+1)} disabled={page>=pages||loading} className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30"><ChevronRight size={14}/></button>
            <button onClick={() => goPage(pages)} disabled={page>=pages||loading} className="px-2 py-1 rounded text-xs text-slate-400 hover:text-white disabled:opacity-30">»</button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-800/30">
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-500">Started</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">Pipeline</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">Window</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Fetched</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Inserted</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Dedup</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Coverage</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Duration</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && !runs.length ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-500 text-sm">Loading…</td></tr>
              ) : !runs.length ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-500 text-sm">No run history yet. Runs appear here after the pipeline executes.</td></tr>
              ) : runs.map(run => {
                const isExpanded = expanded[run.id];
                const statusColor = run.status === 'complete' ? 'text-emerald-400'
                  : run.status === 'failed' ? 'text-red-400'
                  : run.status === 'cancelled' ? 'text-amber-400'
                  : 'text-slate-400';
                const pct = run.success_pct;
                const coverageColor = pct === 100 ? 'text-emerald-400'
                  : pct != null && pct >= 95 ? 'text-amber-400' : pct != null ? 'text-red-400' : 'text-slate-500';
                const dur = fmtDurSecs(run.started_at, run.finished_at);
                return (
                  <React.Fragment key={run.id}>
                    <tr
                      className="border-b border-slate-800/60 hover:bg-slate-800/20 cursor-pointer transition-colors"
                      onClick={() => setExpanded(e => ({ ...e, [run.id]: !e[run.id] }))}
                    >
                      <td className="px-4 py-2 text-xs font-mono text-slate-400 whitespace-nowrap">{fmtTs(run.started_at, tz)}</td>
                      <td className="px-3 py-2 text-xs font-medium text-brand-400 truncate max-w-[120px]">{run.pipeline_name}</td>
                      <td className="px-3 py-2 text-[10px] font-mono text-slate-600 whitespace-nowrap">
                        {run.from_ts ? fmtTs(run.from_ts, tz) : '—'} → {run.to_ts ? fmtTs(run.to_ts, tz) : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-right text-slate-400">{(run.fetched ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs text-right text-white font-medium">{(run.inserted ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs text-right text-slate-500">{run.skipped > 0 ? run.skipped.toLocaleString() : '—'}</td>
                      <td className={`px-3 py-2 text-xs text-right font-medium ${coverageColor}`}>
                        {pct != null ? `${pct}%` : run.source_count == null ? '—' : 'pending'}
                      </td>
                      <td className="px-3 py-2 text-xs text-right text-slate-500">{dur ?? '—'}</td>
                      <td className={`px-3 py-2 text-xs text-center font-semibold ${statusColor}`}>
                        {run.status === 'complete' ? '✓ COMPLETE' : run.status === 'failed' ? '✗ FAILED' : run.status?.toUpperCase()}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-slate-900/60 border-b border-slate-800/40">
                        <td colSpan={9} className="px-8 py-3">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[11px]">
                            <div>
                              <div className="text-slate-500 mb-1">Run window</div>
                              <div className="font-mono text-slate-300">{run.from_ts ? fmtTs(run.from_ts, tz) : '—'}</div>
                              <div className="font-mono text-slate-300">→ {run.to_ts ? fmtTs(run.to_ts, tz) : '—'}</div>
                            </div>
                            <div>
                              <div className="text-slate-500 mb-1">Ingestion</div>
                              <div>Fetched: <span className="text-slate-300">{(run.fetched ?? 0).toLocaleString()}</span></div>
                              <div>Inserted: <span className="text-emerald-400 font-medium">{(run.inserted ?? 0).toLocaleString()}</span></div>
                              {run.skipped > 0 && <div>Dedup-skipped: <span className="text-slate-400">{run.skipped.toLocaleString()}</span></div>}
                              {run.dlq > 0 && <div>DLQ: <span className="text-red-400">{run.dlq.toLocaleString()}</span></div>}
                            </div>
                            <div>
                              <div className="text-slate-500 mb-1">Reconciliation</div>
                              {run.source_count != null ? (
                                <>
                                  <div>Source (OS): <span className="text-slate-300">{run.source_count.toLocaleString()}</span></div>
                                  <div>ClickHouse: <span className="text-slate-300">{run.destination_count?.toLocaleString() ?? '?'}</span></div>
                                  <div>Pending: <span className={run.remaining === 0 ? 'text-emerald-400' : 'text-amber-400'}>{run.remaining?.toLocaleString() ?? '?'}</span></div>
                                  {pct != null && <div>Coverage: <span className={coverageColor}>{pct}%</span></div>}
                                </>
                              ) : <div className="text-slate-600 italic">Pending…</div>}
                            </div>
                            <div>
                              <div className="text-slate-500 mb-1">Timing</div>
                              <div>Started: <span className="text-slate-300">{fmtTs(run.started_at, tz)}</span></div>
                              <div>Finished: <span className="text-slate-300">{run.finished_at ? fmtTs(run.finished_at, tz) : '—'}</span></div>
                              <div>Duration: <span className="text-slate-300">{dur ?? '—'}</span></div>
                            </div>
                          </div>
                          {run.error_msg && (
                            <div className="mt-2 text-[11px] text-red-400 font-mono bg-red-950/20 px-3 py-1.5 rounded">{run.error_msg}</div>
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

  useEffect(() => { load(1); }, [level, pipelineId, dateFrom, dateTo, limit]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => load(1), 400);
    return () => clearTimeout(t);
  }, [search]);

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
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Log History</h1>
          <p className="text-sm text-slate-400 mt-0.5">Audit trail and run history</p>
        </div>
        <div className="flex items-center gap-2">
          <TzToggle pref={tz} onChange={changeTz} />
          {tab === 'logs' && <>
            <button onClick={exportCsv} title="Export current page as CSV"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors">
              <Download size={12} /> Export CSV
            </button>
            <button onClick={() => load(page)} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors disabled:opacity-40">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </>}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 w-fit">
        <button onClick={() => setTab('logs')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === 'logs' ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'}`}>
          <FileText size={12} /> Pipeline Logs
        </button>
        <button onClick={() => setTab('runs')}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === 'runs' ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'}`}>
          <Activity size={12} /> Run History
        </button>
      </div>

      {tab === 'runs' && <RunHistoryTab tz={tz} />}

      {tab === 'logs' && <>
      {/* Filters */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter size={13} className="text-slate-500" />
          <span className="text-xs font-medium text-slate-400">Filters</span>
          {hasFilters && (
            <button onClick={clearFilters}
              className="ml-auto flex items-center gap-1 text-xs text-slate-500 hover:text-white transition-colors">
              <X size={11} /> Clear all
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          {/* Search */}
          <div className="relative col-span-2 md:col-span-1 lg:col-span-2">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search message…"
              className="input w-full pl-7 text-xs h-8"
            />
          </div>
          {/* Level */}
          <select value={level} onChange={e => setLevel(e.target.value)} className="input text-xs h-8">
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          {/* Pipeline */}
          <select value={pipelineId} onChange={e => setPipelineId(e.target.value)} className="input text-xs h-8">
            <option value="">All pipelines</option>
            {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          {/* Date from */}
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="input text-xs h-8" title="From date" />
          {/* Date to */}
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="input text-xs h-8" title="To date" />
        </div>
        <div className="flex items-center gap-3 mt-3">
          <span className="text-xs text-slate-500">Rows per page:</span>
          {[100, 200, 500, 1000].map(n => (
            <button key={n} onClick={() => setLimit(n)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${limit === n ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        {/* Pagination top */}
        <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {total > 0
              ? `Showing ${((page - 1) * limit + 1).toLocaleString()}–${Math.min(page * limit, total).toLocaleString()} of ${total.toLocaleString()}`
              : 'No results'}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => goPage(1)} disabled={page <= 1 || loading}
              className="px-2 py-1 rounded text-xs text-slate-400 hover:text-white disabled:opacity-30 transition-colors">«</button>
            <button onClick={() => goPage(page - 1)} disabled={page <= 1 || loading}
              className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30 transition-colors">
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-slate-400 px-2">Page {page} of {pages}</span>
            <button onClick={() => goPage(page + 1)} disabled={page >= pages || loading}
              className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30 transition-colors">
              <ChevronRight size={14} />
            </button>
            <button onClick={() => goPage(pages)} disabled={page >= pages || loading}
              className="px-2 py-1 rounded text-xs text-slate-400 hover:text-white disabled:opacity-30 transition-colors">»</button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-800/30">
                <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 w-44">Timestamp</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 w-32">Pipeline</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 w-16">Level</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">Message</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={4} className="text-center py-12 text-slate-500 text-sm">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={4} className="text-center py-12 text-slate-500 text-sm">No log entries match your filters.</td></tr>
              ) : (
                rows.map(entry => <LogRow key={entry.id} entry={entry} tz={tz} />)
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination bottom */}
        {pages > 1 && (
          <div className="px-4 py-2.5 border-t border-slate-800 flex items-center justify-end gap-1">
            <button onClick={() => goPage(1)} disabled={page <= 1 || loading}
              className="px-2 py-1 rounded text-xs text-slate-400 hover:text-white disabled:opacity-30 transition-colors">«</button>
            <button onClick={() => goPage(page - 1)} disabled={page <= 1 || loading}
              className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30 transition-colors">
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-slate-400 px-2">Page {page} of {pages}</span>
            <button onClick={() => goPage(page + 1)} disabled={page >= pages || loading}
              className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30 transition-colors">
              <ChevronRight size={14} />
            </button>
            <button onClick={() => goPage(pages)} disabled={page >= pages || loading}
              className="px-2 py-1 rounded text-xs text-slate-400 hover:text-white disabled:opacity-30 transition-colors">»</button>
          </div>
        )}
      </div>
      </>}
    </div>
  );
}
