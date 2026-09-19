import React, { useState, useEffect, useRef } from 'react';
import {
  User, Users, ShieldCheck, Settings2, Plus, Edit2, Trash2, X,
  CheckCircle2, XCircle, Key, QrCode, Eye, EyeOff, ChevronRight,
  Lock, LogIn, Clock, Save, AlertCircle,
} from 'lucide-react';
import { api } from '../api';

/* ─── tiny helpers ──────────────────────────────────────────────────────────── */
const ROLES = [
  { value: 'super_admin', label: 'Super Admin', desc: 'Full system access' },
  { value: 'admin', label: 'Admin', desc: 'Manage users and settings' },
  { value: 'analyst', label: 'Analyst', desc: 'Query assigned databases and tables' },
  { value: 'viewer', label: 'Viewer', desc: 'Read-only access' },
];

function roleBadge(role) {
  const map = {
    super_admin: { bg: 'rgba(232,80,58,0.10)', color: '#c83f2b', label: 'super_admin' },
    admin:       { bg: 'rgba(96,165,250,0.12)', color: '#2563eb', label: 'admin' },
    analyst:     { bg: 'rgba(20,184,166,0.10)', color: '#0d9488', label: 'analyst' },
    viewer:      { bg: 'rgba(26,24,20,0.06)', color: 'var(--ink-3)', label: 'viewer' },
  };
  const s = map[role] || map.viewer;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999,
      background: s.bg, color: s.color, fontSize: 10, fontWeight: 700,
    }}>
      {s.label}
    </span>
  );
}

function StatusPill({ on }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 9px', borderRadius: 999, fontSize: 10, fontWeight: 700,
      background: on ? 'rgba(30,201,148,0.10)' : 'rgba(26,24,20,0.06)',
      color: on ? '#0d9488' : 'var(--ink-3)',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: on ? '#1ec994' : 'var(--ink-4)' }} />
      {on ? 'Active' : 'Inactive'}
    </span>
  );
}

function MfaPill({ on }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999,
      fontSize: 10, fontWeight: 700,
      background: on ? 'rgba(30,201,148,0.10)' : 'rgba(26,24,20,0.06)',
      color: on ? '#0d9488' : 'var(--ink-4)',
    }}>
      {on ? 'ON' : 'OFF'}
    </span>
  );
}

/* ─── tab bar ───────────────────────────────────────────────────────────────── */
const TABS = [
  { id: 'profile',  label: 'My profile',      icon: User },
  { id: 'users',    label: 'Users',            icon: Users },
  { id: 'security', label: 'System settings',  icon: Settings2 },
  { id: 'logins',   label: 'Login activity',   icon: LogIn },
];

/* ────────────────────────────────────────────────────────────────────────────
   MAIN COMPONENT
─────────────────────────────────────────────────────────────────────────────*/
export default function Settings() {
  const myId    = parseInt(localStorage.getItem('lb_uid') || '0');
  const myRole  = localStorage.getItem('lb_role') || 'analyst';
  const isAdmin = ['super_admin', 'admin'].includes(myRole);

  const [tab, setTab] = useState('profile');

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontWeight: 800, fontSize: 22, letterSpacing: '-0.03em', color: 'var(--ink)', margin: '0 0 24px' }}>
        Settings
      </h1>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 28 }}>
        {TABS.filter(t => isAdmin || t.id === 'profile').map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '9px 14px',
                background: 'none', border: 'none', cursor: 'pointer',
                borderBottom: active ? '2px solid var(--teal)' : '2px solid transparent',
                marginBottom: -1,
                color: active ? 'var(--teal)' : 'var(--ink-3)',
                fontWeight: active ? 600 : 500, fontSize: 13,
                transition: 'all 150ms',
              }}
            >
              <Icon size={14} />
              {t.label}
              {t.id === 'users' && isAdmin && <UserCountBadge />}
            </button>
          );
        })}
      </div>

      {tab === 'profile'  && <MyProfile myId={myId} />}
      {tab === 'users'    && isAdmin && <UsersTab />}
      {tab === 'security' && isAdmin && <SecurityTab />}
      {tab === 'logins'   && isAdmin && <LoginActivityTab />}
    </div>
  );
}

