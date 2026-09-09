import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, CheckCircle, PauseCircle, AlertCircle, Database, Activity, HardDrive, Timer, RefreshCw } from 'lucide-react';
import { api } from '../api';

function StatCard({ icon: Icon, label, value, color = 'brand' }) {
  const colors = {
    brand: 'text-brand-400 bg-brand-500/10',
    green: 'text-green-400 bg-green-500/10',
    yellow: 'text-yellow-400 bg-yellow-500/10',
    red: 'text-red-400 bg-red-500/10',
    blue: 'text-blue-400 bg-blue-500/10',
  };
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colors[color]}`}>
          <Icon size={18} />
        </div>
        <span className="text-sm text-slate-400">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  );
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${units[i]}`;
}

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// Fetches real CH stats for all pipelines and sums them.
// Returns a shared hook so both cards read from one fetch.
function useChTotals(pipelines) {
  const [totals, setTotals] = useState(null);
  // Key on last_success_at so we re-fetch whenever any pipeline completes a run
  const runKey = pipelines.map(p => p.last_success_at || '').join(',');

  const fetch = useCallback(() => {
    if (!pipelines.length) return;
    Promise.all(pipelines.map(p => api.getChStats(p.id).catch(() => null)))
      .then(results => {
        let compressed = 0, uncompressed = 0, rows = 0;
        for (const r of results) {
          if (!r) continue;
          compressed += r.compressed_bytes || 0;
          uncompressed += r.uncompressed_bytes || 0;
          rows += r.rows || 0;
        }
        setTotals({ compressed, uncompressed, rows });
      });
  }, [runKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch();
    const t = setInterval(fetch, 30000);
    return () => clearInterval(t);
  }, [fetch]);

  return totals;
}

function ChRowsCard({ totals }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-emerald-400 bg-emerald-500/10">
          <Database size={18} />
        </div>
        <span className="text-sm text-slate-400">Total Rows (CH actual)</span>
      </div>
      {totals ? (
        <div>
          <div className="text-2xl font-bold text-emerald-400">{fmtNum(totals.rows)}</div>
          <div className="text-xs text-slate-500 mt-1">sum of all pipelines · from system.parts</div>
        </div>
      ) : (
        <div className="text-2xl font-bold text-slate-600">—</div>
      )}
    </div>
  );
}

function ChStorageCard({ totals }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-emerald-400 bg-emerald-500/10">
          <HardDrive size={18} />
        </div>
        <span className="text-sm text-slate-400">ClickHouse Storage</span>
      </div>
      {totals ? (
        <div>
          <div className="text-2xl font-bold text-white">{fmtBytes(totals.uncompressed)}</div>
          <div className="text-xs text-slate-500 mt-1">{fmtBytes(totals.compressed)} on-disk · {(totals.uncompressed / Math.max(totals.compressed, 1)).toFixed(1)}× ratio</div>
        </div>
      ) : (
        <div className="text-2xl font-bold text-slate-600">—</div>
      )}
    </div>
  );
}

function AvgLagCard({ pipelines }) {
  const lags = pipelines.map(p => p.event_lag_secs).filter(v => v != null);
  const avgLag = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null;

  function fmtLagShort(secs) {
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${avgLag != null && avgLag < 60 ? 'text-emerald-400 bg-emerald-500/10' : avgLag != null && avgLag < 3600 ? 'text-yellow-400 bg-yellow-500/10' : 'text-slate-400 bg-slate-700/30'}`}>
          <Timer size={18} />
        </div>
        <span className="text-sm text-slate-400">Avg Event Lag</span>
      </div>
      <div className={`text-2xl font-bold ${avgLag != null && avgLag < 60 ? 'text-emerald-400' : avgLag != null && avgLag < 3600 ? 'text-yellow-400' : 'text-white'}`}>
        {avgLag != null ? fmtLagShort(avgLag) : '—'}
      </div>
      <div className="text-xs text-slate-500 mt-1">{lags.length} pipeline{lags.length !== 1 ? 's' : ''} reporting</div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats]       = useState(null);
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading]   = useState(true);
  const chTotals = useChTotals(pipelines);

  async function load() {
    try {
      const [s, p] = await Promise.all([api.getStats(), api.getPipelines()]);
      setStats(s);
      setPipelines(p);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const erroring = pipelines.filter(p => p.run_status === 'error');
  const recent = pipelines.filter(p => p.last_run_at).sort((a, b) => (b.last_run_at || '').localeCompare(a.last_run_at || '')).slice(0, 6);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Overview of all log pipelines</p>
        </div>
        <button onClick={load} className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors">
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard icon={GitBranch}    label="Total Pipelines"       value={stats.total}                     color="brand"  />
          <StatCard icon={CheckCircle}  label="Active"                value={stats.active}                    color="green"  />
          <StatCard icon={PauseCircle}  label="Paused"                value={stats.paused}                    color="yellow" />
          <StatCard icon={AlertCircle}  label="Errors"                value={stats.erroring}                  color="red"    />
          <StatCard icon={Activity}     label="Rows Today (tracked)"  value={fmtNum(stats.rows_today)}  color="blue"  />
          <ChRowsCard   totals={chTotals} />
          <ChStorageCard totals={chTotals} />
          <AvgLagCard pipelines={pipelines} />
        </div>
      )}

      {/* Errors */}
      {erroring.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-red-400 mb-3 flex items-center gap-2">
            <AlertCircle size={14} /> Pipeline Errors
          </h2>
          <div className="space-y-2">
            {erroring.map(p => (
              <div key={p.id} className="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-white">{p.name}</div>
                  <div className="text-xs text-red-400 mt-0.5">{p.last_error || 'Unknown error'}</div>
                </div>
                <button
                  onClick={() => navigate(`/pipelines/${p.id}/edit`)}
                  className="text-xs text-slate-400 hover:text-white whitespace-nowrap"
                >
                  Edit →
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent pipelines */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-300">Recent Activity</h2>
          <button onClick={() => navigate('/pipelines')} className="text-xs text-brand-400 hover:text-brand-300">
            View all →
          </button>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          {recent.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">
              No pipelines yet.{' '}
              <button onClick={() => navigate('/pipelines/new')} className="text-brand-400 hover:underline">
                Create one →
              </button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  <th className="px-4 py-3 font-medium">Pipeline</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Rows Today</th>
                  <th className="px-4 py-3 font-medium">Last Run</th>
                  <th className="px-4 py-3 font-medium">Destination</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(p => (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/pipelines/${p.id}/edit`)}
                    className="border-b border-slate-800 last:border-0 hover:bg-slate-800/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-white font-medium">{p.name}</td>
                    <td className="px-4 py-3"><StatusBadge status={p.status} run={p.run_status} /></td>
                    <td className="px-4 py-3 text-slate-300">{fmtNum(p.rows_inserted_today)}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{p.last_run_at ? new Date(p.last_run_at).toLocaleString() : '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{p.clickhouse_database}.{p.clickhouse_table}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, run }) {
  if (run === 'error') return <span className="px-2 py-0.5 rounded-full text-xs bg-red-900/40 text-red-400 border border-red-800">Error</span>;
  if (status === 'active') return <span className="px-2 py-0.5 rounded-full text-xs bg-green-900/40 text-green-400 border border-green-800">Active</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs bg-slate-800 text-slate-400 border border-slate-700">Paused</span>;
}
