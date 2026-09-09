import React, { useEffect, useState } from 'react';
import { Plus, Trash2, TestTube, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';

const EMPTY = { name: '', url: '', username: '', password: '', default_database: 'default' };

export default function Clusters() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const [testing, setTesting] = useState({});
  const [expanded, setExpanded] = useState({});
  const [dbs, setDbs] = useState({});
  const [tables, setTables] = useState({});
  const [selectedDb, setSelectedDb] = useState({});

  async function load() { setList(await api.getClusters()); }
  useEffect(() => { load(); }, []);

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
    } catch (e) { setDbs(b => ({ ...b, [id]: [] })); }
  }

  async function loadTables(clusterId, db) {
    setSelectedDb(s => ({ ...s, [clusterId]: db }));
    try {
      const t = await api.getTables(clusterId, db);
      setTables(b => ({ ...b, [`${clusterId}:${db}`]: t }));
    } catch (e) { setTables(b => ({ ...b, [`${clusterId}:${db}`]: [] })); }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">ClickHouse Clusters</h1>
          <p className="text-sm text-slate-400 mt-0.5">Destinations where logs are stored</p>
        </div>
        <button onClick={() => setForm({ ...EMPTY })} className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg transition-colors">
          <Plus size={15} /> Add Cluster
        </button>
      </div>

      {form && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-white mb-4">{form.id ? 'Edit' : 'New'} Cluster</h3>
          <div className="grid grid-cols-2 gap-4">
            {[
              ['Name', 'name', 'My ClickHouse', 'text'],
              ['HTTP URL', 'url', 'http://192.168.4.115:8123', 'text'],
              ['Username', 'username', 'vector', 'text'],
              ['Password', 'password', '••••••', 'password'],
              ['Default Database', 'default_database', 'Logs', 'text'],
            ].map(([label, key, ph, type]) => (
              <div key={key}>
                <label className="block text-xs text-slate-400 mb-1.5">{label}</label>
                <input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="input w-full" placeholder={ph} />
              </div>
            ))}
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={save} className="btn-primary">Save</button>
            <button onClick={() => setForm(null)} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
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
    </div>
  );
}