/* ── tiny badge showing user count ─────────────────────────────────────────── */
function UserCountBadge() {
  const [count, setCount] = useState(null);
  useEffect(() => { api.getUsers().then(u => setCount(u.length)).catch(() => {}); }, []);
  if (!count) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 18, height: 18, borderRadius: 999, padding: '0 5px',
      background: 'var(--teal-tint)', color: 'var(--teal)', fontSize: 10, fontWeight: 700,
    }}>{count}</span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   MY PROFILE
─────────────────────────────────────────────────────────────────────────────*/
function MyProfile({ myId }) {
  const username = localStorage.getItem('lb_user') || '';
  const role     = localStorage.getItem('lb_role') || 'analyst';

  const [profile, setProfile]       = useState({ display_name: '', email: '' });
  const [pwForm, setPwForm]         = useState({ current: '', next: '', confirm: '' });
  const [showPw, setShowPw]         = useState({ current: false, next: false });
  const [mfaData, setMfaData]       = useState(null); // { secret, qr_url }
  const [mfaStep, setMfaStep]       = useState('idle'); // idle | setup | confirm
  const [mfaCode, setMfaCode]       = useState('');
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [msg, setMsg]               = useState(null);

  // Load profile
  useEffect(() => {
    const stored = localStorage.getItem('lb_user');
    api.getMyProfile().then(u => {
      setProfile({ display_name: u.display_name || '', email: u.email || '' });
      setMfaEnabled(!!u.mfa_enabled);
    }).catch(() => {
      setProfile({ display_name: stored || '', email: '' });
    });
  }, []);

  // Resolve user id — getMyProfile doesn't expose id in sanitizeUser, use token
  function resolveId() {
    // Stored in lb_uid or parse from JWT
    const uid = localStorage.getItem('lb_uid');
    if (uid) return parseInt(uid);
    try {
      const token = localStorage.getItem('lb_token');
      const payload = JSON.parse(atob(token.split('.')[1]));
      localStorage.setItem('lb_uid', payload.id);
      return payload.id;
    } catch { return null; }
  }

  async function saveProfile(e) {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      await api.updateMyProfile(profile);
      setMsg({ type: 'ok', text: 'Profile saved.' });
    } catch (err) { setMsg({ type: 'err', text: err.message }); }
    finally { setSaving(false); }
  }

  async function savePassword(e) {
    e.preventDefault();
    if (pwForm.next !== pwForm.confirm) { setMsg({ type: 'err', text: 'Passwords do not match' }); return; }
    setSaving(true); setMsg(null);
    try {
      await api.changePassword(pwForm.current, pwForm.next);
      setPwForm({ current: '', next: '', confirm: '' });
      setMsg({ type: 'ok', text: 'Password changed.' });
    } catch (err) { setMsg({ type: 'err', text: err.message }); }
    finally { setSaving(false); }
  }

  async function startMfaSetup() {
    const id = resolveId();
    if (!id) { setMsg({ type: 'err', text: 'Could not resolve user id' }); return; }
    try {
      const data = await api.setupMfa(id);
      setMfaData(data);
      setMfaStep('setup');
    } catch (err) { setMsg({ type: 'err', text: err.message }); }
  }

  async function confirmMfa() {
    const id = resolveId();
    if (!id) return;
    try {
      await api.verifyMfa(id, mfaCode);
      setMfaEnabled(true); setMfaStep('idle'); setMfaData(null); setMfaCode('');
      setMsg({ type: 'ok', text: 'MFA enabled successfully.' });
    } catch (err) { setMsg({ type: 'err', text: err.message }); }
  }

  async function disableMfa() {
    const id = resolveId();
    if (!id) return;
    if (!window.confirm('Disable two-factor authentication?')) return;
    try {
      await api.disableMfa(id);
      setMfaEnabled(false);
      setMsg({ type: 'ok', text: 'MFA disabled.' });
    } catch (err) { setMsg({ type: 'err', text: err.message }); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 560 }}>
      {msg && <Toast msg={msg} onDismiss={() => setMsg(null)} />}

      {/* Profile form */}
      <Card title="My profile">
        <form onSubmit={saveProfile} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <FieldRow>
            <Field label="Display name">
              <input className="input" value={profile.display_name}
                onChange={e => setProfile(p => ({ ...p, display_name: e.target.value }))}
                placeholder="Your name" />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={profile.email}
                onChange={e => setProfile(p => ({ ...p, email: e.target.value }))}
                placeholder="you@company.com" />
            </Field>
          </FieldRow>
          <Field label="Password (leave blank to keep)">
            <input className="input" type="password" disabled placeholder="••••••••"
              style={{ cursor: 'not-allowed', opacity: 0.5 }} />
          </Field>
          <button type="submit" className="btn-primary" disabled={saving}
            style={{ alignSelf: 'flex-start', gap: 6 }}>
            <Save size={13} /> {saving ? 'Saving…' : 'Save profile'}
          </button>
        </form>
      </Card>

      {/* Change password */}
      <Card title="Change password">
        <form onSubmit={savePassword} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Current password">
            <PwInput value={pwForm.current} onChange={v => setPwForm(p => ({ ...p, current: v }))}
              show={showPw.current} toggle={() => setShowPw(s => ({ ...s, current: !s.current }))} placeholder="••••••••" />
          </Field>
          <FieldRow>
            <Field label="New password">
              <PwInput value={pwForm.next} onChange={v => setPwForm(p => ({ ...p, next: v }))}
                show={showPw.next} toggle={() => setShowPw(s => ({ ...s, next: !s.next }))} placeholder="Min 8 chars" />
            </Field>
            <Field label="Confirm new password">
              <PwInput value={pwForm.confirm} onChange={v => setPwForm(p => ({ ...p, confirm: v }))}
                show={false} toggle={() => {}} placeholder="Repeat password" />
            </Field>
          </FieldRow>
          <button type="submit" className="btn-primary" disabled={saving || !pwForm.current || !pwForm.next}
            style={{ alignSelf: 'flex-start', gap: 6 }}>
            <Key size={13} /> {saving ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </Card>

      {/* MFA */}
      <Card title="Two-Factor Authentication (MFA)">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 6 }}>
              Add an extra layer of security with a 6-digit code
            </div>
            <MfaPill on={mfaEnabled} />
          </div>
          {mfaEnabled ? (
            <button className="btn-danger" onClick={disableMfa} style={{ flexShrink: 0, gap: 6, fontSize: 12 }}>
              <XCircle size={12} /> Disable MFA
            </button>
          ) : (
            <button className="btn-primary" onClick={startMfaSetup} style={{ flexShrink: 0, gap: 6, fontSize: 12 }}>
              <ShieldCheck size={12} /> + Enable MFA
            </button>
          )}
        </div>

        {mfaStep === 'setup' && mfaData && (
          <div style={{ marginTop: 20, padding: 16, background: 'var(--surface-alt)', borderRadius: 10, border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 12 }}>
              Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
            </div>
            <img src={mfaData.qr_url} alt="QR Code" style={{ width: 180, height: 180, borderRadius: 8 }} />
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ink-3)' }}>
              Manual key: <code style={{ fontFamily: 'JetBrains Mono, monospace', background: 'var(--border-soft)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>{mfaData.secret}</code>
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                className="input"
                maxLength={6}
                inputMode="numeric"
                placeholder="Enter 6-digit code"
                value={mfaCode}
                onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
                style={{ width: 180, letterSpacing: '0.15em', fontSize: 16, textAlign: 'center' }}
              />
              <button className="btn-primary" onClick={confirmMfa} disabled={mfaCode.length !== 6} style={{ gap: 6 }}>
                <CheckCircle2 size={13} /> Verify & Enable
              </button>
              <button style={{ background: 'none', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', fontSize: 12 }}
                onClick={() => { setMfaStep('idle'); setMfaData(null); setMfaCode(''); }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* Role info */}
      <Card title="Account info" noPad>
        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
          <InfoRow label="Username" value={username} />
          <InfoRow label="Role" value={roleBadge(role)} />
        </div>
      </Card>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   USERS TAB
─────────────────────────────────────────────────────────────────────────────*/
function UsersTab() {
  const [users, setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]   = useState(null); // null | 'create' | { user }
  const [msg, setMsg]       = useState(null);

  function load() {
    setLoading(true);
    api.getUsers().then(u => { setUsers(u); setLoading(false); }).catch(() => setLoading(false));
  }
  useEffect(load, []);

  async function deleteUser(u) {
    if (!window.confirm(`Delete user "${u.username}"?`)) return;
    try {
      await api.deleteUser(u.id);
      load();
      setMsg({ type: 'ok', text: `User "${u.username}" deleted.` });
    } catch (err) { setMsg({ type: 'err', text: err.message }); }
  }

  return (
    <div>
      {msg && <Toast msg={msg} onDismiss={() => setMsg(null)} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', margin: 0 }}>
          User management
        </h2>
        <button className="btn-primary" onClick={() => setModal('create')} style={{ gap: 6 }}>
          <Plus size={13} /> + Create user
        </button>
      </div>

      {loading ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-alt)', borderBottom: '1px solid var(--border)' }}>
                {['Username', 'Display name', 'Role', 'MFA', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={u.id} style={{ borderBottom: i < users.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--ink)' }}>{u.username}</td>
                  <td style={{ padding: '12px 16px', color: 'var(--ink-2)' }}>{u.display_name || '—'}</td>
                  <td style={{ padding: '12px 16px' }}>{roleBadge(u.role)}</td>
                  <td style={{ padding: '12px 16px' }}><MfaPill on={!!u.mfa_enabled} /></td>
                  <td style={{ padding: '12px 16px' }}><StatusPill on={u.is_active !== 0} /></td>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => setModal(u)}
                        style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11, color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <Edit2 size={11} /> Edit
                      </button>
                      <button
                        onClick={() => deleteUser(u)}
                        style={{ background: 'none', border: '1px solid rgba(232,80,58,0.20)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11, color: 'var(--coral)', display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <Trash2 size={11} /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(modal === 'create' || (modal && modal.id)) && (
        <UserModal
          user={modal === 'create' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { load(); setModal(null); }}
        />
      )}
    </div>
  );
}

/* ── User create/edit modal ─────────────────────────────────────────────────── */
function UserModal({ user, onClose, onSaved }) {
  const isEdit = !!user;
  const [form, setForm] = useState({
    username: user?.username || '',
    display_name: user?.display_name || '',
    email: user?.email || '',
    password: '',
    role: user?.role || 'analyst',
    is_active: user?.is_active !== 0,
    force_password_reset: user ? !!user.force_password_reset : true,
    require_mfa_enrollment: user ? !!user.require_mfa_enrollment : false,
  });
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  const selectedRole = ROLES.find(r => r.value === form.role);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setErr('');
    try {
      if (isEdit) {
        await api.updateUser(user.id, {
          display_name: form.display_name,
          email: form.email,
          role: form.role,
          is_active: form.is_active,
          force_password_reset: form.force_password_reset,
          require_mfa_enrollment: form.require_mfa_enrollment,
        });
      } else {
        await api.createUser({
          username: form.username,
          display_name: form.display_name,
          email: form.email,
          password: form.password,
          role: form.role,
          force_password_reset: form.force_password_reset,
          require_mfa_enrollment: form.require_mfa_enrollment,
        });
      }
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--overlay)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'var(--surface)', borderRadius: 16, padding: 28,
        width: 560, maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <h3 style={{ fontWeight: 700, fontSize: 16, color: 'var(--ink)', margin: 0 }}>
            {isEdit ? `Edit ${user.username}` : 'Create user'}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <FieldRow>
            <Field label="Username">
              <input className="input" value={form.username} disabled={isEdit}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                placeholder="johndoe" style={isEdit ? { opacity: 0.6, cursor: 'not-allowed' } : {}} />
            </Field>
            <Field label="Display name">
              <input className="input" value={form.display_name}
                onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                placeholder="John Doe" />
            </Field>
          </FieldRow>

          <Field label="Email">
            <input className="input" type="email" value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="user@company.com" />
          </Field>

          {!isEdit && (
            <FieldRow>
              <Field label="Password">
                <PwInput value={form.password} onChange={v => setForm(f => ({ ...f, password: v }))}
                  show={showPw} toggle={() => setShowPw(v => !v)} placeholder="Min 8 chars" />
              </Field>
              <Field label="Role">
                <select className="input" value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </Field>
            </FieldRow>
          )}

          {isEdit && (
            <Field label="Role">
              <select className="input" value={form.role}
                onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Field>
          )}

          {selectedRole && (
            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: -10, paddingLeft: 2 }}>
              {selectedRole.desc}
            </div>
          )}

          {/* Security options */}
          <div style={{ padding: 16, background: 'var(--surface-alt)', borderRadius: 10, border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 14 }}>
              Security options
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <SecurityCheckbox
                checked={form.force_password_reset}
                onChange={v => setForm(f => ({ ...f, force_password_reset: v }))}
                label="Force password reset on first login"
                sub="User must change password before accessing the platform"
              />
              <SecurityCheckbox
                checked={form.require_mfa_enrollment}
                onChange={v => setForm(f => ({ ...f, require_mfa_enrollment: v }))}
                label="Require MFA enrollment"
                sub="User will be forced to set up 2FA on next login"
              />
              {isEdit && (
                <SecurityCheckbox
                  checked={form.is_active}
                  onChange={v => setForm(f => ({ ...f, is_active: v }))}
                  label="Account active"
                  sub="Inactive accounts cannot log in"
                />
              )}
            </div>
          </div>

          {err && (
            <div style={{ background: 'rgba(232,80,58,0.07)', border: '1px solid rgba(232,80,58,0.18)', borderRadius: 8, padding: '10px 14px', color: 'var(--coral)', fontSize: 12 }}>
              {err}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" onClick={onClose}
              style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid var(--border)', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--ink-2)' }}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   SYSTEM SECURITY TAB
─────────────────────────────────────────────────────────────────────────────*/
function SecurityTab() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState(null);

  useEffect(() => {
    api.getSecuritySettings().then(s => setSettings({ ...s })).catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      const saved = await api.updateSecuritySettings(settings);
      setSettings({ ...saved });
      setMsg({ type: 'ok', text: 'Settings saved.' });
    } catch (err) { setMsg({ type: 'err', text: err.message }); }
    finally { setSaving(false); }
  }

  if (!settings) return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>;

  function field(key) {
    return {
      value: settings[key] ?? '',
      onChange: e => setSettings(s => ({ ...s, [key]: e.target.value })),
    };
  }

  return (
    <div style={{ maxWidth: 680 }}>
      {msg && <Toast msg={msg} onDismiss={() => setMsg(null)} />}

      <div style={{ marginBottom: 20, padding: '12px 16px', background: 'rgba(96,165,250,0.07)', border: '1px solid rgba(96,165,250,0.15)', borderRadius: 10, fontSize: 12, color: 'var(--sky)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        Changes apply immediately. Retention values control how long records are kept before automatic cleanup (runs daily).
      </div>

      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

        <Card title="Retention">
          <FieldRow>
            <Field label="Login history (days)">
              <input className="input" type="number" min="1" {...field('login_history_retention_days')} />
            </Field>
          </FieldRow>
        </Card>

        <Card title="Account lockout">
          <FieldRow>
            <Field label="Failed attempts threshold">
              <input className="input" type="number" min="1" {...field('failed_attempts_threshold')} />
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>Lock account after this many failed login attempts</div>
            </Field>
            <Field label="Lockout duration (minutes)">
              <input className="input" type="number" min="1" {...field('lockout_duration_minutes')} />
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>How long account stays locked before auto-unlock</div>
            </Field>
          </FieldRow>
        </Card>

        <Card title="Password policy">
          <FieldRow>
            <Field label="Minimum password length">
              <input className="input" type="number" min="6" {...field('min_password_length')} />
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>Recommended: 12 or higher</div>
            </Field>
            <Field label="Password history depth">
              <input className="input" type="number" min="0" {...field('password_history_depth')} />
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>Block reuse of last N passwords</div>
            </Field>
          </FieldRow>
        </Card>

        <Card title="Session & MFA">
          <FieldRow>
            <Field label="Session idle timeout (minutes)">
              <input className="input" type="number" min="1" {...field('session_idle_timeout_minutes')} />
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>Auto-logout after inactivity</div>
            </Field>
            <Field label="MFA backup codes count">
              <input className="input" type="number" min="1" {...field('mfa_backup_codes_count')} />
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>How many one-time codes to generate per user</div>
            </Field>
          </FieldRow>
        </Card>

        <button type="submit" className="btn-primary" disabled={saving} style={{ alignSelf: 'flex-start', gap: 6 }}>
          <Save size={13} /> {saving ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   LOGIN ACTIVITY TAB
─────────────────────────────────────────────────────────────────────────────*/
function LoginActivityTab() {
  const [rows, setRows]     = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getLoginActivity(200).then(r => { setRows(r); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', margin: 0 }}>Login activity</h2>
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Last 200 entries</span>
      </div>

      {loading ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>No login records yet.</div>
      ) : (
        <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-alt)', borderBottom: '1px solid var(--border)' }}>
                {['Time', 'Username', 'Result', 'IP address'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                  <td style={{ padding: '10px 16px', color: 'var(--ink-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 16px', fontWeight: 600, color: 'var(--ink)' }}>{r.username}</td>
                  <td style={{ padding: '10px 16px' }}>
                    {r.success ? (
                      <span style={{ color: '#0d9488', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <CheckCircle2 size={12} /> Success
                      </span>
                    ) : (
                      <span style={{ color: 'var(--coral)', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <XCircle size={12} /> Failed
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 16px', color: 'var(--ink-3)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>
                    {r.ip_address || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   SHARED MICRO-COMPONENTS
─────────────────────────────────────────────────────────────────────────────*/
function Card({ title, children, noPad }) {
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)', background: 'var(--surface-alt)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{title}</div>
      </div>
      <div style={noPad ? {} : { padding: 18 }}>{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function FieldRow({ children }) {
  return <div style={{ display: 'flex', gap: 14 }}>{children}</div>;
}

function PwInput({ value, onChange, show, toggle, placeholder }) {
  return (
    <div style={{ position: 'relative' }}>
      <input className="input" type={show ? 'text' : 'password'} value={value}
        onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ paddingRight: 40 }} />
      <button type="button" onClick={toggle}
        style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', padding: 2 }}>
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

function SecurityCheckbox({ checked, onChange, label, sub }) {
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && onChange(!checked)}
      style={{ display: 'flex', gap: 12, cursor: 'pointer', alignItems: 'flex-start', userSelect: 'none' }}
    >
      <div style={{ marginTop: 2, flexShrink: 0 }}>
        <div style={{
          width: 18, height: 18, borderRadius: 5,
          border: checked ? 'none' : '1.5px solid var(--border)',
          background: checked ? 'var(--teal)' : 'var(--surface)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 150ms, border-color 150ms',
          boxShadow: checked ? 'none' : 'inset 0 1px 2px rgba(0,0,0,0.06)',
        }}>
          {checked && <CheckCircle2 size={12} color="white" strokeWidth={3} />}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function Toast({ msg, onDismiss }) {
  useEffect(() => { const t = setTimeout(onDismiss, 4000); return () => clearTimeout(t); }, []);
  return (
    <div style={{
      padding: '11px 16px', borderRadius: 10, marginBottom: 16,
      background: msg.type === 'ok' ? 'rgba(30,201,148,0.08)' : 'rgba(232,80,58,0.08)',
      border: `1px solid ${msg.type === 'ok' ? 'rgba(30,201,148,0.20)' : 'rgba(232,80,58,0.20)'}`,
      color: msg.type === 'ok' ? '#0d9488' : 'var(--coral)',
      fontSize: 12.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {msg.type === 'ok' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
        {msg.text}
      </span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 2 }}>
        <X size={12} />
      </button>
    </div>
  );
}
