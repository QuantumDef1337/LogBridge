import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, TestTube, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { api } from '../api';

const OS_EMPTY  = { name: '', url: '', username: '', password: '', tls_verify: false };
const CH_EMPTY  = { name: '', url: '', username: '', password: '', default_database: 'default' };

// ─── Tab switcher ────────────────────────────────────────────────────────────

function Tabs({ active, onChange }) {
  const tabs = [
    { id: 'os', label: 'OpenSearch Sources' },
    { id: 'ch', label: 'ClickHouse Destinations' },
  ];
  return (
    <div className="flex border-b border-slate-800 mb-6">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
            active === t.id
              ? 'border-brand-500 text-white'
              : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── OpenSearch panel ─────────────────────────────────────────────────────────

function OpenSearchPanel() {
  const [list, setList]       = useState([]);
  const [form, setForm]       = useState(null);
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
      <div className="flex justify-end">
        <button
          onClick={() => setForm({ ...OS_EMPTY })}
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
        >
          <Plus size={15} /> Add Connection
        </button>
      </div>

      {form && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-white mb-4">{form.id ? 'Edit' : 'New'} OpenSearch Connection</h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Wazuh Prod" />
            <Field label="URL"  value={form.url}  onChange={v => setForm(f => ({ ...f, url: v }))}  placeholder="https://192.168.4.100:9200" />
            <Field label="Username" value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} placeholder="admin" />
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Password</label>
              <div className="relative">
                <input type={showPass ? 'text' : 'password'} value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className="input w-full pr-9" placeholder="••••••••" />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
                  {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 col-span-2">
              <input type="checkbox" id="tls" checked={form.tls_verify}
                onChange={e => setForm(f => ({ ...f, tls_verify: e.target.checked }))} className="rounded" />
              <label htmlFor="tls" className="text-sm text-slate-300">Verify TLS certificate (disable for self-signed)</label>
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={save} className="btn-primary">Save</button>
            <button onClick={() => setForm(null)} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}

      {list.length === 0 && !form && (
        <div className="text-center py-16 text-slate-500 text-sm">No connections yet. Add your first Wazuh indexer.</div>
      )}

      {list.map(conn => (
        <div key={conn.id} className="bg-slate-900 border border-slate-800 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <div className="font-medium text-white text-sm">{conn.name}</div>
              <div className="text-xs text-slate-400 mt-0.5">{conn.url} · {conn.username}</div>
            </div>
            <div className="flex items-center gap-2">
              {testing[conn.id] && (
                <span className="text-xs text-slate-300">{testing[conn.id] === 'loading' ? 'Testing…' : testing[conn.id]}</span>
              )}
              <button onClick={() => test(conn.id)} className="icon-btn" title="Test"><TestTube size={15} /></button>
              <button onClick={() => setForm({ ...conn })} className="icon-btn">Edit</button>
              <button onClick={() => del(conn.id)} className="icon-btn text-red-400 hover:text-red-300"><Trash2 size={15} /></button>
              <button onClick={() => loadIndices(conn.id)} className="icon-btn">
                {expanded[conn.id] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
            </div>
          </div>

          {expanded[conn.id] && (
            <div className="border-t border-slate-800 px-5 py-4">
              <div className="flex gap-2 mb-4">
                <input
                  className="input flex-1 text-xs"
                  placeholder="Enter index pattern e.g. wazuh-alerts-*"
                  value={tsPattern[conn.id] || ''}
                  onChange={e => setTsPattern(p => ({ ...p, [conn.id]: e.target.value }))}
                />
                <button onClick={() => fetchTs(conn.id)} className="btn-primary text-xs px-3">Check Timestamps</button>
              </div>

              {tsInfo[conn.id] && (
                <div className="bg-slate-800 rounded-lg p-3 mb-4 grid grid-cols-3 gap-4 text-xs">
                  <div><div className="text-slate-400 mb-0.5">Oldest Log</div><div className="text-white">{tsInfo[conn.id].oldest_ts || '—'}</div></div>
                  <div><div className="text-slate-400 mb-0.5">Newest Log</div><div className="text-white">{tsInfo[conn.id].newest_ts || '—'}</div></div>
                  <div><div className="text-slate-400 mb-0.5">Total Docs</div><div className="text-white">{(tsInfo[conn.id].doc_count || 0).toLocaleString()}</div></div>
                  {tsInfo[conn.id].error && <div className="col-span-3 text-red-400">{tsInfo[conn.id].error}</div>}
                </div>
              )}

              {indices[conn.id] && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="pb-2 pr-4">Index</th>
                        <th className="pb-2 pr-4">Docs</th>
                        <th className="pb-2">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {indices[conn.id].map((idx, i) => (
                        <tr key={i} className="border-t border-slate-800">
                          <td className="py-1.5 pr-4 text-slate-300 font-mono">{idx.index}</td>
                          <td className="py-1.5 pr-4 text-slate-400">{Number(idx['docs.count'] || 0).toLocaleString()}</td>
                          <td className="py-1.5 text-slate-400">{idx['store.size'] || '—'}</td>
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

function ClickHousePanel() {
  const [list, setList]       = useState([]);
  const [form, setForm]       = useState(null);
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
      <div className="flex justify-end">
        <button onClick={() => setForm({ ...CH_EMPTY })} className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg transition-colors">
          <Plus size={15} /> Add Cluster
        </button>
      </div>

      {form && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-white mb-4">{form.id ? 'Edit' : 'New'} ClickHouse Cluster</h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="My ClickHouse" />
            <Field label="HTTP URL" value={form.url} onChange={v => setForm(f => ({ ...f, url: v }))} placeholder="http://192.168.4.115:8123" />
            <Field label="Username" value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} placeholder="vector" />
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Password</label>
              <div className="relative">
                <input type={showPass ? 'text' : 'password'} value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className="input w-full pr-9" placeholder="••••••••" />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
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
        <div className="text-center py-16 text-slate-500 text-sm">No clusters yet. Add your first ClickHouse cluster.</div>
      )}

      {list.map(c => (
        <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <div className="font-medium text-white text-sm">{c.name}</div>
              <div className="text-xs text-slate-400 mt-0.5">{c.url} · db: {c.default_database}</div>
            </div>
            <div className="flex items-center gap-2">
              {testing[c.id] && <span className="text-xs text-slate-300">{testing[c.id] === 'loading' ? 'Testing…' : testing[c.id]}</span>}
              <button onClick={() => test(c.id)} className="icon-btn" title="Test"><TestTube size={15} /></button>
              <button onClick={() => setForm({ ...c })} className="icon-btn">Edit</button>
              <button onClick={() => del(c.id)} className="icon-btn text-red-400 hover:text-red-300"><Trash2 size={15} /></button>
              <button onClick={() => loadDbs(c.id)} className="icon-btn">
                {expanded[c.id] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
            </div>
          </div>

          {expanded[c.id] && dbs[c.id] && (
            <div className="border-t border-slate-800 px-5 py-4">
              <div className="text-xs text-slate-400 mb-3">Databases & Tables</div>
              <div className="flex flex-wrap gap-2 mb-4">
                {dbs[c.id].map(db => (
                  <button key={db} onClick={() => loadTables(c.id, db)}
                    className={`px-3 py-1 rounded-lg text-xs border transition-colors ${selectedDb[c.id] === db ? 'bg-brand-600 border-brand-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500'}`}>
                    {db}
                  </button>
                ))}
              </div>
              {selectedDb[c.id] && tables[`${c.id}:${selectedDb[c.id]}`] && (
                <div className="flex flex-wrap gap-2">
                  {tables[`${c.id}:${selectedDb[c.id]}`].map(t => (
                    <span key={t} className="px-2 py-0.5 bg-slate-800 text-slate-300 text-xs rounded border border-slate-700">{t}</span>
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

  function switchTab(t) {
    setTab(t);
    localStorage.setItem('lb_conn_tab', t);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Connections</h1>
        <p className="text-sm text-slate-400 mt-0.5">Manage your OpenSearch sources and ClickHouse destinations</p>
      </div>

      <Tabs active={tab} onChange={switchTab} />

      {tab === 'os' ? <OpenSearchPanel /> : <ClickHousePanel />}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1.5">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        className="input w-full" placeholder={placeholder} />
    </div>
  );
}
