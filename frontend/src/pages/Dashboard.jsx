import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GitBranch, AlertCircle, ArrowRight, RefreshCw,
} from 'lucide-react';
import { api } from '../api';

/* ─── Formatters ─────────────────────────────────────────────────────────── */
function fmtBytes(b) {
  if (!b) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
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
function fmtLagShort(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/* ─── CH Stats hook ──────────────────────────────────────────────────────── */
function useChTotals(pipelines) {
  const [totals, setTotals] = useState(null);
  const runKey = pipelines.map(p => p.last_success_at || '').join(',');
  const fetch = useCallback(() => {
    if (!pipelines.length) return;
    Promise.all(pipelines.map(p => api.getChStats(p.id).catch(() => null)))
      .then(results => {
        let compressed = 0, uncompressed = 0, rows = 0;
        for (const r of results) {
          if (!r) continue;
          compressed   += r.compressed_bytes   || 0;
          uncompressed += r.uncompressed_bytes  || 0;
          rows         += r.rows                || 0;
        }
        setTotals({ compressed, uncompressed, rows });
      });
  }, [runKey]); // eslint-disable-line
  useEffect(() => {
    fetch();
    const t = setInterval(fetch, 30000);
    return () => clearInterval(t);
  }, [fetch]);
  return totals;
}

/* ─── Skeleton shimmer ───────────────────────────────────────────────────── */
function Skeleton({ w = 56, h = 14 }) {
  return <span className="skeleton" style={{ width: w, height: h }} />;
}

/* ─── Status badge ───────────────────────────────────────────────────────── */
function StatusBadge({ status, run }) {
  if (run === 'error')     return <span className="badge badge-error">Error</span>;
  if (status === 'active') return <span className="badge badge-active">Active</span>;
  return <span className="badge badge-paused">Paused</span>;
}

/* ─── Metric — Siphon-style stat card ────────────────────────────────────── */
function StatCard({ label, value, accent, loading, sub, tone = 'default' }) {
  const bg = tone === 'butter' ? 'var(--butter)'
    : tone === 'ink'    ? 'var(--surface-ink)'
    : tone === 'mint'   ? 'var(--surface-mint)'
    : 'var(--surface)';
  const valColor = tone === 'ink' ? 'var(--canvas-text)'
    : accent || 'var(--ink)';
  const labelColor = tone === 'ink'    ? 'var(--canvas-dim)'
    : tone === 'butter' ? 'rgba(26,24,20,0.60)'
    : 'var(--ink-3)';
  const subColor = tone === 'ink'    ? 'var(--canvas-dim)'
    : tone === 'butter' ? 'rgba(26,24,20,0.50)'
    : 'var(--ink-4)';

  return (
    <div style={{
      borderRadius: 20, padding: '20px 22px 18px',
      background: bg,
      border: '1px solid var(--border-soft)',
      boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700,
        letterSpacing: '0.10em', textTransform: 'uppercase',
        color: labelColor, marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 30, fontWeight: 800,
        letterSpacing: '-0.04em', lineHeight: 1,
        color: valColor, fontVariantNumeric: 'tabular-nums',
      }}>
        {loading ? <Skeleton w={52} h={28} /> : value}
      </div>
      {sub && !loading && (
        <div style={{ fontSize: 11, color: subColor, marginTop: 5 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/* Keep old Metric alias for the metric band */
function Metric({ label, value, accent, loading, sub }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 26, fontWeight: 800,
        letterSpacing: '-0.04em', lineHeight: 1,
        color: accent || 'var(--ink)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {loading ? <Skeleton w={48} h={24} /> : value}
      </div>
      <div style={{
        fontSize: 10, fontWeight: 700,
        color: 'var(--ink-3)', letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}>
        {label}
      </div>
      {sub && !loading && (
        <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 1 }}>{sub}</div>
      )}
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────── */
export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats]           = useState(null);
  const [pipelines, setPipelines]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const chTotals = useChTotals(pipelines);

  async function load(manual = false) {
    if (manual) setRefreshing(true);
    try {
      const [s, p] = await Promise.all([api.getStats(), api.getPipelines()]);
      setStats(s);
      setPipelines(p);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      if (manual) setTimeout(() => setRefreshing(false), 600);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const erroring = pipelines.filter(p => p.run_status === 'error');
  const recent   = pipelines
    .filter(p => p.last_run_at)
    .sort((a, b) => (b.last_run_at || '').localeCompare(a.last_run_at || ''))
    .slice(0, 8);

  /* lag calc */
  const lags   = pipelines.map(p => p.event_lag_secs).filter(v => v != null);
  const avgLag = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null;
  const lagAccent = avgLag == null ? 'var(--text-1)'
    : avgLag < 60   ? '#34d399'
    : avgLag < 3600 ? '#fbbf24'
    : '#f87171';

  return (
    <div style={{ padding: '40px 48px 64px', maxWidth: 1200, margin: '0 auto' }}>

      {/* ── Page header ── */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        marginBottom: 32,
      }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>
            Dashboard
          </div>
          <h1 style={{
            fontSize: 30, fontWeight: 800,
            letterSpacing: '-0.03em', lineHeight: 1,
            color: 'var(--ink)', margin: 0,
          }}>
            {loading ? 'Loading…' : `${stats?.active ?? '—'} pipeline${stats?.active !== 1 ? 's' : ''} running`}
          </h1>
          <p style={{
            fontSize: 13, color: 'var(--ink-3)',
            margin: '6px 0 0', fontWeight: 400,
          }}>
            Live ingestion metrics across all pipelines
          </p>
        </div>
        <button
          onClick={() => load(true)}
          className="btn-ghost"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw
            size={12}
            style={{
              transition: 'transform 600ms cubic-bezier(0.32,0.72,0,1)',
              transform: refreshing ? 'rotate(360deg)' : 'none',
            }}
          />
          Refresh
        </button>
      </div>

      {/* ── Stat cards — Siphon style ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 14,
        marginBottom: 40,
      }}>
        <StatCard
          label="Total pipelines"
          value={loading ? null : (stats?.total ?? '—')}
          sub={`${stats?.active ?? 0} active · ${stats?.erroring ?? 0} error${stats?.erroring !== 1 ? 's' : ''}`}
          tone="ink"
          loading={loading}
        />
        <StatCard
          label="Rows today"
          value={loading ? null : fmtNum(stats?.rows_today)}
          sub="inserted across all"
          tone="default"
          loading={loading}
        />
        <StatCard
          label="CH rows total"
          value={chTotals ? fmtNum(chTotals.rows) : null}
          sub={chTotals ? 'from system.parts' : 'loading…'}
          tone="butter"
          loading={!chTotals}
        />
        <StatCard
          label="Avg event lag"
          value={avgLag != null ? fmtLagShort(avgLag) : (pipelines.length ? '—' : null)}
          accent={lagAccent}
          sub={lags.length ? `across ${lags.length} pipeline${lags.length !== 1 ? 's' : ''}` : null}
          tone="default"
          loading={loading}
        />
      </div>

      {/* ── Secondary metric band ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
        borderTop: '1px solid var(--border-soft)',
        borderBottom: '1px solid var(--border-soft)',
        marginBottom: 44,
        background: 'var(--surface)',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: 'var(--shadow-card)',
      }}>
        {[
          { label: 'Active',         value: stats?.active ?? '—',   accent: (stats?.active > 0) ? 'var(--mint)' : undefined, loading },
          { label: 'Paused',         value: stats?.paused ?? '—',   accent: (stats?.paused > 0) ? '#a37600' : undefined, loading },
          { label: 'Erroring',       value: stats?.erroring ?? '—', accent: (stats?.erroring > 0) ? 'var(--coral)' : undefined, loading },
          { label: 'DLQ pending',    value: stats ? fmtNum(stats.dlq_pending ?? 0) : '—', accent: (stats?.dlq_pending > 0) ? '#fbbf24' : undefined, loading },
          { label: 'CH uncompressed', value: chTotals ? fmtBytes(chTotals.uncompressed) : null, sub: chTotals ? 'raw size' : null, loading: !chTotals && !loading ? false : !chTotals },
        ].map((m, i) => (
          <div key={m.label} style={{
            padding: '20px 22px 22px',
            borderRight: i < 4 ? '1px solid var(--border-soft)' : 'none',
          }}>
            <Metric label={m.label} value={m.value ?? '—'} accent={m.accent} loading={m.loading} sub={m.sub} />
          </div>
        ))}
      </div>

      {/* ── Error callouts ── */}
      {erroring.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <AlertCircle size={11} style={{ color: 'var(--coral)' }} />
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.10em', color: 'var(--coral)' }}>
              Pipeline errors
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {erroring.map(p => (
              <div key={p.id} style={{
                background: 'var(--coral-tint)',
                border: '1px solid rgba(232,80,58,0.15)',
                borderRadius: 14, padding: '12px 18px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{p.name}</div>
                  <div style={{ color: 'var(--coral)', fontSize: 11, marginTop: 2 }}>{p.last_error || 'Unknown error'}</div>
                </div>
                <button onClick={() => navigate(`/pipelines/${p.id}/edit`)} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  color: 'var(--ink-3)', fontSize: 11,
                  background: 'none', border: 'none', cursor: 'pointer',
                  transition: 'color 200ms', whiteSpace: 'nowrap', fontFamily: 'inherit',
                }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--ink)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--ink-3)'}
                >
                  Edit <ArrowRight size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Recent activity table ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>
            Recent activity
          </span>
          <button onClick={() => navigate('/pipelines')} style={{
            display: 'flex', alignItems: 'center', gap: 4,
            color: 'var(--coral)', fontSize: 12,
            background: 'none', border: 'none', cursor: 'pointer',
            transition: 'opacity 160ms', fontFamily: 'inherit', fontWeight: 600,
          }}
            onMouseEnter={e => e.currentTarget.style.opacity = '0.75'}
            onMouseLeave={e => e.currentTarget.style.opacity = '1'}
          >
            View all <ArrowRight size={11} />
          </button>
        </div>

        <div className="card-shell">
          {recent.length === 0 ? (
            <div style={{ padding: '64px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--ink-3)', fontWeight: 500, marginBottom: 8 }}>No pipelines yet</div>
              <button onClick={() => navigate('/pipelines/new')} style={{
                color: 'var(--coral)', background: 'none', border: 'none',
                cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 600,
              }}>
                Create your first pipeline →
              </button>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  {['Pipeline', 'Status', 'Rows today', 'Last run', 'Destination'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map(p => (
                  <tr key={p.id} onClick={() => navigate(`/pipelines/${p.id}/edit`)}>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td><StatusBadge status={p.status} run={p.run_status} /></td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-2)' }}>
                      {fmtNum(p.rows_inserted_today)}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: '"JetBrains Mono", monospace' }}>
                      {p.last_run_at ? new Date(p.last_run_at).toLocaleString() : '—'}
                    </td>
                    <td style={{
                      fontSize: 11, color: 'var(--ink-3)',
                      fontFamily: '"JetBrains Mono", monospace',
                      maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {p.clickhouse_database}.{p.clickhouse_table}
                    </td>
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
