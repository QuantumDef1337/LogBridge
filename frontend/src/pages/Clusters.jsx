import React, { useEffect, useState } from 'react';
import { Plus, Trash2, TestTube2, ChevronDown, ChevronRight, CheckCircle2, XCircle, Server } from 'lucide-react';
import { api } from '../api';

const EMPTY = { name: '', url: '', username: '', password: '', default_database: 'default' };

const FIELDS = [
  ['Name',             'name',             'My ClickHouse',            'text'],
  ['HTTP URL',         'url',              'http://192.168.4.115:8123', 'text'],
  ['Username',         'username',         'vector',                   'text'],
  ['Password',         'password',         '••••••',                   'password'],
  ['Default database', 'default_database', 'Logs',                     'text'],
];

export default function Clusters() {
  const [list, setList]         = useState([]);
  const [form, setForm]         = useState(null);
  const [testing, setTesting]   = useState({});
  const [expanded, setExpanded] = useState({});
  const [dbs, setDbs]           = useState({});
  const [tables, setTables]     = useState({});
  const [selectedDb, setSelectedDb] = useState({});

  async function load() { setList(await api.getClusters()); }
  useEffect(() => { load(); }, []);

  async function save() {
    if (form.id) await api.updateCluster(form.id, form);
    else          await api.createCluster(form);
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
      setTesting(t => ({ ...t, [id]: 'ok' }));
    } catch (e) {
      setTesting(t => ({ ...t, [id]: e.message }));
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
    <div style={{ padding: '32px', maxWidth: '960px', margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '32px' }}>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.92)', fontWeight: 800, fontSize: '22px', letterSpacing: '-0.02em' }}>
            ClickHouse clusters
          </div>
          <div style={{ color: 'rgba(255,255,255,0.32)', fontSize: '13px', marginTop: '4px' }}>
            Destinations where logs are stored
          </div>
        </div>
        <button
          onClick={() => setForm({ ...EMPTY })}
          className="btn-primary"
        >
          <Plus size={14} />
          Add cluster
        </button>
      </div>

      {/* Form */}
      {form && (
        <div className="card-shell" style={{ marginBottom: '20px', animation: 'fade-up 0.4s cubic-bezier(0.32,0.72,0,1) both' }}>
          <div className="card-inner" style={{ padding: '28px' }}>
            <div style={{ color: 'rgba(255,255,255,0.70)', fontWeight: 600, fontSize: '13px', marginBottom: '20px' }}>
              {form.id ? 'Edit cluster' : 'New cluster'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              {FIELDS.map(([label, key, ph, type]) => (
                <div key={key}>
                  <label className="label">{label}</label>
                  <input
                    type={type}
                    value={form[key]}
                    onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    className="input"
                    placeholder={ph}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
              <button onClick={save} className="btn-primary">Save cluster</button>
              <button onClick={() => setForm(null)} className="btn-ghost">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {list.length === 0 && !form && (
        <div style={{
          textAlign: 'center', padding: '72px 24px',
          borderRadius: '20px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px dashed rgba(255,255,255,0.07)',
        }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '14px',
            background: 'rgba(20,184,166,0.10)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <Server size={20} style={{ color: '#14b8a6' }} />
          </div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: '14px', fontWeight: 500 }}>No clusters yet</div>
          <div style={{ color: 'rgba(255,255,255,0.22)', fontSize: '12px', marginTop: '6px' }}>Add your first ClickHouse cluster to get started</div>
        </div>
      )}

      {/* Cluster cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {list.map(c => {
          const testState = testing[c.id];
          return (
            <div
              key={c.id}
              className="card-shell"
              style={{ animation: 'fade-up 0.5s cubic-bezier(0.32,0.72,0,1) both' }}
            >
              <div className="card-inner">

                {/* Card header row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px' }}>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'rgba(255,255,255,0.88)', fontWeight: 600, fontSize: '14px' }}>{c.name}</div>
                    <div style={{ color: 'rgba(255,255,255,0.28)', fontSize: '11px', marginTop: '3px', fontFamily: '"JetBrains Mono", monospace' }}>
                      {c.url} <span style={{ color: 'rgba(255,255,255,0.18)' }}>·</span> {c.default_database}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>

                    {/* Test result */}
                    {testState && testState !== 'loading' && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '5px',
                        padding: '4px 10px', borderRadius: '99px', fontSize: '11px', fontWeight: 500,
                        background: testState === 'ok' ? 'rgba(52,211,153,0.10)' : 'rgba(248,113,113,0.10)',
                        border: `1px solid ${testState === 'ok' ? 'rgba(52,211,153,0.20)' : 'rgba(248,113,113,0.20)'}`,
                        color: testState === 'ok' ? '#34d399' : '#f87171',
                        maxWidth: '180px',
                      }}>
                        {testState === 'ok'
                          ? <><CheckCircle2 size={11} /> Connected</>
                          : <><XCircle size={11} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{testState.slice(0, 32)}</span></>
                        }
                      </div>
                    )}
                    {testState === 'loading' && (
                      <div style={{ color: 'rgba(255,255,255,0.28)', fontSize: '11px', padding: '0 8px' }}>Testing…</div>
                    )}

                    <button
                      onClick={() => test(c.id)}
                      className="icon-btn"
                      title="Test connection"
                    >
                      <TestTube2 size={14} />
                    </button>

                    <button
                      onClick={() => setForm({ ...c })}
                      style={{
                        padding: '5px 12px', borderRadius: '99px', fontSize: '11px', fontWeight: 500,
                        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                        color: 'rgba(255,255,255,0.45)', cursor: 'pointer',
                        transition: 'all 200ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; }}
                    >
                      Edit
                    </button>

                    <button
                      onClick={() => del(c.id)}
                      className="icon-btn"
                      title="Delete cluster"
                      style={{ color: 'rgba(248,113,113,0.5)' }}
                      onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                      onMouseLeave={e => e.currentTarget.style.color = 'rgba(248,113,113,0.5)'}
                    >
                      <Trash2 size={13} />
                    </button>

                    <button
                      onClick={() => loadDbs(c.id)}
                      className="icon-btn"
                      title="Browse databases"
                    >
                      {expanded[c.id]
                        ? <ChevronDown size={14} />
                        : <ChevronRight size={14} />
                      }
                    </button>
                  </div>
                </div>

                {/* Expanded: databases & tables */}
                {expanded[c.id] && dbs[c.id] && (
                  <div style={{
                    borderTop: '1px solid rgba(255,255,255,0.05)',
                    padding: '16px 20px',
                    background: 'rgba(0,0,0,0.2)',
                  }}>
                    <div className="section-title" style={{ marginBottom: '10px' }}>Databases & tables</div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
                      {dbs[c.id].map(db => {
                        const isSelected = selectedDb[c.id] === db;
                        return (
                          <button
                            key={db}
                            onClick={() => loadTables(c.id, db)}
                            style={{
                              padding: '4px 12px', borderRadius: '99px', fontSize: '11px', fontWeight: 500,
                              cursor: 'pointer',
                              background: isSelected ? 'rgba(20,184,166,0.15)' : 'rgba(255,255,255,0.04)',
                              border: `1px solid ${isSelected ? 'rgba(20,184,166,0.30)' : 'rgba(255,255,255,0.07)'}`,
                              color: isSelected ? '#2dd4bf' : 'rgba(255,255,255,0.45)',
                              transition: 'all 200ms cubic-bezier(0.32,0.72,0,1)',
                            }}
                          >
                            {db}
                          </button>
                        );
                      })}
                    </div>

                    {selectedDb[c.id] && tables[`${c.id}:${selectedDb[c.id]}`] && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                        {tables[`${c.id}:${selectedDb[c.id]}`].map(t => (
                          <span
                            key={t}
                            style={{
                              padding: '3px 10px', borderRadius: '6px', fontSize: '11px',
                              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
                              color: 'rgba(255,255,255,0.40)', fontFamily: '"JetBrains Mono", monospace',
                            }}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
