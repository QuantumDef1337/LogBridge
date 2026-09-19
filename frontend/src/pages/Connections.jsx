import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Trash2, TestTube, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { api } from '../api';
import { can } from '../lib/permissions';

const OS_EMPTY  = { name: '', url: '', username: '', password: '', tls_verify: false };
const CH_EMPTY  = { name: '', url: '', username: '', password: '', default_database: 'default' };

// ─── Tab switcher ────────────────────────────────────────────────────────────

function Tabs({ active, onChange }) {
  const tabs = [
    { id: 'os', label: 'OpenSearch Sources' },
    { id: 'ch', label: 'ClickHouse Destinations' },
  ];
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 28 }}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            padding: '10px 20px',
            fontSize: 13, fontWeight: 600,
            borderBottom: `2px solid ${active === t.id ? 'var(--teal)' : 'transparent'}`,
            color: active === t.id ? 'var(--ink)' : 'var(--ink-3)',
            background: 'none', border: 'none',
            borderBottom: `2px solid ${active === t.id ? 'var(--teal)' : 'transparent'}`,
            cursor: 'pointer', fontFamily: 'inherit',
            transition: 'color 180ms, border-color 180ms',
            marginBottom: -1,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── OpenSearch panel ─────────────────────────────────────────────────────────

