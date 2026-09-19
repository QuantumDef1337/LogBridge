import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Plus, Trash2, RefreshCw, FlaskConical } from 'lucide-react';
import { api } from '../api';

const STEPS = ['Source', 'Destination', 'Field Mapping', 'Tagging & Batching', 'Review'];

// ── Schedule presets ──────────────────────────────────────────────────────────
function nextCronTrigger(intervalHours, dayOfWeek) {
  const now = new Date();
  const trigger = new Date(now);
  if (dayOfWeek !== undefined) {
    // next Sunday midnight
    const daysUntil = (7 - now.getDay() + dayOfWeek) % 7 || 7;
    trigger.setDate(now.getDate() + daysUntil);
    trigger.setHours(0, 0, 0, 0);
  } else {
    // next multiple of intervalHours
    const h = now.getHours();
    const nextH = Math.ceil((h + 1) / intervalHours) * intervalHours;
    if (nextH >= 24) {
      trigger.setDate(now.getDate() + 1);
      trigger.setHours(0, 0, 0, 0);
    } else {
      trigger.setHours(nextH, 0, 0, 0);
    }
  }
  return trigger;
}

function fmtPresetExample(trigger, lookbackHours) {
  const from = new Date(trigger.getTime() - lookbackHours * 3600 * 1000);
  const fmtDate = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const fmtTime = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const triggerStr = `${fmtDate(trigger)} at ${fmtTime(trigger)}`;
  const fromStr = from.getDate() !== trigger.getDate()
    ? `${fmtDate(from)} ${fmtTime(from)}`
    : fmtTime(from);
  const toStr = fmtTime(trigger);
  return `${triggerStr}  →  pulls ${fromStr} to ${toStr}`;
}

const SCHEDULE_PRESETS = [
  {
    id: 'daily',
    label: 'Daily at midnight — pull full previous day',
    fireTimes: 'Fires once a day at 12:00 AM (midnight)',
    get example() { const t = nextCronTrigger(24); return fmtPresetExample(t, 24) + ' (full previous day)'; },
    cron: '0 0 * * *',
    lookback: 24,
  },
  {
    id: 'every6h',
    label: 'Every 6 hours — pull previous 6 hours',
    fireTimes: 'Fires 4× per day at 12:00 AM, 06:00 AM, 12:00 PM, 06:00 PM',
    get example() { const t = nextCronTrigger(6); return fmtPresetExample(t, 6) + ' (6-hour window)'; },
    cron: '0 */6 * * *',
    lookback: 6,
  },
  {
    id: 'hourly',
    label: 'Every hour — pull previous hour',
    fireTimes: 'Fires 24× per day at the top of every hour (01:00, 02:00 … 24:00)',
    get example() { const t = nextCronTrigger(1); return fmtPresetExample(t, 1) + ' (1-hour window)'; },
    cron: '0 * * * *',
    lookback: 1,
  },
  {
    id: 'weekly',
    label: 'Weekly on Sunday midnight — pull previous 7 days',
    fireTimes: 'Fires once a week on Sunday at 12:00 AM (midnight)',
    get example() { const t = nextCronTrigger(168, 0); return fmtPresetExample(t, 168) + ' (7-day window)'; },
    cron: '0 0 * * 0',
    lookback: 168,
  },
];

function scheduleExample(cron, lookback) {
  const p = SCHEDULE_PRESETS.find(p => p.cron === cron && p.lookback === lookback);
  if (p) return p.example;
  return `At each trigger, pulls the ${lookback}h window ending at trigger time`;
}

// ── Visual Schedule Builder helpers ──────────────────────────────────────────

function compactDays(days) {
  if (!days || days.length === 0) return '*';
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return '*';
  const segs = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) { end = sorted[i]; }
    else {
      segs.push(end - start >= 2 ? `${start}-${end}` : start === end ? `${start}` : `${start},${end}`);
      start = end = sorted[i];
    }
  }
  segs.push(end - start >= 2 ? `${start}-${end}` : start === end ? `${start}` : `${start},${end}`);
  return segs.join(',');
}

function buildCron(b) {
  switch (b.type) {
    case 'every_minutes': return `*/${b.n} * * * *`;
    case 'every_hours':   return `0 */${b.n} * * *`;
    case 'daily':         return `${b.minute} ${b.hour} * * *`;
    case 'weekly':        return `${b.minute} ${b.hour} * * ${compactDays(b.days)}`;
    case 'monthly':       return `${b.minute} ${b.hour} ${b.dom} * *`;
    default:              return '0 0 * * *';
  }
}

