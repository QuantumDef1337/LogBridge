// Shared timestamp formatting — respects the user's UTC/local preference stored in localStorage.

export function getTzPref() {
  return localStorage.getItem('lb_tz') || 'local'; // 'utc' | 'local'
}

export function setTzPref(pref) {
  localStorage.setItem('lb_tz', pref);
}

// SQLite stores datetime('now') as "YYYY-MM-DD HH:MM:SS" which is UTC but has no
// timezone marker. Append 'Z' so JS parses it correctly as UTC in all browsers.
function parseTs(ts) {
  if (!ts) return null;
  const s = String(ts);
  // If it looks like a bare SQLite datetime (no T, no Z, no offset), treat as UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) && !s.endsWith('Z') && !s.includes('+')) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  return new Date(s);
}

export function fmtTs(ts, pref) {
  if (!ts) return '—';
  try {
    const d = parseTs(ts);
    const p = pref || getTzPref();
    if (p === 'utc') {
      return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    }
    return d.toLocaleString();
  } catch {
    return String(ts);
  }
}

export function fmtRelative(ts) {
  if (!ts) return '—';
  const diff = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
