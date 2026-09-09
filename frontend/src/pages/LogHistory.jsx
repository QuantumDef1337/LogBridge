import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Download, RefreshCw, ChevronLeft, ChevronRight, Filter, X } from 'lucide-react';
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
  const fromM  = body.match(/from:(\S+)/);
  const toM    = body.match(/to:(\S+)/);
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

export default function LogHistory() {
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
          <p className="text-sm text-slate-400 mt-0.5">
            Full audit trail — {total.toLocaleString()} total entries
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TzToggle pref={tz} onChange={changeTz} />
          <button onClick={exportCsv} title="Export current page as CSV"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors">
            <Download size={12} /> Export CSV
          </button>
          <button onClick={() => load(page)} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700 transition-colors disabled:opacity-40">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

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
    </div>
  );
}
