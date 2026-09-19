import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, ArrowRight, Activity, ShieldCheck } from 'lucide-react';
import { api } from '../api';

const BRAND_MARK = (
  <svg width="20" height="20" viewBox="0 0 17 17" fill="none">
    <rect x="2" y="3.5" width="9" height="1.8" rx="0.9" fill="white" opacity="0.95"/>
    <rect x="2" y="7.6" width="6.5" height="1.8" rx="0.9" fill="white" opacity="0.80"/>
    <rect x="2" y="11.7" width="4.5" height="1.8" rx="0.9" fill="white" opacity="0.60"/>
    <circle cx="13.5" cy="12.5" r="2.8" fill="white" opacity="0.95"/>
    <circle cx="13.5" cy="12.5" r="1.2" fill="#0d9488"/>
  </svg>
);

const features = [
  { label: 'Cursor-based continuity', sub: 'No gaps, no re-ingestion — picks up exactly where it left off' },
  { label: 'Parallel slicing', sub: 'Split any time window across N workers, with built-in dedup' },
  { label: 'Full observability', sub: 'Per-run logs, DLQ, checkpoint recovery, and reconciliation' },
];

export default function Login() {
  const navigate = useNavigate();
  const [form, setForm]       = useState({ username: '', password: '' });
  const [mfaToken, setMfaToken] = useState('');
  const [show, setShow]       = useState(false);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const payload = { ...form };
      if (mfaRequired) payload.mfa_token = mfaToken;
      const res = await api.login(payload.username, payload.password, mfaRequired ? mfaToken : undefined);

      if (res?.mfa_required) {
        setMfaRequired(true);
        setLoading(false);
        return;
      }

      localStorage.setItem('lb_token', res.token);
      localStorage.setItem('lb_user', res.username);
      localStorage.setItem('lb_role', res.role || 'analyst');
      // Decode JWT to get user id for MFA setup
      try {
        const payload = JSON.parse(atob(res.token.split('.')[1]));
        if (payload.id) localStorage.setItem('lb_uid', payload.id);
      } catch {}
      navigate('/dashboard');
    } catch (e) {
      setError(e.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'grid',
      gridTemplateColumns: '1fr 480px',
      background: '#09090b',
    }}>

      {/* ─── Left panel ─────────────────────────────────────────────────────── */}
      <div style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '48px 56px',
        overflow: 'hidden',
        background: 'linear-gradient(160deg, #0c0c0f 0%, #09090b 100%)',
        borderRight: '1px solid rgba(255,255,255,0.06)',
      }}>

        {/* Mesh orbs */}
        <div style={{
          position: 'absolute', top: -60, left: -40,
          width: 500, height: 400, borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(13,148,136,0.12) 0%, transparent 65%)',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', bottom: -80, right: -60,
          width: 400, height: 320, borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(6,182,212,0.07) 0%, transparent 65%)',
          pointerEvents: 'none',
        }} />

        {/* Brand mark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 11,
            background: 'linear-gradient(140deg, #0c8278 0%, #14b8a6 55%, #34d4bf 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 20px rgba(20,184,166,0.28), inset 0 1px 0 rgba(255,255,255,0.22)',
          }}>
            {BRAND_MARK}
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '-0.02em', color: '#f4f4f5' }}>
              LogBridge
            </div>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#14b8a6', marginTop: 2 }}>
              V3
            </div>
          </div>
        </div>

        {/* Hero copy */}
        <div style={{ maxWidth: 440 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(244,244,245,0.35)', marginBottom: 16 }}>
            Pipeline Observability
          </div>
          <h1 style={{
            fontWeight: 900, fontSize: 48, letterSpacing: '-0.04em',
            lineHeight: 1.0, color: '#f4f4f5', margin: '0 0 20px',
          }}>
            Move logs.{' '}
            <span style={{
              background: 'linear-gradient(135deg, #14b8a6 0%, #2dd4bf 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
              Zero gaps.
            </span>
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.65, color: 'rgba(244,244,245,0.55)', margin: 0, maxWidth: '38ch' }}>
            Pull from OpenSearch, land in ClickHouse — with cursor-based
            continuity, parallel slices, and a complete audit trail.
          </p>

          <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 18 }}>
            {features.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 13 }}>
                <div style={{
                  width: 7, height: 7, borderRadius: '50%', marginTop: 6,
                  background: '#14b8a6', flexShrink: 0,
                  boxShadow: '0 0 8px rgba(20,184,166,0.6)',
                }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5', letterSpacing: '-0.01em' }}>
                    {f.label}
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(244,244,245,0.38)', marginTop: 2, lineHeight: 1.5 }}>
                    {f.sub}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom status bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'rgba(244,244,245,0.28)' }}>
          <Activity size={12} style={{ color: '#14b8a6' }} />
          All pipelines reachable
          <span style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#34d399',
              boxShadow: '0 0 6px rgba(52,211,153,0.6)',
            }} />
            Backend healthy
          </span>
        </div>
      </div>

      {/* ─── Right panel — form ─────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '48px 48px',
        background: 'var(--canvas)',
      }}>

        {!mfaRequired ? (
          <>
            <div style={{ marginBottom: 36 }}>
              <h2 style={{ fontWeight: 800, fontSize: 26, letterSpacing: '-0.025em', color: 'var(--ink)', margin: '0 0 6px' }}>
                Sign in
              </h2>
              <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
                Access your pipeline control plane.
              </p>
            </div>

            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <label className="label">Username</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  className="input"
                  placeholder="admin"
                  autoFocus
                  autoComplete="username"
                />
              </div>

              <div>
                <label className="label">Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={show ? 'text' : 'password'}
                    value={form.password}
                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    className="input"
                    style={{ paddingRight: 44 }}
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShow(v => !v)}
                    style={{
                      position: 'absolute', right: 13, top: '50%',
                      transform: 'translateY(-50%)',
                      color: 'var(--ink-3)', background: 'none', border: 'none',
                      cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center',
                    }}
                  >
                    {show ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              {error && (
                <div style={{
                  background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)',
                  borderRadius: 10, padding: '10px 14px', color: '#dc2626', fontSize: 12.5, lineHeight: 1.5,
                }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-primary"
                style={{ width: '100%', padding: '13px 20px', marginTop: 4, justifyContent: 'center' }}
              >
                <span style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>
                  {loading ? 'Signing in…' : 'Sign in'}
                </span>
                {!loading && (
                  <span style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'rgba(255,255,255,0.16)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <ArrowRight size={13} />
                  </span>
                )}
              </button>
            </form>

            <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--ink-4)', marginTop: 28 }}>
              Default credentials: admin / admin123
            </p>
          </>
        ) : (
          /* ── MFA step ── */
          <>
            <div style={{ marginBottom: 36 }}>
              <div style={{
                width: 48, height: 48, borderRadius: 14,
                background: 'rgba(20,184,166,0.10)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 20,
              }}>
                <ShieldCheck size={22} style={{ color: '#14b8a6' }} />
              </div>
              <h2 style={{ fontWeight: 800, fontSize: 24, letterSpacing: '-0.025em', color: 'var(--ink)', margin: '0 0 6px' }}>
                Two-factor authentication
              </h2>
              <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
                Enter the 6-digit code from your authenticator app.
              </p>
            </div>

            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <label className="label">Authentication code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={mfaToken}
                  onChange={e => setMfaToken(e.target.value.replace(/\D/g, ''))}
                  className="input"
                  placeholder="000000"
                  autoFocus
                  style={{ letterSpacing: '0.25em', fontSize: 20, textAlign: 'center' }}
                />
              </div>

              {error && (
                <div style={{
                  background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)',
                  borderRadius: 10, padding: '10px 14px', color: '#dc2626', fontSize: 12.5,
                }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || mfaToken.length !== 6}
                className="btn-primary"
                style={{ width: '100%', padding: '13px 20px', justifyContent: 'center' }}
              >
                <span style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>
                  {loading ? 'Verifying…' : 'Verify'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => { setMfaRequired(false); setError(''); setMfaToken(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--ink-3)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textAlign: 'center' }}
              >
                Back to login
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