function OpenSearchPanel({ registerAdd }) {
  const [list, setList]       = useState([]);
  const [form, setForm]       = useState(null);
  useEffect(() => { registerAdd?.(() => setForm({ ...OS_EMPTY })); }, []);
  const [testing, setTesting] = useState({});
  const [showPass, setShowPass] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [indices, setIndices]   = useState({});
  const [tsInfo, setTsInfo]     = useState({});
  const [tsPattern, setTsPattern] = useState({});

  const load = useCallback(async () => { setList(await api.getConnections()); }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (form.id) await api.updateConnection(form.id, form);
    else await api.createConnection(form);
    setForm(null);
    load();
  }

  async function del(id) {
    if (!confirm('Delete this connection?')) return;
    await api.deleteConnection(id);
    load();
  }

  async function test(id) {
    setTesting(t => ({ ...t, [id]: 'loading' }));
    try {
      const r = await api.testConnection(id);
      setTesting(t => ({ ...t, [id]: r.ok ? `✅ ${r.cluster_name || 'Connected'}` : `❌ ${r.error}` }));
    } catch (e) {
      setTesting(t => ({ ...t, [id]: `❌ ${e.message}` }));
    }
  }

  async function loadIndices(id) {
    if (expanded[id]) { setExpanded(e => ({ ...e, [id]: false })); return; }
    setExpanded(e => ({ ...e, [id]: true }));
    try {
      const rows = await api.getIndices(id);
      setIndices(i => ({ ...i, [id]: rows }));
    } catch {
      setIndices(i => ({ ...i, [id]: [] }));
    }
  }

  async function fetchTs(connId) {
    const pattern = tsPattern[connId] || '';
    if (!pattern) return;
    try {
      const info = await api.getTimestamps(connId, pattern);
      setTsInfo(t => ({ ...t, [connId]: info }));
    } catch (e) {
      setTsInfo(t => ({ ...t, [connId]: { error: e.message } }));
    }
  }

  return (
    <div className="space-y-4">
      {form && (
        <div className="card-shell" style={{ padding: 24, marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', margin: '0 0 20px' }}>{form.id ? 'Edit' : 'New'} OpenSearch Connection</h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Wazuh Prod" />
            <Field label="URL"  value={form.url}  onChange={v => setForm(f => ({ ...f, url: v }))}  placeholder="https://192.168.4.100:9200" />
            <Field label="Username" value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} placeholder="admin" />
            <div>
              <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input type={showPass ? 'text' : 'password'} value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className="input" style={{ width: '100%', paddingRight: 36 }} placeholder="••••••••" />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, gridColumn: 'span 2' }}>
              <input type="checkbox" id="tls" checked={form.tls_verify}
                onChange={e => setForm(f => ({ ...f, tls_verify: e.target.checked }))} />
              <label htmlFor="tls" style={{ fontSize: 13, color: 'var(--ink-2)', cursor: 'pointer' }}>Verify TLS certificate (disable for self-signed)</label>
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={save} className="btn-primary">Save</button>
            <button onClick={() => setForm(null)} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}

      {list.length === 0 && !form && (
        <div style={{ textAlign: 'center', padding: '64px 0', fontSize: 13, color: 'var(--ink-3)' }}>No connections yet. Add your first Wazuh indexer.</div>
      )}

      {list.map(conn => (
        <div key={conn.id} className="card-shell" style={{ overflow: 'hidden', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{conn.name}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 3 }}>{conn.url} · {conn.username}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {testing[conn.id] && (
                <span style={{ fontSize: 11, color: 'var(--ink-2)' }}>{testing[conn.id] === 'loading' ? 'Testing…' : testing[conn.id]}</span>
              )}
              <button onClick={() => test(conn.id)} className="icon-btn" title="Test"><TestTube size={14} /></button>
              {can.editConnection() && <button onClick={() => setForm({ ...conn })} className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}>Edit</button>}
              {can.deleteConnection() && <button onClick={() => del(conn.id)} className="icon-btn" style={{ color: 'var(--coral)' }}><Trash2 size={14} /></button>}
              <button onClick={() => loadIndices(conn.id)} className="icon-btn">
                {expanded[conn.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
          </div>

          {expanded[conn.id] && (
            <div style={{ borderTop: '1px solid var(--border-soft)', padding: '16px 20px' }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <input
                  className="input" style={{ flex: 1, fontSize: 12 }}
                  placeholder="Enter index pattern e.g. wazuh-alerts-*"
                  value={tsPattern[conn.id] || ''}
                  onChange={e => setTsPattern(p => ({ ...p, [conn.id]: e.target.value }))}
                />
                <button onClick={() => fetchTs(conn.id)} className="btn-primary" style={{ fontSize: 12, padding: '6px 14px' }}>Check Timestamps</button>
              </div>

              {tsInfo[conn.id] && (
                <div style={{ background: 'var(--surface-alt)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, fontSize: 11 }}>
                  <div><div style={{ color: 'var(--ink-3)', marginBottom: 3, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Oldest Log</div><div style={{ color: 'var(--ink)' }}>{tsInfo[conn.id].oldest_ts || '—'}</div></div>
                  <div><div style={{ color: 'var(--ink-3)', marginBottom: 3, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Newest Log</div><div style={{ color: 'var(--ink)' }}>{tsInfo[conn.id].newest_ts || '—'}</div></div>
                  <div><div style={{ color: 'var(--ink-3)', marginBottom: 3, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total Docs</div><div style={{ color: 'var(--ink)' }}>{(tsInfo[conn.id].doc_count || 0).toLocaleString()}</div></div>
                  {tsInfo[conn.id].error && <div style={{ gridColumn: 'span 3', color: 'var(--coral)', fontSize: 11 }}>{tsInfo[conn.id].error}</div>}
                </div>
              )}

              {indices[conn.id] && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ padding: '0 0 8px', textAlign: 'left', color: 'var(--ink-3)', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', paddingRight: 16 }}>Index</th>
                        <th style={{ padding: '0 0 8px', textAlign: 'left', color: 'var(--ink-3)', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', paddingRight: 16 }}>Docs</th>
                        <th style={{ padding: '0 0 8px', textAlign: 'left', color: 'var(--ink-3)', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {indices[conn.id].map((idx, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border-soft)' }}>
                          <td style={{ padding: '6px 16px 6px 0', color: 'var(--ink-2)', fontFamily: '"JetBrains Mono", monospace' }}>{idx.index}</td>
                          <td style={{ padding: '6px 16px 6px 0', color: 'var(--ink-3)' }}>{Number(idx['docs.count'] || 0).toLocaleString()}</td>
                          <td style={{ padding: '6px 0', color: 'var(--ink-3)' }}>{idx['store.size'] || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── ClickHouse panel ─────────────────────────────────────────────────────────

function ClickHousePanel({ registerAdd }) {
  const [list, setList]       = useState([]);
  const [form, setForm]       = useState(null);
  useEffect(() => { registerAdd?.(() => setForm({ ...CH_EMPTY })); }, []);
  const [testing, setTesting] = useState({});
  const [showPass, setShowPass] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [dbs, setDbs]         = useState({});
  const [tables, setTables]   = useState({});
  const [selectedDb, setSelectedDb] = useState({});

  const load = useCallback(async () => { setList(await api.getClusters()); }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (form.id) await api.updateCluster(form.id, form);
    else await api.createCluster(form);
    setForm(null);
    load();
  }

  async function del(id) {
    if (!confirm('Delete this cluster?')) return;
    await api.deleteCluster(id);
    load();
  }

  async function test(id) {
    setTesting(t => ({ ...t, [id]: 'loading' }));
    try {
      await api.testCluster(id);
      setTesting(t => ({ ...t, [id]: '✅ Connected' }));
    } catch (e) {
      setTesting(t => ({ ...t, [id]: `❌ ${e.message}` }));
    }
  }

  async function loadDbs(id) {
    if (expanded[id]) { setExpanded(e => ({ ...e, [id]: false })); return; }
    setExpanded(e => ({ ...e, [id]: true }));
    try {
      const d = await api.getDatabases(id);
      setDbs(b => ({ ...b, [id]: d }));
    } catch { setDbs(b => ({ ...b, [id]: [] })); }
  }

  async function loadTables(clusterId, db) {
    setSelectedDb(s => ({ ...s, [clusterId]: db }));
    try {
      const t = await api.getTables(clusterId, db);
      setTables(b => ({ ...b, [`${clusterId}:${db}`]: t }));
    } catch { setTables(b => ({ ...b, [`${clusterId}:${db}`]: [] })); }
  }

  return (
    <div className="space-y-4">

      {form && (
        <div className="card-shell" style={{ padding: 24, marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', margin: '0 0 20px' }}>{form.id ? 'Edit' : 'New'} ClickHouse Cluster</h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="My ClickHouse" />
            <Field label="HTTP URL" value={form.url} onChange={v => setForm(f => ({ ...f, url: v }))} placeholder="http://192.168.4.115:8123" />
            <Field label="Username" value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} placeholder="vector" />
            <div>
              <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input type={showPass ? 'text' : 'password'} value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className="input" style={{ width: '100%', paddingRight: 36 }} placeholder="••••••••" />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <Field label="Default Database" value={form.default_database} onChange={v => setForm(f => ({ ...f, default_database: v }))} placeholder="Logs" />
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={save} className="btn-primary">Save</button>
            <button onClick={() => setForm(null)} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}

      {list.length === 0 && !form && (
        <div style={{ textAlign: 'center', padding: '64px 0', fontSize: 13, color: 'var(--ink-3)' }}>No clusters yet. Add your first ClickHouse cluster.</div>
      )}

      {list.map(c => (
        <div key={c.id} className="card-shell" style={{ overflow: 'hidden', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{c.name}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 3 }}>{c.url} · db: {c.default_database}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {testing[c.id] && <span style={{ fontSize: 11, color: 'var(--ink-2)' }}>{testing[c.id] === 'loading' ? 'Testing…' : testing[c.id]}</span>}
              <button onClick={() => test(c.id)} className="icon-btn" title="Test"><TestTube size={14} /></button>
              {can.editConnection() && <button onClick={() => setForm({ ...c })} className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}>Edit</button>}
              {can.deleteConnection() && <button onClick={() => del(c.id)} className="icon-btn" style={{ color: 'var(--coral)' }}><Trash2 size={14} /></button>}
              <button onClick={() => loadDbs(c.id)} className="icon-btn">
                {expanded[c.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
          </div>

          {expanded[c.id] && dbs[c.id] && (
            <div style={{ borderTop: '1px solid var(--border-soft)', padding: '16px 20px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 }}>Databases & Tables</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {dbs[c.id].map(db => (
                  <button key={db} onClick={() => loadTables(c.id, db)}
                    style={{
                      padding: '4px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                      border: selectedDb[c.id] === db ? '1px solid rgba(20,184,166,0.40)' : '1px solid var(--border)',
                      background: selectedDb[c.id] === db ? 'var(--teal-tint)' : 'var(--surface)',
                      color: selectedDb[c.id] === db ? 'var(--teal)' : 'var(--ink-2)',
                      transition: 'all 150ms',
                    }}>
                    {db}
                  </button>
                ))}
              </div>
              {selectedDb[c.id] && tables[`${c.id}:${selectedDb[c.id]}`] && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {tables[`${c.id}:${selectedDb[c.id]}`].map(t => (
                    <span key={t} style={{ padding: '3px 10px', background: 'var(--canvas)', color: 'var(--ink-2)', fontSize: 11, borderRadius: 6, border: '1px solid var(--border)', fontFamily: '"JetBrains Mono", monospace' }}>{t}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Combined page ────────────────────────────────────────────────────────────

export default function Connections() {
  const [tab, setTab] = useState(() => localStorage.getItem('lb_conn_tab') || 'os');
  const addFnRef = useRef(null);

  function switchTab(t) {
    setTab(t);
    localStorage.setItem('lb_conn_tab', t);
    addFnRef.current = null;
  }

  return (
    <div style={{ padding: '48px 48px 64px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 48 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--teal)', marginBottom: 8 }}>Connections</div>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1, color: 'var(--ink)', margin: 0 }}>
            Data Sources
          </h1>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '8px 0 0', fontWeight: 400 }}>
            OpenSearch sources and ClickHouse destinations
          </p>
        </div>
        {can.createConnection() && (
          <button
            onClick={() => addFnRef.current?.()}
            className="btn-primary"
            style={{ gap: 8, flexShrink: 0 }}
          >
            <Plus size={14} /> {tab === 'os' ? 'Add Connection' : 'Add Cluster'}
          </button>
        )}
      </div>

      <Tabs active={tab} onChange={switchTab} />

      {tab === 'os'
        ? <OpenSearchPanel registerAdd={fn => { addFnRef.current = fn; }} />
        : <ClickHousePanel registerAdd={fn => { addFnRef.current = fn; }} />}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        className="input" style={{ width: '100%' }} placeholder={placeholder} />
    </div>
  );
}
