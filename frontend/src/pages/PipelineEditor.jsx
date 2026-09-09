import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Plus, Trash2, RefreshCw, FlaskConical } from 'lucide-react';
import { api } from '../api';

const STEPS = ['Source', 'Destination', 'Field Mapping', 'Tagging & Batching', 'Review'];

const DEFAULT = {
  name: '', description: '', status: 'paused',
  opensearch_connection_id: '', index_pattern: '', index_set_filter: [],
  pull_mode: 'continuous', pull_from_date: '', pull_to_date: '',
  clickhouse_cluster_id: '', clickhouse_database: '', clickhouse_table: '',
  field_mappings: [],
  customer_source: 'field', customer_value: '_customer',
  product_source: 'field', product_value: '_product',
  batch_mode: 'both', batch_size: 2000, batch_timeout_ms: 5000,
  dedup_enabled: true, dedup_field: 'raw_data', dedup_algo: 'md5',
  poll_interval_secs: 30, retry_count: 3, pause_on_fail: true,
  timestamp_field: '@timestamp',
  excluded_fields: [],
};

export default function PipelineEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ ...DEFAULT });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Source step state
  const [connections, setConnections] = useState([]);
  const [tsInfo, setTsInfo] = useState(null);
  const [tsLoading, setTsLoading] = useState(false);
  const [indices, setIndices] = useState([]);
  // Index discovery state
  const [discoveredIndexes, setDiscoveredIndexes] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState('');

  // Destination step state
  const [clusters, setClusters] = useState([]);
  const [databases, setDatabases] = useState([]);
  const [tables, setTables] = useState([]);
  const [columns, setColumns] = useState([]);

  // Field mapping step state
  const [sampleFields, setSampleFields] = useState([]);
  const [sampleDocs, setSampleDocs] = useState([]);
  const [sampling, setSampling] = useState(false);

  // Field exclusion step state
  const [availableFields, setAvailableFields] = useState([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState('');

  useEffect(() => {
    api.getConnections().then(setConnections);
    api.getClusters().then(setClusters);

    if (id) {
      api.getPipeline(id).then(async p => {
        setForm({ ...DEFAULT, ...p });

        // Pre-load connection indices so the index hints populate
        if (p.opensearch_connection_id) {
          try {
            const rows = await api.getIndices(p.opensearch_connection_id);
            setIndices(rows.map(r => r.index));
          } catch {}
        }

        // Pre-load ClickHouse hierarchy so dropdowns are editable
        if (p.clickhouse_cluster_id) {
          try {
            const dbs = await api.getDatabases(p.clickhouse_cluster_id);
            setDatabases(dbs);
            if (p.clickhouse_database) {
              try {
                const tbls = await api.getTables(p.clickhouse_cluster_id, p.clickhouse_database);
                setTables(tbls);
                if (p.clickhouse_table) {
                  try {
                    // Load columns for display only — do NOT overwrite existing field_mappings
                    const cols = await api.getColumns(p.clickhouse_cluster_id, p.clickhouse_database, p.clickhouse_table);
                    setColumns(cols);
                  } catch {}
                }
              } catch {}
            }
          } catch {}
        }
      });
    }
  }, [id]);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  // Load indices when connection changes
  async function onConnectionChange(connId) {
    set('opensearch_connection_id', connId);
    if (!connId) return;
    try {
      const rows = await api.getIndices(connId);
      setIndices(rows.map(r => r.index));
    } catch { setIndices([]); }
  }

  // Discover physical indexes matching the current index_pattern
  async function discoverIndexes() {
    if (!form.opensearch_connection_id || !form.index_pattern) return;
    setDiscovering(true);
    setDiscoverError('');
    setDiscoveredIndexes([]);
    try {
      const rows = await api.discoverIndexes(form.opensearch_connection_id, form.index_pattern);
      setDiscoveredIndexes(rows);
    } catch (e) {
      setDiscoverError(e.message);
    } finally {
      setDiscovering(false);
    }
  }

  function toggleIndexSelection(indexName) {
    setForm(f => {
      const current = Array.isArray(f.index_set_filter) ? f.index_set_filter : [];
      const next = current.includes(indexName)
        ? current.filter(n => n !== indexName)
        : [...current, indexName];
      return { ...f, index_set_filter: next };
    });
  }

  function selectAllDiscovered() {
    setForm(f => ({ ...f, index_set_filter: discoveredIndexes.map(i => i.index) }));
  }

  function clearIndexSelection() {
    setForm(f => ({ ...f, index_set_filter: [] }));
  }

  // Load timestamps for pattern
  async function loadTs() {
    if (!form.opensearch_connection_id || !form.index_pattern) return;
    setTsLoading(true);
    setTsInfo(null);
    try {
      const info = await api.getTimestamps(form.opensearch_connection_id, form.index_pattern);
      setTsInfo(info);
    } catch (e) {
      setTsInfo({ error: e.message });
    } finally {
      setTsLoading(false);
    }
  }

  // Load databases when cluster changes
  async function onClusterChange(clusterId) {
    set('clickhouse_cluster_id', clusterId);
    set('clickhouse_database', '');
    set('clickhouse_table', '');
    setDatabases([]);
    setTables([]);
    setColumns([]);
    if (!clusterId) return;
    try { setDatabases(await api.getDatabases(clusterId)); } catch { setDatabases([]); }
  }

  async function onDbChange(db) {
    set('clickhouse_database', db);
    set('clickhouse_table', '');
    setTables([]);
    setColumns([]);
    if (!db || !form.clickhouse_cluster_id) return;
    try { setTables(await api.getTables(form.clickhouse_cluster_id, db)); } catch { setTables([]); }
  }

  async function onTableChange(table) {
    set('clickhouse_table', table);
    setColumns([]);
    if (!table) return;
    try {
      const cols = await api.getColumns(form.clickhouse_cluster_id, form.clickhouse_database, table);
      setColumns(cols);
      // Auto-init mappings for new columns
      setForm(f => {
        const existing = new Set(f.field_mappings.map(m => m.dest));
        const newMappings = [...f.field_mappings];
        cols.forEach(col => {
          if (!existing.has(col.name)) {
            newMappings.push({ dest: col.name, source_type: 'field', source_value: col.name, required: !col.default_expression });
          }
        });
        return { ...f, field_mappings: newMappings };
      });
    } catch { setColumns([]); }
  }

  async function loadSample() {
    if (!form.opensearch_connection_id || !form.index_pattern) return;
    setSampling(true);
    try {
      const res = await api.sampleDocs(form.opensearch_connection_id, form.index_pattern, 3);
      setSampleFields(res.fields || []);
      setSampleDocs(res.docs || []);
    } catch { setSampleFields([]); setSampleDocs([]); }
    finally { setSampling(false); }
  }

  function updateMapping(idx, key, val) {
    setForm(f => {
      const mappings = [...f.field_mappings];
      mappings[idx] = { ...mappings[idx], [key]: val };
      return { ...f, field_mappings: mappings };
    });
  }

  function addMapping() {
    setForm(f => ({ ...f, field_mappings: [...f.field_mappings, { dest: '', source_type: 'field', source_value: '' }] }));
  }

  function removeMapping(idx) {
    setForm(f => ({ ...f, field_mappings: f.field_mappings.filter((_, i) => i !== idx) }));
  }

  async function loadAvailableFields() {
    if (!form.opensearch_connection_id || !form.index_pattern) {
      setFieldsError('Select a connection and index pattern first.');
      return;
    }
    setFieldsLoading(true);
    setFieldsError('');
    try {
      const data = await api.getSampleFields(form.opensearch_connection_id, form.index_pattern);
      setAvailableFields(data.fields || []);
      if (data.warning) setFieldsError(data.warning);
    } catch (e) {
      setFieldsError(e.message);
    } finally {
      setFieldsLoading(false);
    }
  }

  function toggleExcluded(field) {
    setForm(f => {
      const current = new Set(f.excluded_fields || []);
      if (current.has(field)) current.delete(field); else current.add(field);
      return { ...f, excluded_fields: [...current] };
    });
  }

  function selectAllGl2() {
    setForm(f => {
      const gl2Fields = availableFields.filter(k => k.startsWith('gl2_'));
      const current = new Set(f.excluded_fields || []);
      gl2Fields.forEach(k => current.add(k));
      return { ...f, excluded_fields: [...current] };
    });
  }

  function clearExclusions() {
    setForm(f => ({ ...f, excluded_fields: [] }));
  }

  async function save() {
    setError('');
    setSaving(true);
    try {
      if (id) await api.updatePipeline(id, form);
      else await api.createPipeline(form);
      navigate('/pipelines');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Get sample value for a field path
  function getSampleValue(path) {
    if (!sampleDocs.length || !path) return '';
    const doc = sampleDocs[0];
    const parts = path.split('.');
    let cur = doc;
    for (const p of parts) {
      if (cur == null) return '';
      cur = cur[p];
    }
    if (typeof cur === 'object') return JSON.stringify(cur).slice(0, 60);
    return String(cur ?? '');
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">{id ? 'Edit' : 'New'} Pipeline</h1>
        <p className="text-sm text-slate-400 mt-0.5">Configure how logs flow from OpenSearch to ClickHouse</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 mb-8">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <button
              onClick={() => setStep(i)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                i === step ? 'bg-brand-600 text-white' : i < step ? 'bg-brand-900/40 text-brand-400' : 'text-slate-500'
              }`}
            >
              {i + 1}. {s}
            </button>
            {i < STEPS.length - 1 && <ChevronRight size={14} className="text-slate-700 flex-shrink-0" />}
          </React.Fragment>
        ))}
      </div>

      {/* Name field (always visible) */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="label">Pipeline Name</label>
          <input className="input w-full" value={form.name} onChange={e => set('name', e.target.value)} placeholder="FortiGate - Acme Corp" />
        </div>
        <div>
          <label className="label">Description</label>
          <input className="input w-full" value={form.description} onChange={e => set('description', e.target.value)} placeholder="Optional description" />
        </div>
      </div>

      {/* Step 0: Source */}
      {step === 0 && (
        <div className="space-y-5">
          <Section title="OpenSearch Source">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="label">Connection</label>
                <select className="input w-full" value={form.opensearch_connection_id} onChange={e => onConnectionChange(e.target.value)}>
                  <option value="">Select connection…</option>
                  {connections.map(c => <option key={c.id} value={c.id}>{c.name} ({c.url})</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="label">Index Pattern</label>
                <div className="flex gap-2">
                  <input className="input flex-1" value={form.index_pattern}
                    onChange={e => set('index_pattern', e.target.value)}
                    placeholder="test-firewall_* or wazuh-alerts-*" />
                  <button onClick={loadTs} disabled={tsLoading} className="btn-ghost whitespace-nowrap text-xs">
                    {tsLoading ? <RefreshCw size={13} className="animate-spin" /> : 'Check Timestamps'}
                  </button>
                </div>
                {/* Available indices hint */}
                {indices.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {indices.filter(i => !form.index_pattern || i.includes(form.index_pattern.replace('*',''))).slice(0, 8).map(i => (
                      <button key={i} onClick={() => set('index_pattern', i)}
                        className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 hover:border-brand-500 transition-colors">
                        {i}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Timestamp info */}
            {tsInfo && (
              <div className="mt-4 bg-slate-800 rounded-lg p-4">
                {tsInfo.error ? (
                  <div className="text-red-400 text-xs">{tsInfo.error}</div>
                ) : (
                  <div className="grid grid-cols-3 gap-4 text-xs">
                    <div><div className="text-slate-400 mb-1">Oldest Log</div><div className="text-white font-mono">{tsInfo.oldest_ts || '—'}</div></div>
                    <div><div className="text-slate-400 mb-1">Newest Log</div><div className="text-white font-mono">{tsInfo.newest_ts || '—'}</div></div>
                    <div><div className="text-slate-400 mb-1">Total Docs</div><div className="text-white">{(tsInfo.doc_count || 0).toLocaleString()}</div></div>
                  </div>
                )}
              </div>
            )}
          </Section>

          {/* Index Discovery — resolve wildcard to physical indexes */}
          <Section title="Physical Index Selection (Optional)">
            <p className="text-xs text-slate-400 mb-3">
              Discover physical indexes matching your pattern and select specific ones to track independently.
              Leave all unselected to use the pattern as-is.
            </p>
            <button
              onClick={discoverIndexes}
              disabled={discovering || !form.opensearch_connection_id || !form.index_pattern}
              className="btn-ghost text-xs mb-3"
            >
              {discovering ? <RefreshCw size={13} className="animate-spin inline mr-1" /> : null}
              {discovering ? 'Discovering…' : 'Discover Matching Indexes'}
            </button>
            {discoverError && <div className="text-red-400 text-xs mb-2">{discoverError}</div>}
            {discoveredIndexes.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-400">{discoveredIndexes.length} index{discoveredIndexes.length !== 1 ? 'es' : ''} found</span>
                  <div className="flex gap-2">
                    <button onClick={selectAllDiscovered} className="text-xs text-brand-400 hover:text-brand-300">Select all</button>
                    <button onClick={clearIndexSelection} className="text-xs text-slate-400 hover:text-slate-300">Clear</button>
                  </div>
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {discoveredIndexes.map(idx => {
                    const selected = (form.index_set_filter || []).includes(idx.index);
                    return (
                      <label key={idx.index} className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-colors ${selected ? 'bg-brand-900/30 border border-brand-700' : 'bg-slate-800 border border-slate-700 hover:border-slate-600'}`}>
                        <input type="checkbox" checked={selected} onChange={() => toggleIndexSelection(idx.index)} className="flex-shrink-0" />
                        <span className="text-xs font-mono text-slate-200 flex-1">{idx.index}</span>
                        <span className="text-xs text-slate-500">{idx['docs.count'] ? Number(idx['docs.count']).toLocaleString() + ' docs' : ''}</span>
                        <span className="text-xs text-slate-500">{idx['store.size'] || ''}</span>
                      </label>
                    );
                  })}
                </div>
                {(form.index_set_filter || []).length > 0 && (
                  <div className="mt-2 text-xs text-brand-400">
                    {(form.index_set_filter || []).length} index{(form.index_set_filter || []).length !== 1 ? 'es' : ''} selected — pipeline will track each independently
                  </div>
                )}
              </div>
            )}
          </Section>

          <Section title="Pull Mode">
            <div className="space-y-3">
              {[
                ['continuous', 'Continuous', 'Pull new logs as they arrive (live ingestion)'],
                ['from_date',  'From Date',  'Backfill from a specific date until now'],
                ['date_range', 'Date Range', 'Pull logs between two specific dates (backfill only)'],
              ].map(([val, label, desc]) => (
                <label key={val} className="flex items-start gap-3 cursor-pointer">
                  <input type="radio" name="pull_mode" value={val} checked={form.pull_mode === val}
                    onChange={() => set('pull_mode', val)} className="mt-0.5" />
                  <div>
                    <div className="text-sm text-white">{label}</div>
                    <div className="text-xs text-slate-400">{desc}</div>
                  </div>
                </label>
              ))}
              {(form.pull_mode === 'from_date' || form.pull_mode === 'date_range') && (
                <div className="grid grid-cols-2 gap-4 mt-2 pl-6">
                  <div>
                    <label className="label">From</label>
                    <input type="datetime-local" className="input w-full" value={form.pull_from_date}
                      onChange={e => set('pull_from_date', e.target.value)} />
                  </div>
                  {form.pull_mode === 'date_range' && (
                    <div>
                      <label className="label">To</label>
                      <input type="datetime-local" className="input w-full" value={form.pull_to_date}
                        onChange={e => set('pull_to_date', e.target.value)} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </Section>
        </div>
      )}

      {/* Step 1: Destination */}
      {step === 1 && (
        <div className="space-y-5">
          <Section title="ClickHouse Destination">
            <div className="space-y-4">
              <div>
                <label className="label">Cluster</label>
                <select className="input w-full" value={form.clickhouse_cluster_id} onChange={e => onClusterChange(e.target.value)}>
                  <option value="">Select cluster…</option>
                  {clusters.map(c => <option key={c.id} value={c.id}>{c.name} ({c.url})</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Database</label>
                  <select className="input w-full" value={form.clickhouse_database} onChange={e => onDbChange(e.target.value)} disabled={!databases.length}>
                    <option value="">Select database…</option>
                    {databases.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Table</label>
                  <select className="input w-full" value={form.clickhouse_table} onChange={e => onTableChange(e.target.value)} disabled={!tables.length}>
                    <option value="">Select table…</option>
                    {tables.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              {columns.length > 0 && (
                <div className="bg-slate-800 rounded-lg p-3">
                  <div className="text-xs text-slate-400 mb-2">Table columns ({columns.length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {columns.map(c => (
                      <span key={c.name} className="px-2 py-0.5 bg-slate-700 text-slate-300 text-xs rounded font-mono">
                        {c.name} <span className="text-slate-500">{c.type}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>
        </div>
      )}

      {/* Step 2: Field Mapping */}
      {step === 2 && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Field Mappings</h3>
            <div className="flex gap-2">
              <button onClick={loadSample} disabled={sampling} className="btn-ghost text-xs flex items-center gap-1.5">
                {sampling ? <RefreshCw size={12} className="animate-spin" /> : <FlaskConical size={12} />}
                Load Sample Docs
              </button>
              <button onClick={addMapping} className="btn-ghost text-xs flex items-center gap-1.5">
                <Plus size={12} /> Add Row
              </button>
            </div>
          </div>

          {/* Quick-guide */}
          <div className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 text-xs space-y-2">
            <div className="text-slate-300 font-medium mb-1">How field mapping works (like Vector remap):</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-slate-400 font-mono">
              <span><span className="text-brand-400">field</span> → @timestamp</span><span className="text-slate-500">copies the @timestamp field value</span>
              <span><span className="text-brand-400">field</span> → agent.id</span><span className="text-slate-500">dot-path for nested fields</span>
              <span><span className="text-brand-400">field</span> → rule.level</span><span className="text-slate-500">works for any depth</span>
              <span><span className="text-brand-400">full_doc</span></span><span className="text-slate-500">entire document as JSON string</span>
              <span><span className="text-brand-400">static</span> → wazuh</span><span className="text-slate-500">hard-coded constant value</span>
              <span><span className="text-brand-400">md5</span> → _id</span><span className="text-slate-500">MD5 hash of a field (for dedup)</span>
            </div>
            {sampleDocs.length > 0
              ? <div className="text-slate-500 mt-1">{sampleFields.length} fields from sample — type a path or pick from the autocomplete list.</div>
              : <div className="text-amber-400/80 mt-1">Click <strong>Load Sample Docs</strong> to populate autocomplete suggestions.</div>
            }
          </div>

          <div className="space-y-2">
            {/* Header */}
            <div className="grid grid-cols-12 gap-2 text-xs text-slate-500 px-2">
              <div className="col-span-4">ClickHouse Column (destination)</div>
              <div className="col-span-2">Source Type</div>
              <div className="col-span-5">Source Field / Value</div>
              <div className="col-span-1"></div>
            </div>

            {form.field_mappings.map((m, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                <div className="col-span-4">
                  <input
                    className="input w-full text-xs font-mono"
                    value={m.dest}
                    onChange={e => updateMapping(i, 'dest', e.target.value)}
                    placeholder="column_name"
                  />
                </div>
                <div className="col-span-2">
                  <select className="input w-full text-xs" value={m.source_type}
                    onChange={e => updateMapping(i, 'source_type', e.target.value)}>
                    <option value="field">Field</option>
                    <option value="static">Static</option>
                    <option value="full_doc">Full Doc JSON</option>
                    <option value="now">Current Time</option>
                    <option value="md5">MD5 Hash</option>
                  </select>
                </div>
                <div className="col-span-5">
                  {m.source_type === 'field' ? (
                    <div>
                      {/* datalist gives autocomplete from sample but allows free typing */}
                      <datalist id={`sf-${i}`}>
                        {sampleFields.map(f => <option key={f} value={f} />)}
                      </datalist>
                      <input
                        list={`sf-${i}`}
                        className="input w-full text-xs font-mono"
                        value={m.source_value}
                        onChange={e => updateMapping(i, 'source_value', e.target.value)}
                        placeholder="e.g. @timestamp or agent.id"
                      />
                      {m.source_value && sampleDocs.length > 0 && (
                        <div className="text-xs text-slate-500 mt-0.5 truncate font-mono">
                          eg: {getSampleValue(m.source_value) || '(empty in sample)'}
                        </div>
                      )}
                    </div>
                  ) : m.source_type === 'static' ? (
                    <input className="input w-full text-xs" value={m.source_value}
                      onChange={e => updateMapping(i, 'source_value', e.target.value)} placeholder="Static value" />
                  ) : m.source_type === 'md5' ? (
                    <div>
                      <datalist id={`md5-${i}`}>
                        {sampleFields.map(f => <option key={f} value={f} />)}
                      </datalist>
                      <input
                        list={`md5-${i}`}
                        className="input w-full text-xs font-mono"
                        value={m.source_value}
                        onChange={e => updateMapping(i, 'source_value', e.target.value)}
                        placeholder="field to MD5 hash"
                      />
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500 px-2">
                      {m.source_type === 'full_doc' ? 'Full document as JSON string' : 'datetime(\'now\')'}
                    </div>
                  )}
                </div>
                <div className="col-span-1 flex justify-end">
                  <button onClick={() => removeMapping(i)} className="icon-btn text-red-400 hover:text-red-300"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}

            {form.field_mappings.length === 0 && (
              <div className="text-center py-8 text-slate-500 text-sm">
                No mappings yet. <button onClick={addMapping} className="text-brand-400 hover:underline">Add a row</button> or load a table in the Destination step to auto-populate.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Tagging & Batching */}
      {step === 3 && (
        <div className="space-y-5">
          <Section title="Customer & Product Tagging">
            <div className="grid grid-cols-2 gap-6">
              {[['customer', 'Customer'], ['product', 'Product']].map(([key, label]) => (
                <div key={key}>
                  <div className="text-sm font-medium text-white mb-3">{label}</div>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name={`${key}_source`} value="field"
                        checked={form[`${key}_source`] === 'field'} onChange={() => set(`${key}_source`, 'field')} />
                      <span className="text-sm text-slate-300">Read from field</span>
                    </label>
                    {form[`${key}_source`] === 'field' && (
                      <input className="input w-full text-sm ml-6" value={form[`${key}_value`]}
                        onChange={e => set(`${key}_value`, e.target.value)} placeholder={`_${key}`} />
                    )}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name={`${key}_source`} value="static"
                        checked={form[`${key}_source`] === 'static'} onChange={() => set(`${key}_source`, 'static')} />
                      <span className="text-sm text-slate-300">Static value</span>
                    </label>
                    {form[`${key}_source`] === 'static' && (
                      <input className="input w-full text-sm ml-6" value={form[`${key}_value`]}
                        onChange={e => set(`${key}_value`, e.target.value)} placeholder={key === 'customer' ? 'Acme Corp' : 'fortigate'} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Batching">
            <div className="space-y-4">
              <div>
                <label className="label">Batch Mode</label>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    ['count', 'By Count', 'Flush after N events'],
                    ['time',  'By Time',  'Flush after N milliseconds'],
                    ['both',  'Both',     'Flush whichever limit hits first'],
                  ].map(([val, label, desc]) => (
                    <label key={val} className={`border rounded-lg p-3 cursor-pointer transition-colors ${form.batch_mode === val ? 'border-brand-500 bg-brand-900/20' : 'border-slate-700 hover:border-slate-600'}`}>
                      <input type="radio" name="batch_mode" value={val} checked={form.batch_mode === val}
                        onChange={() => set('batch_mode', val)} className="sr-only" />
                      <div className="text-sm font-medium text-white">{label}</div>
                      <div className="text-xs text-slate-400 mt-0.5">{desc}</div>
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {(form.batch_mode === 'count' || form.batch_mode === 'both') && (
                  <div>
                    <label className="label">Event Count</label>
                    <input type="number" className="input w-full" value={form.batch_size}
                      onChange={e => set('batch_size', +e.target.value)} min={100} max={50000} />
                    <div className="text-xs text-slate-500 mt-1">Flush when this many events are buffered</div>
                  </div>
                )}
                {(form.batch_mode === 'time' || form.batch_mode === 'both') && (
                  <div>
                    <label className="label">Timeout (ms)</label>
                    <input type="number" className="input w-full" value={form.batch_timeout_ms}
                      onChange={e => set('batch_timeout_ms', +e.target.value)} min={500} />
                    <div className="text-xs text-slate-500 mt-1">Flush after this many milliseconds even if batch isn't full</div>
                  </div>
                )}
              </div>
            </div>
          </Section>

          <Section title="Deduplication">
            <div className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={form.dedup_enabled}
                  onChange={e => set('dedup_enabled', e.target.checked)} className="rounded" />
                <div>
                  <div className="text-sm text-white">Enable deduplication</div>
                  <div className="text-xs text-slate-400">Compute event_id hash and skip already-seen events</div>
                </div>
              </label>
              {form.dedup_enabled && (
                <div className="grid grid-cols-2 gap-4 pl-6">
                  <div>
                    <label className="label">Field to Hash</label>
                    <input className="input w-full text-sm" value={form.dedup_field}
                      onChange={e => set('dedup_field', e.target.value)} placeholder="raw_data" />
                  </div>
                  <div>
                    <label className="label">Algorithm</label>
                    <select className="input w-full text-sm" value={form.dedup_algo} onChange={e => set('dedup_algo', e.target.value)}>
                      <option value="md5">MD5</option>
                      <option value="sha256">SHA-256</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          </Section>

          <Section title="Schedule & Resilience">
            <div className="mb-4">
              <label className="label">Timestamp Field</label>
              <input type="text" className="input w-full" value={form.timestamp_field}
                onChange={e => set('timestamp_field', e.target.value)}
                placeholder="@timestamp" />
              <p className="text-xs text-slate-500 mt-1">OpenSearch field used for sorting and pagination. Default: <code>@timestamp</code>. Change to <code>timestamp</code> for Graylog-style indices.</p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="label">Poll Interval (sec)</label>
                <input type="number" className="input w-full" value={form.poll_interval_secs}
                  onChange={e => set('poll_interval_secs', +e.target.value)} min={5} />
              </div>
              <div>
                <label className="label">Retry Count</label>
                <input type="number" className="input w-full" value={form.retry_count}
                  onChange={e => set('retry_count', +e.target.value)} min={0} max={10} />
              </div>
              <div className="flex items-center gap-2 mt-6">
                <input type="checkbox" id="pause_on_fail" checked={form.pause_on_fail}
                  onChange={e => set('pause_on_fail', e.target.checked)} className="rounded" />
                <label htmlFor="pause_on_fail" className="text-sm text-slate-300">Pause on repeated failure</label>
              </div>
            </div>
          </Section>

          <Section title="Field Exclusions">
            <p className="text-xs text-slate-400 mb-4">
              Strip unwanted fields from <code className="text-brand-400">raw_data</code> before inserting into ClickHouse.
              Useful to remove Graylog metadata (gl2_*, streams) that bloat storage without adding value.
            </p>
            <div className="flex flex-wrap gap-2 mb-4">
              <button
                onClick={loadAvailableFields}
                disabled={fieldsLoading}
                className="btn-ghost text-xs flex items-center gap-1.5"
              >
                <RefreshCw size={12} className={fieldsLoading ? 'animate-spin' : ''} />
                {fieldsLoading ? 'Loading…' : 'Fetch fields from sample doc'}
              </button>
              {availableFields.some(f => f.startsWith('gl2_')) && (
                <button onClick={selectAllGl2} className="btn-ghost text-xs">
                  Select all gl2_*
                </button>
              )}
              {(form.excluded_fields || []).length > 0 && (
                <button onClick={clearExclusions} className="btn-ghost text-xs text-red-400">
                  Clear all
                </button>
              )}
            </div>
            {fieldsError && <p className="text-xs text-red-400 mb-3">{fieldsError}</p>}

            {/* Selected exclusions as tags */}
            {(form.excluded_fields || []).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-4">
                {(form.excluded_fields || []).map(f => (
                  <span
                    key={f}
                    onClick={() => toggleExcluded(f)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-900/40 text-red-300 border border-red-800 cursor-pointer hover:bg-red-900/60"
                    title="Click to remove"
                  >
                    {f} ×
                  </span>
                ))}
              </div>
            )}

            {/* Checklist of discovered fields */}
            {availableFields.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-1 max-h-64 overflow-y-auto border border-slate-700 rounded-lg p-3 bg-slate-950">
                {availableFields.map(f => {
                  const checked = (form.excluded_fields || []).includes(f);
                  return (
                    <label key={f} className="flex items-center gap-2 cursor-pointer py-0.5 hover:text-white">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleExcluded(f)}
                        className="rounded accent-brand-500 shrink-0"
                      />
                      <span className={`text-xs font-mono truncate ${checked ? 'text-red-300' : 'text-slate-400'}`}>{f}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {availableFields.length === 0 && !fieldsLoading && (
              <p className="text-xs text-slate-500">Click "Fetch fields" to discover available fields from a sample document.</p>
            )}
          </Section>
        </div>
      )}

      {/* Step 4: Review */}
      {step === 4 && (
        <div className="space-y-4">
          <Section title="Summary">
            <div className="space-y-3 text-sm">
              <Row label="Name" value={form.name} />
              <Row label="Source" value={`${connections.find(c => c.id == form.opensearch_connection_id)?.name || '—'} → ${form.index_pattern}`} />
              <Row label="Pull Mode" value={form.pull_mode} />
              <Row label="Destination" value={`${clusters.find(c => c.id == form.clickhouse_cluster_id)?.name || '—'} → ${form.clickhouse_database}.${form.clickhouse_table}`} />
              <Row label="Field Mappings" value={`${form.field_mappings.length} columns mapped`} />
              <Row label="Customer" value={`${form.customer_source === 'field' ? 'from field' : 'static'}: ${form.customer_value}`} />
              <Row label="Product" value={`${form.product_source === 'field' ? 'from field' : 'static'}: ${form.product_value}`} />
              <Row label="Batch Mode" value={`${form.batch_mode} (${form.batch_size} events / ${form.batch_timeout_ms}ms)`} />
              <Row label="Dedup" value={form.dedup_enabled ? `${form.dedup_algo.toUpperCase()} of ${form.dedup_field}` : 'Disabled'} />
              <Row label="Poll Interval" value={`${form.poll_interval_secs}s`} />
              <Row label="Field Exclusions" value={(form.excluded_fields || []).length > 0 ? `${form.excluded_fields.length} field(s) excluded` : 'None'} />
            </div>
          </Section>
          {error && <div className="bg-red-900/30 border border-red-700 text-red-300 text-sm px-4 py-3 rounded-lg">{error}</div>}
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between mt-8 pt-6 border-t border-slate-800">
        <button
          onClick={() => step > 0 ? setStep(s => s - 1) : navigate('/pipelines')}
          className="btn-ghost flex items-center gap-2"
        >
          <ChevronLeft size={15} /> {step === 0 ? 'Cancel' : 'Back'}
        </button>
        <div className="flex gap-3">
          {step < STEPS.length - 1 ? (
            <button onClick={() => setStep(s => s + 1)} className="btn-primary flex items-center gap-2">
              Next <ChevronRight size={15} />
            </button>
          ) : (
            <button onClick={save} disabled={saving} className="btn-primary">
              {saving ? 'Saving…' : id ? 'Update Pipeline' : 'Create Pipeline'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-white mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex gap-4">
      <div className="w-36 text-slate-400 flex-shrink-0">{label}</div>
      <div className="text-white">{value}</div>
    </div>
  );
}