const CB_DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function fmtTime12(hour, minute) {
  const h12 = hour % 12 || 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h12}:${String(minute).padStart(2,'0')} ${ampm}`;
}

function ordinalSuffix(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function describeCron(b) {
  switch (b.type) {
    case 'every_minutes': return `Runs every ${b.n} minute${b.n !== 1 ? 's' : ''}`;
    case 'every_hours':   return `Runs every ${b.n} hour${b.n !== 1 ? 's' : ''}`;
    case 'daily':         return `Runs every day at ${fmtTime12(b.hour, b.minute)}`;
    case 'weekly': {
      if (!b.days || b.days.length === 0) return 'Select at least one day';
      const sorted = [...b.days].sort((a, c) => a - c);
      const t = fmtTime12(b.hour, b.minute);
      if (sorted.length === 7) return `Runs every day at ${t}`;
      if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) return `Runs every weekday at ${t}`;
      if (sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6) return `Runs on weekends at ${t}`;
      const names = sorted.map(d => CB_DAY_NAMES[d]);
      const last = names.pop();
      return `Runs every ${names.length ? names.join(', ') + ' and ' + last : last} at ${t}`;
    }
    case 'monthly': return `Runs on the ${ordinalSuffix(b.dom)} of every month at ${fmtTime12(b.hour, b.minute)}`;
    default: return '';
  }
}

function lookbackToHours(value, unit) {
  if (unit === 'minutes') return value / 60;
  if (unit === 'days') return value * 24;
  return value;
}

function suggestLookback(b) {
  switch (b.type) {
    case 'every_minutes': return { value: b.n, unit: 'minutes' };
    case 'every_hours':   return { value: b.n, unit: 'hours' };
    case 'daily':         return { value: 24, unit: 'hours' };
    case 'weekly':        return { value: 7, unit: 'days' };
    case 'monthly':       return { value: 30, unit: 'days' };
    default:              return { value: 24, unit: 'hours' };
  }
}

function validateBuilder(b) {
  switch (b.type) {
    case 'every_minutes':
      if (!b.n || b.n < 1 || b.n > 59) return 'Interval must be 1–59 minutes.';
      break;
    case 'every_hours':
      if (!b.n || b.n < 1 || b.n > 23) return 'Interval must be 1–23 hours.';
      break;
    case 'daily':
      if (b.hour < 0 || b.hour > 23) return 'Hour must be 0–23.';
      if (b.minute < 0 || b.minute > 59) return 'Minute must be 0–59.';
      break;
    case 'weekly':
      if (!b.days || b.days.length === 0) return 'Select at least one day of the week.';
      if (b.hour < 0 || b.hour > 23) return 'Hour must be 0–23.';
      if (b.minute < 0 || b.minute > 59) return 'Minute must be 0–59.';
      break;
    case 'monthly':
      if (!b.dom || b.dom < 1 || b.dom > 28) return 'Day must be 1–28.';
      if (b.hour < 0 || b.hour > 23) return 'Hour must be 0–23.';
      if (b.minute < 0 || b.minute > 59) return 'Minute must be 0–59.';
      break;
  }
  return null;
}

// Efficient next-run calculator for visual builder types (no scanning loop)
function nextRunFromBuilder(b) {
  const now = new Date();
  switch (b.type) {
    case 'every_minutes': {
      const n = b.n || 1;
      const elapsed = now.getMinutes() % n;
      const wait = elapsed === 0 ? n : n - elapsed;
      const d = new Date(now.getTime() + wait * 60000);
      d.setSeconds(0, 0);
      return d;
    }
    case 'every_hours': {
      const n = b.n || 1;
      const elapsed = now.getHours() % n;
      const wait = elapsed === 0 ? n : n - elapsed;
      const d = new Date(now.getTime() + wait * 3600000);
      d.setMinutes(0, 0, 0);
      return d;
    }
    case 'daily': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), b.hour, b.minute, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
    case 'weekly': {
      if (!b.days || b.days.length === 0) return null;
      const sorted = [...b.days].sort((a, c) => a - c);
      for (let i = 0; i < 8; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, b.hour, b.minute, 0, 0);
        if (d > now && sorted.includes(d.getDay())) return d;
      }
      return null;
    }
    case 'monthly': {
      for (let m = 0; m < 3; m++) {
        const d = new Date(now.getFullYear(), now.getMonth() + m, b.dom, b.hour, b.minute, 0, 0);
        if (d > now) return d;
      }
      return null;
    }
    default: return null;
  }
}

// Parses one cron field into a Set of allowed values, or null for '*'
function parseCronFieldFE(field, min, max) {
  if (field === '*') return null;
  const vals = new Set();
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      const s = parseInt(step);
      if (!s) return null;
      const [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
      for (let v = (isNaN(lo) ? min : lo); v <= (isNaN(hi) ? max : hi); v += s) vals.add(v);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      for (let v = lo; v <= hi; v++) vals.add(v);
    } else {
      const n = parseInt(part);
      if (!isNaN(n)) vals.add(n);
    }
  }
  return vals;
}

// Generic minute-by-minute scanner for Advanced Cron validation (up to maxDays out)
function nextCronRunGeneric(expr, maxDays = 35) {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  try {
    const [minF, hourF, domF, monF, dowF] = parts;
    const minsAllowed  = parseCronFieldFE(minF,  0, 59);
    const hoursAllowed = parseCronFieldFE(hourF, 0, 23);
    const domsAllowed  = parseCronFieldFE(domF,  1, 31);
    const monsAllowed  = parseCronFieldFE(monF,  1, 12);
    const dowsAllowed  = parseCronFieldFE(dowF,  0, 6);
    const limit = maxDays * 24 * 60;
    const start = new Date();
    start.setSeconds(0, 0);
    start.setTime(start.getTime() + 60000);
    for (let i = 0; i < limit; i++) {
      const d = new Date(start.getTime() + i * 60000);
      if (monsAllowed  && !monsAllowed.has(d.getMonth() + 1)) continue;
      if (domsAllowed  && !domsAllowed.has(d.getDate()))      continue;
      if (dowsAllowed  && !dowsAllowed.has(d.getDay()))       continue;
      if (hoursAllowed && !hoursAllowed.has(d.getHours()))    continue;
      if (minsAllowed  && !minsAllowed.has(d.getMinutes()))   continue;
      return d;
    }
    return null;
  } catch { return null; }
}

// Convert stored schedule_lookback_hours back to a UI-friendly value+unit pair
function hoursToLookback(h) {
  if (h < 1) return { value: Math.max(1, Math.round(h * 60)), unit: 'minutes' };
  if (h >= 24 && h % 24 === 0) return { value: h / 24, unit: 'days' };
  return { value: h, unit: 'hours' };
}

// Try to reverse-engineer a cron string back into cronBuilder state.
// Returns a builder object if the cron matches a visual pattern, null otherwise.
function parseCronToBuilder(cron) {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monthF, dowF] = parts;
  const isNum = s => /^\d+$/.test(s);

  // every_minutes: */N * * * *
  const evMin = minF.match(/^\*\/(\d+)$/);
  if (evMin && hourF === '*' && domF === '*' && monthF === '*' && dowF === '*') {
    const n = parseInt(evMin[1]);
    if (n >= 1 && n <= 59) return { type: 'every_minutes', n, hour: 0, minute: 0, days: [1,2,3,4,5], dom: 1 };
  }

  // every_hours: 0 */N * * *
  const evHr = hourF.match(/^\*\/(\d+)$/);
  if (minF === '0' && evHr && domF === '*' && monthF === '*' && dowF === '*') {
    const n = parseInt(evHr[1]);
    if (n >= 1 && n <= 23) return { type: 'every_hours', n, hour: 0, minute: 0, days: [1,2,3,4,5], dom: 1 };
  }

  const m = parseInt(minF), h = parseInt(hourF), dom = parseInt(domF);

  // monthly: M H DOM * *
  if (isNum(minF) && isNum(hourF) && isNum(domF) && monthF === '*' && dowF === '*') {
    if (dom >= 1 && dom <= 28) return { type: 'monthly', n: 15, hour: h, minute: m, days: [1,2,3,4,5], dom };
  }

  // weekly: M H * * DOW
  if (isNum(minF) && isNum(hourF) && domF === '*' && monthF === '*' && dowF !== '*') {
    const days = [];
    for (const part of dowF.split(',')) {
      if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        for (let d = lo; d <= hi; d++) days.push(d);
      } else { const d = parseInt(part); if (!isNaN(d)) days.push(d); }
    }
    if (days.length > 0) return { type: 'weekly', n: 15, hour: h, minute: m, days, dom: 1 };
  }

  // daily: M H * * *
  if (isNum(minF) && isNum(hourF) && domF === '*' && monthF === '*' && dowF === '*') {
    return { type: 'daily', n: 15, hour: h, minute: m, days: [1,2,3,4,5], dom: 1 };
  }

  return null; // complex/unsupported — fall back to Advanced Cron
}

function fmtNextRun(d) {
  if (!d) return null;
  const now = new Date();
  const today    = new Date(now.getFullYear(),  now.getMonth(),  now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  const dDay     = new Date(d.getFullYear(),    d.getMonth(),    d.getDate());
  const timeStr  = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (dDay.getTime() === today.getTime())    return `Today at ${timeStr}`;
  if (dDay.getTime() === tomorrow.getTime()) return `Tomorrow at ${timeStr}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${timeStr}`;
}

// Optional per-run time budget. 0 = unlimited. When the deadline is reached the run
// stops claiming chunks, lets in-flight inserts finish, and leaves the cursor unchanged
// so the next trigger safely re-covers the window (dedup skips what already landed).
function MaxRunTimeField({ form, set }) {
  const v = form.max_run_minutes || 0;
  return (
    <div>
      <label className="label">
        Max run time <span className="text-slate-500">(minutes — 0 = unlimited)</span>
      </label>
      <input
        type="number" min={0} step={1} value={v}
        onChange={e => set('max_run_minutes', Math.max(0, Math.floor(+e.target.value || 0)))}
        className="input w-32"
      />
      <p className="text-xs text-slate-500 mt-1">
        {v > 0
          ? `A trigger runs at most ${v} min. If it can't finish the window in time, the cursor is left unchanged and the next trigger resumes it — no data loss, no duplicates.`
          : 'No time limit — a trigger runs until the whole window is complete or a chunk is unrecoverable.'}
      </p>
    </div>
  );
}

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
  schedule_cron: '0 0 * * *',
  schedule_lookback_hours: 24,
  parallel_slices: 1,
  max_run_minutes: 0,
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

  // Schedule mode: 'preset' uses a quick-pick, 'custom' reveals cron+hours fields
  const [scheduleMode, setScheduleMode] = useState('preset');

  // Visual Schedule Builder state
  const [cronBuilder, setCronBuilder] = useState({
    type: 'every_minutes', n: 15,
    hour: 0, minute: 0,
    days: [1,2,3,4,5], dom: 1,
  });
  const [lookbackValue, setLookbackValue] = useState(15);
  const [lookbackUnit, setLookbackUnit] = useState('minutes');
  const [lookbackOverridden, setLookbackOverridden] = useState(false);
  const [lookbackMode, setLookbackMode] = useState('relative'); // 'relative' | 'absolute'
  const [absFrom, setAbsFrom] = useState(() => {
    const d = new Date(); d.setHours(d.getHours() - 24, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [absTo, setAbsTo] = useState(() => {
    const d = new Date(); d.setMinutes(0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cronSource, setCronSource] = useState('builder'); // 'builder' | 'advanced'
  const [advancedCronInput, setAdvancedCronInput] = useState('');
  const [advancedCronValid, setAdvancedCronValid] = useState(true);
  const [advancedCollapseConfirm, setAdvancedCollapseConfirm] = useState(false);

  // Run Now (scheduled pipelines)
  const [runningNow, setRunningNow] = useState(false);
  const [runNowResult, setRunNowResult] = useState(null);

  async function handleRunNow() {
    if (!id || runningNow) return;
    setRunningNow(true);
    setRunNowResult(null);
    try {
      const r = await api.runNow(id);
      setRunNowResult({ ok: true, fetched: r.fetched, inserted: r.inserted, skipped: r.skipped, dlq: r.dlq });
    } catch (e) {
      setRunNowResult({ ok: false, error: e.message });
    } finally {
      setRunningNow(false);
    }
  }

  useEffect(() => {
    api.getConnections().then(setConnections);
    api.getClusters().then(setClusters);

    if (id) {
      api.getPipeline(id).then(async p => {
        setForm({ ...DEFAULT, ...p });
        // Restore schedule mode: if saved values match no preset, show custom builder
        const matchesPreset = SCHEDULE_PRESETS.some(pr => pr.cron === (p.schedule_cron || DEFAULT.schedule_cron) && pr.lookback === (p.schedule_lookback_hours || DEFAULT.schedule_lookback_hours));
        if (!matchesPreset && p.pull_mode === 'scheduled') {
          setScheduleMode('custom');
          const savedCron = p.schedule_cron || DEFAULT.schedule_cron;
          const savedLookback = p.schedule_lookback_hours ?? DEFAULT.schedule_lookback_hours;

          // Restore lookback UI state
          const lb = hoursToLookback(savedLookback);
          setLookbackValue(lb.value);
          setLookbackUnit(lb.unit);
          setLookbackOverridden(false);

          // Try to restore visual builder state from the saved cron
          const parsed = parseCronToBuilder(savedCron);
          if (parsed) {
            setCronBuilder(parsed);
            setCronSource('builder');
            setAdvancedOpen(false);
          } else {
            // Complex expression — show it in Advanced Cron mode
            setCronSource('advanced');
            setAdvancedOpen(true);
            setAdvancedCronInput(savedCron);
            setAdvancedCronValid(true);
          }
        }

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

  // Load timestamps scoped to the selected pull-mode timeframe and selected indexes.
  async function loadTs() {
    if (!form.opensearch_connection_id || !form.index_pattern) return;
    setTsLoading(true);
    setTsInfo(null);
    try {
      const opts = {};
      let windowLabel = 'Entire index';

      if (form.pull_mode === 'date_range') {
        // When timestamp_field is a device-local field (e.g. 'timestamp' storing AEST),
        // pass values as local datetime strings — no UTC conversion — so OpenSearch
        // compares against the stored local values correctly.
        const isLocalField = form.timestamp_field && form.timestamp_field !== '@timestamp' && !form.timestamp_field.endsWith('_utc');
        const fmtLocal = (d) => {
          const pad = n => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
                 `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000`;
        };
        if (form.pull_from_date) {
          const d = new Date(form.pull_from_date); d.setMilliseconds(0);
          opts.from = isLocalField ? fmtLocal(d) : d.toISOString();
        }
        if (form.pull_to_date) {
          const d = new Date(form.pull_to_date);
          const isMidnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
          if (isMidnight) {
            d.setMilliseconds(0);
          } else if (d.getSeconds() === 0) {
            d.setSeconds(59);
            d.setMilliseconds(999);
          } else {
            d.setMilliseconds(999);
          }
          opts.to = isLocalField ? fmtLocal(d) : d.toISOString();
        }
        const f = form.pull_from_date ? new Date(form.pull_from_date).toLocaleDateString() : '?';
        const t = form.pull_to_date   ? new Date(form.pull_to_date).toLocaleDateString()   : '?';
        windowLabel = `${f} → ${t}`;

      } else if (form.pull_mode === 'from_date') {
        if (form.pull_from_date) opts.from = form.pull_from_date;
        opts.to = new Date().toISOString();
        const f = form.pull_from_date ? new Date(form.pull_from_date).toLocaleDateString() : '?';
        windowLabel = `${f} → now`;

      } else if (form.pull_mode === 'scheduled' && scheduleMode === 'custom') {
        // Preview window = now − lookback → now (what the next run will approximately pull)
        const lookbackMs = (form.schedule_lookback_hours || 1) * 3600 * 1000;
        const toDate   = new Date();
        const fromDate = new Date(toDate.getTime() - lookbackMs);
        opts.from = fromDate.toISOString();
        opts.to   = toDate.toISOString();
        windowLabel = `Last ${lookbackValue} ${lookbackUnit} (next run preview)`;

      } else if (form.pull_mode === 'scheduled' && scheduleMode === 'preset') {
        // Preset schedules have a fixed lookback
        const preset = SCHEDULE_PRESETS.find(p => p.cron === form.schedule_cron);
        const lookbackMs = (preset?.lookback || form.schedule_lookback_hours || 24) * 3600 * 1000;
        const toDate   = new Date();
        const fromDate = new Date(toDate.getTime() - lookbackMs);
        opts.from = fromDate.toISOString();
        opts.to   = toDate.toISOString();
        windowLabel = `Last ${preset?.lookback || form.schedule_lookback_hours}h (next run preview)`;

      } else if (form.pull_mode === 'continuous') {
        // Continuous has no window — show the last 24 hours as a live activity indicator
        const toDate   = new Date();
        const fromDate = new Date(toDate.getTime() - 24 * 3600 * 1000);
        opts.from = fromDate.toISOString();
        opts.to   = toDate.toISOString();
        windowLabel = 'Last 24 hours (recent activity)';
      }

      if (Array.isArray(form.index_set_filter) && form.index_set_filter.length) {
        opts.indexes = form.index_set_filter;
      }
      if (form.timestamp_field) opts.timestamp_field = form.timestamp_field;

      const info = await api.getTimestamps(form.opensearch_connection_id, form.index_pattern, opts);
      setTsInfo({ ...info, windowLabel });
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
    // Validate schedule before saving
    if (form.pull_mode === 'scheduled' && scheduleMode === 'custom') {
      if (cronSource === 'builder') {
        const builderErr = validateBuilder(cronBuilder);
        if (builderErr) { setError(builderErr); return; }
      } else {
        const nextRun = nextCronRunGeneric(form.schedule_cron, 35);
        if (!nextRun) { setError('Invalid cron expression. Check the Advanced Cron field.'); return; }
      }
      if (!(form.schedule_lookback_hours > 0)) {
        setError('Lookback must be greater than 0.');
        return;
      }
    }
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
                  <>
                    {tsInfo.windowLabel && (
                      <div className="text-xs text-brand-400 font-medium mb-2">
                        Window: {tsInfo.windowLabel}
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-4 text-xs">
                      <div><div className="text-slate-400 mb-1">Oldest Log</div><div className="text-white font-mono">{tsInfo.oldest_ts || '—'}</div></div>
                      <div><div className="text-slate-400 mb-1">Newest Log</div><div className="text-white font-mono">{tsInfo.newest_ts || '—'}</div></div>
                      <div><div className="text-slate-400 mb-1">Docs in window</div><div className="text-white">{(tsInfo.doc_count || 0).toLocaleString()}</div></div>
                    </div>
                  </>
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
                ['continuous', 'Continuous',       'Pull new logs as they arrive (live ingestion)'],
                ['from_date',  'From Date',         'Backfill from a specific date until now'],
                ['date_range', 'Date Range',        'Pull logs between two specific dates (backfill only)'],
                ['scheduled',  'Scheduled (Cron)',  'Pull on a cron schedule — auto-computes a rolling time window at each trigger'],
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
                <div className="mt-2 pl-6 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">From <span className="text-slate-500 font-normal">(local time)</span></label>
                      <input type="datetime-local" step="1" className="input w-full" value={form.pull_from_date}
                        onChange={e => set('pull_from_date', e.target.value)} />
                    </div>
                    {form.pull_mode === 'date_range' && (
                      <div>
                        <label className="label">To <span className="text-slate-500 font-normal">(local time)</span></label>
                        <input type="datetime-local" step="1" className="input w-full" value={form.pull_to_date}
                          onChange={e => set('pull_to_date', e.target.value)} />
                      </div>
                    )}
                  </div>

                  <div className="flex items-start gap-2 bg-slate-800/60 border border-slate-600/50 rounded-lg px-3 py-2 text-xs text-slate-400">
                    <span className="mt-0.5 text-slate-500">ℹ</span>
                    <span>Times are in your <strong className="text-slate-300">browser&apos;s local timezone</strong> and converted to UTC automatically. Make sure your browser timezone matches the device&apos;s log timezone for accurate results.</span>
                  </div>

                  {form.pull_mode === 'date_range' && (
                    <div className="border border-slate-700 rounded-lg p-4 space-y-3">
                      <div>
                        <label className="label">
                          Parallel Workers &mdash;{' '}
                          <span className="text-brand-400">
                            {form.parallel_slices === 1 ? '1 (sequential)' : `${form.parallel_slices} parallel time windows`}
                          </span>
                        </label>
                        <input type="range" min={1} max={10} value={form.parallel_slices}
                          onChange={e => set('parallel_slices', +e.target.value)}
                          className="w-full accent-brand-500" />
                        <div className="flex justify-between text-xs text-slate-500 mt-0.5">
                          <span>1</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10</span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500">
                        Splits the date range into N equal time windows and scrolls them in parallel.
                        Works for any index — single-shard or multi-shard.{' '}
                        <strong className="text-slate-400">4 workers on a 30-day range = each worker handles ~7.5 days concurrently.</strong>
                      </p>
                      {form.parallel_slices > 1 && (
                        <div className="text-xs text-amber-400/80 bg-amber-900/10 border border-amber-800/40 rounded px-3 py-2">
                          Parallel mode pulls the full date range in one shot, then auto-pauses. If interrupted, dedup ensures no duplicates on restart.
                        </div>
                      )}
                      <MaxRunTimeField form={form} set={set} />
                    </div>
                  )}
                </div>
              )}

              {form.pull_mode === 'scheduled' && (
                <div className="mt-3 pl-6 space-y-5 border-l-2 border-brand-700">

                  {/* First-run note */}
                  <div className="text-xs text-amber-400/80 bg-amber-900/10 border border-amber-800/40 rounded-lg px-3 py-2">
                    First run waits for the <strong>next scheduled time</strong>, then repeats on the cron schedule.
                  </div>

                  {/* ── Preset picker ── */}
                  <div className="space-y-2">
                    {SCHEDULE_PRESETS.map(p => {
                      const active = scheduleMode === 'preset' && form.schedule_cron === p.cron && form.schedule_lookback_hours === p.lookback;
                      return (
                        <label key={p.id}
                          className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                            active ? 'border-brand-500 bg-brand-900/20' : 'border-slate-700 hover:border-slate-600'
                          }`}
                        >
                          <input type="radio" name="schedule_preset" checked={active}
                            onChange={() => {
                              setScheduleMode('preset');
                              set('schedule_cron', p.cron);
                              set('schedule_lookback_hours', p.lookback);
                            }}
                            className="mt-0.5 flex-shrink-0" />
                          <div>
                            <div className="text-sm font-medium text-white">{p.label}</div>
                            <div className="text-xs text-slate-400 mt-0.5">{p.fireTimes}</div>
                            <div className="text-xs text-green-400/80 mt-1">
                              Example: {p.example}
                            </div>
                          </div>
                        </label>
                      );
                    })}

                    {/* Custom — Visual Schedule Builder */}
                    <div className={`p-3 rounded-lg border transition-colors ${scheduleMode === 'custom' ? 'border-brand-500 bg-brand-900/20' : 'border-slate-700 hover:border-slate-600'}`}>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input type="radio" name="schedule_preset" checked={scheduleMode === 'custom'}
                          onChange={() => {
                            setScheduleMode('custom');
                            if (cronSource === 'builder') {
                              set('schedule_cron', buildCron(cronBuilder));
                              set('schedule_lookback_hours', lookbackToHours(lookbackValue, lookbackUnit));
                            }
                          }}
                          className="flex-shrink-0" />
                        <div>
                          <div className="text-sm font-medium text-white">Custom schedule</div>
                          <div className="text-xs text-slate-400">Visual builder or custom cron expression</div>
                        </div>
                      </label>

                      {scheduleMode === 'custom' && (() => {
                        // Derived values
                        const generatedCron = buildCron(cronBuilder);
                        const description = describeCron(cronBuilder);
                        const nextRunDate = cronSource === 'builder'
                          ? nextRunFromBuilder(cronBuilder)
                          : nextCronRunGeneric(form.schedule_cron, 35);
                        const nextRunStr = fmtNextRun(nextRunDate);

                        // Overlap warning
                        const lookbackMinutes = lookbackToHours(lookbackValue, lookbackUnit) * 60;
                        let intervalMinutes = null;
                        if (cronBuilder.type === 'every_minutes') intervalMinutes = cronBuilder.n;
                        else if (cronBuilder.type === 'every_hours') intervalMinutes = cronBuilder.n * 60;
                        else if (cronBuilder.type === 'daily') intervalMinutes = 1440;
                        const showOverlapWarn = cronSource === 'builder'
                          && intervalMinutes !== null
                          && lookbackMinutes > intervalMinutes;

                        function applyBuilderChange(newB) {
                          setCronBuilder(newB);
                          if (cronSource === 'builder') {
                            set('schedule_cron', buildCron(newB));
                            if (!lookbackOverridden) {
                              const s = suggestLookback(newB);
                              setLookbackValue(s.value);
                              setLookbackUnit(s.unit);
                              set('schedule_lookback_hours', lookbackToHours(s.value, s.unit));
                            }
                          }
                        }

                        function handleTypeChange(newType) {
                          const defaults = { every_minutes: { n: 15 }, every_hours: { n: 4 }, daily: { hour: 0, minute: 0 }, weekly: { hour: 8, minute: 0, days: [1,2,3,4,5] }, monthly: { hour: 0, minute: 0, dom: 1 } };
                          const newB = { ...cronBuilder, type: newType, ...defaults[newType] };
                          applyBuilderChange(newB);
                          setLookbackOverridden(false);
                        }

                        function handleLookbackChange(val, unit) {
                          setLookbackValue(val);
                          setLookbackUnit(unit || lookbackUnit);
                          setLookbackOverridden(true);
                          set('schedule_lookback_hours', lookbackToHours(val, unit || lookbackUnit));
                        }

                        function resetLookback() {
                          const s = suggestLookback(cronBuilder);
                          setLookbackValue(s.value);
                          setLookbackUnit(s.unit);
                          setLookbackOverridden(false);
                          set('schedule_lookback_hours', lookbackToHours(s.value, s.unit));
                        }

                        function handleAdvancedInput(val) {
                          setAdvancedCronInput(val);
                          const valid = nextCronRunGeneric(val, 35) !== null;
                          setAdvancedCronValid(valid);
                          if (valid) set('schedule_cron', val);
                        }

                        function openAdvanced() {
                          setAdvancedCronInput(form.schedule_cron);
                          setAdvancedOpen(true);
                          setCronSource('advanced');
                        }

                        function closeAdvanced() {
                          const typed = advancedCronInput.trim();
                          if (typed && typed !== generatedCron) {
                            setAdvancedCollapseConfirm(true);
                          } else {
                            setAdvancedOpen(false);
                            setCronSource('builder');
                            set('schedule_cron', generatedCron);
                          }
                        }

                        const DAY_LABELS = [
                          { v: 0, l: 'Su' }, { v: 1, l: 'Mo' }, { v: 2, l: 'Tu' },
                          { v: 3, l: 'We' }, { v: 4, l: 'Th' }, { v: 5, l: 'Fr' }, { v: 6, l: 'Sa' },
                        ];

                        return (
                          <div className="mt-3 pl-6 space-y-4">
                            {/* Frequency type selector */}
                            <div>
                              <label className="label text-xs mb-1">Frequency</label>
                              <select className="input w-full text-sm" value={cronBuilder.type} onChange={e => handleTypeChange(e.target.value)}>
                                <option value="every_minutes">Every N minutes</option>
                                <option value="every_hours">Every N hours</option>
                                <option value="daily">Daily at a specific time</option>
                                <option value="weekly">Weekly on specific days</option>
                                <option value="monthly">Monthly on a specific day</option>
                              </select>
                            </div>

                            {/* Type-specific fields */}
                            {cronBuilder.type === 'every_minutes' && (
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-slate-400">Every</span>
                                <input type="number" className="input w-20 text-sm text-center" min={1} max={59}
                                  value={cronBuilder.n}
                                  onChange={e => applyBuilderChange({ ...cronBuilder, n: Math.min(59, Math.max(1, +e.target.value || 1)) })} />
                                <span className="text-sm text-slate-400">minutes</span>
                              </div>
                            )}
                            {cronBuilder.type === 'every_hours' && (
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-slate-400">Every</span>
                                <input type="number" className="input w-20 text-sm text-center" min={1} max={23}
                                  value={cronBuilder.n}
                                  onChange={e => applyBuilderChange({ ...cronBuilder, n: Math.min(23, Math.max(1, +e.target.value || 1)) })} />
                                <span className="text-sm text-slate-400">hours</span>
                              </div>
                            )}
                            {(cronBuilder.type === 'daily' || cronBuilder.type === 'weekly' || cronBuilder.type === 'monthly') && (
                              <div className="flex items-center gap-2 flex-wrap">
                                {cronBuilder.type === 'weekly' && (
                                  <div className="flex gap-1 mr-2">
                                    {DAY_LABELS.map(({ v, l }) => {
                                      const on = (cronBuilder.days || []).includes(v);
                                      return (
                                        <button key={v} type="button"
                                          onClick={() => {
                                            const days = on
                                              ? (cronBuilder.days || []).filter(d => d !== v)
                                              : [...(cronBuilder.days || []), v];
                                            applyBuilderChange({ ...cronBuilder, days });
                                          }}
                                          className={`w-8 h-8 rounded text-xs font-medium transition-colors ${on ? 'bg-brand-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}>
                                          {l}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                {cronBuilder.type === 'monthly' && (
                                  <div className="flex items-center gap-2 mr-2">
                                    <span className="text-sm text-slate-400">On day</span>
                                    <input type="number" className="input w-20 text-sm text-center" min={1} max={28}
                                      value={cronBuilder.dom}
                                      onChange={e => applyBuilderChange({ ...cronBuilder, dom: Math.min(28, Math.max(1, +e.target.value || 1)) })} />
                                  </div>
                                )}
                                <span className="text-sm text-slate-400">at</span>
                                <input type="number" className="input w-16 text-sm text-center" min={0} max={23}
                                  value={cronBuilder.hour}
                                  onChange={e => applyBuilderChange({ ...cronBuilder, hour: Math.min(23, Math.max(0, +e.target.value)) })} />
                                <span className="text-sm text-slate-400">:</span>
                                <input type="number" className="input w-16 text-sm text-center" min={0} max={59}
                                  value={cronBuilder.minute}
                                  onChange={e => applyBuilderChange({ ...cronBuilder, minute: Math.min(59, Math.max(0, +e.target.value)) })} />
                                <span className="text-xs text-slate-500">(server local time)</span>
                              </div>
                            )}

                            {/* Lookback window */}
                            <div>
                              <label className="label text-xs mb-2">Lookback window</label>

                              {/* Relative / Absolute tab switcher */}
                              <div className="flex rounded-md border border-slate-700 overflow-hidden text-xs mb-2 w-fit">
                                {['relative', 'absolute'].map(mode => (
                                  <button key={mode} type="button"
                                    onClick={() => {
                                      setLookbackMode(mode);
                                      if (mode === 'relative') {
                                        handleLookbackChange(lookbackValue, lookbackUnit);
                                      }
                                    }}
                                    className={`px-4 py-1.5 capitalize transition-colors ${
                                      lookbackMode === mode
                                        ? 'bg-brand-600 text-white'
                                        : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                                    }`}>
                                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                                  </button>
                                ))}
                              </div>

                              {lookbackMode === 'relative' ? (
                                <div className="flex items-center gap-2">
                                  <input type="number" className="input w-20 text-sm text-center" min={1}
                                    value={lookbackValue}
                                    onChange={e => handleLookbackChange(Math.max(1, +e.target.value || 1), lookbackUnit)} />
                                  <select className="input text-sm" value={lookbackUnit}
                                    onChange={e => handleLookbackChange(lookbackValue, e.target.value)}>
                                    <option value="minutes">Minutes</option>
                                    <option value="hours">Hours</option>
                                    <option value="days">Days</option>
                                  </select>
                                  {lookbackOverridden && (
                                    <button type="button" onClick={resetLookback}
                                      className="text-xs text-brand-400 hover:text-brand-300 underline whitespace-nowrap">
                                      Reset to recommended
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-slate-400 w-8">From</span>
                                    <input type="datetime-local" className="input flex-1 text-sm font-mono"
                                      value={absFrom}
                                      onChange={e => {
                                        const from = e.target.value;
                                        setAbsFrom(from);
                                        if (from && absTo) {
                                          const diffH = (new Date(absTo) - new Date(from)) / 3600000;
                                          if (diffH > 0) { setLookbackOverridden(true); set('schedule_lookback_hours', diffH); }
                                        }
                                      }} />
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-slate-400 w-8">To</span>
                                    <input type="datetime-local" className="input flex-1 text-sm font-mono"
                                      value={absTo}
                                      onChange={e => {
                                        const to = e.target.value;
                                        setAbsTo(to);
                                        if (absFrom && to) {
                                          const diffH = (new Date(to) - new Date(absFrom)) / 3600000;
                                          if (diffH > 0) { setLookbackOverridden(true); set('schedule_lookback_hours', diffH); }
                                        }
                                      }} />
                                  </div>
                                  {absFrom && absTo && new Date(absTo) > new Date(absFrom) && (
                                    <p className="text-xs text-teal-400">
                                      Window: {(() => {
                                        const h = (new Date(absTo) - new Date(absFrom)) / 3600000;
                                        if (h < 1) return `${Math.round(h * 60)} minutes`;
                                        if (h % 24 === 0) return `${h / 24} day${h / 24 !== 1 ? 's' : ''}`;
                                        return `${h % 1 === 0 ? h : h.toFixed(1)} hours`;
                                      })()}
                                    </p>
                                  )}
                                  {absFrom && absTo && new Date(absTo) <= new Date(absFrom) && (
                                    <p className="text-xs text-red-400">"To" must be after "From".</p>
                                  )}
                                </div>
                              )}

                              {showOverlapWarn && lookbackMode === 'relative' && (
                                <p className="text-xs text-amber-400 mt-1.5">
                                  ⚠️ Lookback is larger than the schedule interval. Overlapping time windows will be processed on each run.
                                </p>
                              )}
                            </div>

                            {/* Schedule preview */}
                            {cronSource === 'builder' && (
                              <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2.5 text-xs space-y-1">
                                <div className="text-white font-medium">{description}</div>
                                {nextRunStr && <div className="text-slate-400">Next run: <span className="text-brand-300">{nextRunStr}</span></div>}
                                {nextRunDate && (() => {
                                  const lbMs = lookbackToHours(lookbackValue, lookbackUnit) * 3600 * 1000;
                                  const from = new Date(nextRunDate.getTime() - lbMs);
                                  const fmtDt = d => d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                                  return (
                                    <div className="text-slate-400">
                                      Pulls: <span className="text-teal-300">{fmtDt(from)}</span>
                                      {' → '}
                                      <span className="text-teal-300">{fmtDt(nextRunDate)}</span>
                                      <span className="text-slate-500 ml-1">({lookbackValue} {lookbackUnit} window)</span>
                                    </div>
                                  );
                                })()}
                                <div className="text-slate-500 font-mono pt-0.5">Generated cron: <span className="text-slate-300">{generatedCron}</span></div>
                              </div>
                            )}

                            {/* Advanced Cron section */}
                            <div className="border border-slate-700 rounded-lg overflow-hidden">
                              <button type="button"
                                onClick={advancedOpen ? closeAdvanced : openAdvanced}
                                className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-800/40 transition-colors">
                                <span className="font-medium">Advanced Cron {cronSource === 'advanced' ? <span className="text-brand-400 ml-1">(active)</span> : ''}</span>
                                <span>{advancedOpen ? '▲' : '▼'}</span>
                              </button>

                              {advancedOpen && (
                                <div className="px-3 pb-3 pt-1 space-y-2 border-t border-slate-700">
                                  <p className="text-xs text-slate-500">Custom cron overrides the visual builder above. Format: <code className="text-slate-400">min hour dom month dow</code></p>
                                  <div className="flex items-center gap-2">
                                    <input className="input flex-1 font-mono text-sm"
                                      value={advancedCronInput}
                                      onChange={e => handleAdvancedInput(e.target.value)}
                                      placeholder="0 */3 * * *" />
                                    <span className={`text-xs font-medium ${advancedCronValid ? 'text-green-400' : 'text-red-400'}`}>
                                      {advancedCronInput ? (advancedCronValid ? '✓ Valid' : '✕ Invalid') : ''}
                                    </span>
                                  </div>
                                  {cronSource === 'advanced' && advancedCronValid && advancedCronInput && (() => {
                                    const nr = nextCronRunGeneric(advancedCronInput, 35);
                                    const s = fmtNextRun(nr);
                                    return s ? <div className="text-xs text-slate-400">Next run: <span className="text-brand-300">{s}</span></div> : null;
                                  })()}
                                </div>
                              )}

                              {/* Collapse confirmation dialog */}
                              {advancedCollapseConfirm && (
                                <div className="px-3 pb-3 pt-2 border-t border-slate-700 bg-slate-800/60 space-y-2">
                                  <p className="text-xs text-amber-300 font-medium">Switch back to Visual Builder?</p>
                                  <p className="text-xs text-slate-400">
                                    Your custom expression <code className="text-slate-300 font-mono">{advancedCronInput}</code> will be replaced by the visual builder's expression <code className="text-slate-300 font-mono">{generatedCron}</code>.
                                  </p>
                                  <div className="flex gap-2">
                                    <button type="button"
                                      onClick={() => {
                                        setAdvancedCollapseConfirm(false);
                                        setAdvancedOpen(false);
                                        setCronSource('advanced');
                                      }}
                                      className="px-2.5 py-1 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600">
                                      Keep custom expression
                                    </button>
                                    <button type="button"
                                      onClick={() => {
                                        setAdvancedCollapseConfirm(false);
                                        setAdvancedOpen(false);
                                        setCronSource('builder');
                                        set('schedule_cron', generatedCron);
                                      }}
                                      className="px-2.5 py-1 rounded text-xs bg-brand-700 text-white hover:bg-brand-600">
                                      Switch to Visual Builder
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* ── Live preview ── */}
                  {scheduleMode === 'preset' && (
                    <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3 text-xs space-y-1">
                      <div className="text-slate-400 font-medium mb-1">At each trigger:</div>
                      <div className="text-white">
                        Pulls logs from{' '}
                        <span className="text-brand-400 font-mono">trigger − {form.schedule_lookback_hours}h</span>
                        {' '}to{' '}
                        <span className="text-brand-400 font-mono">trigger time</span>
                      </div>
                      <div className="text-slate-400 pt-0.5">
                        {scheduleExample(form.schedule_cron, form.schedule_lookback_hours)}
                      </div>
                    </div>
                  )}

                  {/* ── Parallel workers ── */}
                  <div>
                    <label className="label">
                      Parallel Workers &mdash;{' '}
                      <span className="text-brand-400">{form.parallel_slices === 1 ? '1 (sequential)' : `${form.parallel_slices} parallel time windows`}</span>
                    </label>
                    <input type="range" min={1} max={10} value={form.parallel_slices}
                      onChange={e => set('parallel_slices', +e.target.value)}
                      className="w-full accent-brand-500" />
                    <div className="flex justify-between text-xs text-slate-500 mt-0.5">
                      <span>1</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                      Splits the time window into N equal parts and scrolls each part in parallel.{' '}
                      <strong className="text-slate-400">Works for any index — single-shard or multi-shard.</strong>{' '}
                      Use 1 for low volumes; 4–8 for high-volume indexes (&gt;500k docs/day).
                    </p>
                    <div className="mt-3"><MaxRunTimeField form={form} set={set} /></div>
                  </div>

                  {/* ── Run Now button (only for saved pipelines) ── */}
                  {id && (
                    <div className="border-t border-slate-700 pt-4">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleRunNow}
                          disabled={runningNow}
                          className="btn-primary flex items-center gap-2 text-sm"
                        >
                          {runningNow
                            ? <><RefreshCw size={14} className="animate-spin" /> Running…</>
                            : '▶ Run Now'}
                        </button>
                        <span className="text-xs text-slate-400">
                          Trigger an immediate pull using the cursor window (no schedule wait)
                        </span>
                      </div>
                      {runNowResult && (
                        <div className={`mt-3 px-3 py-2 rounded-lg text-xs border ${
                          runNowResult.ok
                            ? 'bg-green-900/20 border-green-700 text-green-300'
                            : 'bg-red-900/20 border-red-700 text-red-300'
                        }`}>
                          {runNowResult.ok
                            ? `Done — fetched ${runNowResult.fetched}, inserted ${runNowResult.inserted}, skipped ${runNowResult.skipped ?? 0} (dedup), dlq ${runNowResult.dlq ?? 0}`
                            : `Error: ${runNowResult.error}`}
                        </div>
                      )}
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
              <Row label="Pull Mode" value={form.pull_mode === 'scheduled'
                ? `Scheduled — cron: ${form.schedule_cron}, lookback: ${form.schedule_lookback_hours}h, slices: ${form.parallel_slices}`
                : form.pull_mode} />
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
