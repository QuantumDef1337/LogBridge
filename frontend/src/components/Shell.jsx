import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, GitBranch, LogOut, Cable, Briefcase, ScrollText,
  ChevronLeft, ChevronRight, Sun, Moon, Settings,
} from 'lucide-react';
import { can } from '../lib/permissions';

/* Nav config — filtered at render time by role via can.* */
const NAV_ALL = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard',   dot: '#1a1814', visible: () => true },
  { to: '/pipelines',   icon: GitBranch,        label: 'Pipelines',   dot: '#e8503a', visible: () => true },
  { to: '/jobs',        icon: Briefcase,         label: 'Jobs',        dot: '#e8503a', visible: () => true },
  { to: '/log-history', icon: ScrollText,        label: 'Log History', dot: '#1ec994', visible: () => true },
  { to: '/connections', icon: Cable,             label: 'Connections', dot: '#14b8a6', visible: () => can.seeConnections() },
  { to: '/settings',    icon: Settings,          label: 'Settings',    dot: '#60a5fa', visible: () => true },
];

/* Brand mark SVG */
const BRAND_SVG = (
  <svg width="17" height="17" viewBox="0 0 17 17" fill="none">
    <rect x="2" y="3.5" width="9" height="1.8" rx="0.9" fill="white" opacity="0.95"/>
    <rect x="2" y="7.6" width="6.5" height="1.8" rx="0.9" fill="white" opacity="0.80"/>
    <rect x="2" y="11.7" width="4.5" height="1.8" rx="0.9" fill="white" opacity="0.60"/>
    <circle cx="13.5" cy="12.5" r="2.8" fill="white" opacity="0.95"/>
    <circle cx="13.5" cy="12.5" r="1.2" fill="#0d9488"/>
  </svg>
);

export default function Shell() {
  const navigate  = useNavigate();
  const [open, setOpen] = useState(true);
  const [dark, setDark] = useState(() => localStorage.getItem('lb_theme') === 'dark');
  const username = localStorage.getItem('lb_user') || 'admin';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('lb_theme', dark ? 'dark' : 'light');
  }, [dark]);

  function logout() {
    localStorage.removeItem('lb_token');
    localStorage.removeItem('lb_user');
    navigate('/login');
  }

  const W = open ? 228 : 60;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--canvas)' }}>

      {/* ─── Sidebar ─────────────────────────────────────────────────────── */}
      <aside style={{
        width: W,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--sidebar)',
        borderRight: '1px solid var(--border-soft)',
        transition: 'width 320ms cubic-bezier(0.32,0.72,0,1)',
        overflow: 'hidden',
        position: 'relative',
        zIndex: 20,
      }}>

        {/* ── Logo ── */}
        <div style={{
          display: 'flex', alignItems: 'center',
          gap: 11,
          padding: open ? '18px 16px 16px' : '18px 12px 16px',
          borderBottom: '1px solid var(--border-soft)',
          minHeight: 68,
          overflow: 'hidden',
        }}>
          <div style={{
            width: 34, height: 34, flexShrink: 0,
            borderRadius: 10,
            background: 'linear-gradient(140deg, #0c8278 0%, #14b8a6 55%, #34d4bf 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 16px rgba(20,184,166,0.22), inset 0 1px 0 rgba(255,255,255,0.20)',
          }}>
            {BRAND_SVG}
          </div>

          {open && (
            <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
              <div style={{
                color: 'var(--ink)', fontWeight: 800, fontSize: 15,
                letterSpacing: '-0.02em', lineHeight: 1.1,
              }}>
                LogBridge
              </div>
              <div style={{
                color: 'var(--teal)', fontSize: '9.5px', fontWeight: 700,
                letterSpacing: '0.16em', textTransform: 'uppercase', marginTop: 3,
              }}>
                V3
              </div>
            </div>
          )}
        </div>

        {/* ── Nav ── */}
        <nav style={{
          flex: 1, padding: '10px 8px',
          display: 'flex', flexDirection: 'column', gap: 1,
          overflowY: 'auto', overflowX: 'hidden',
        }}>
          {NAV_ALL.filter(n => n.visible()).map(({ to, icon: Icon, label, dot }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `nav-item ${isActive ? 'nav-item-active' : 'nav-item-inactive'}`
              }
              style={{ justifyContent: open ? 'flex-start' : 'center' }}
              title={!open ? label : undefined}
            >
              {({ isActive }) => (
                <>
                  {/* Siphon-style colored icon badge */}
                  <span style={{
                    width: 22, height: 22, flexShrink: 0,
                    borderRadius: 7,
                    background: isActive ? dot : `${dot}22`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'background 200ms',
                  }}>
                    <Icon
                      size={12}
                      style={{
                        color: isActive ? '#ffffff' : dot,
                        flexShrink: 0,
                      }}
                    />
                  </span>
                  {open && (
                    <span style={{
                      whiteSpace: 'nowrap', overflow: 'hidden',
                      fontWeight: isActive ? 600 : 500,
                      fontSize: 13,
                      color: isActive ? 'var(--ink)' : 'var(--ink-3)',
                    }}>
                      {label}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* ── Footer ── */}
        <div style={{
          borderTop: '1px solid var(--border-soft)',
          padding: '10px 8px 14px',
          display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          {/* Username chip */}
          {open && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', marginBottom: 2,
            }}>
              <div style={{
                width: 24, height: 24, borderRadius: 8,
                background: 'var(--ink)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: 'white', letterSpacing: '-0.01em' }}>
                  {username.charAt(0).toUpperCase()}
                </span>
              </div>
              <span style={{
                fontSize: 12, fontWeight: 500, color: 'var(--ink-3)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {username}
              </span>
            </div>
          )}

          <button
            onClick={() => setDark(v => !v)}
            className="nav-item nav-item-inactive"
            style={{
              justifyContent: open ? 'flex-start' : 'center',
              border: 'none', background: 'none', cursor: 'pointer',
            }}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <span style={{
              width: 22, height: 22, flexShrink: 0,
              borderRadius: 7,
              background: dark ? 'rgba(245,212,72,0.18)' : 'rgba(26,24,20,0.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {dark
                ? <Sun size={11} style={{ color: '#a37600' }} />
                : <Moon size={11} style={{ color: 'var(--ink-3)' }} />
              }
            </span>
            {open && (
              <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--ink-3)' }}>
                {dark ? 'Light mode' : 'Dark mode'}
              </span>
            )}
          </button>

          <button
            onClick={logout}
            className="nav-item nav-item-inactive"
            style={{
              justifyContent: open ? 'flex-start' : 'center',
              border: 'none', background: 'none', cursor: 'pointer',
            }}
            title={!open ? 'Logout' : undefined}
          >
            <span style={{
              width: 22, height: 22, flexShrink: 0,
              borderRadius: 7,
              background: 'rgba(232,80,58,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <LogOut size={11} style={{ color: 'var(--coral)' }} />
            </span>
            {open && <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--ink-3)' }}>Logout</span>}
          </button>

          <button
            onClick={() => setOpen(v => !v)}
            className="nav-item nav-item-inactive"
            style={{
              justifyContent: open ? 'flex-start' : 'center',
              border: 'none', background: 'none', cursor: 'pointer',
            }}
            title={open ? 'Collapse' : 'Expand'}
          >
            <span style={{
              width: 22, height: 22, flexShrink: 0,
              borderRadius: 7,
              background: 'rgba(26,24,20,0.06)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {open
                ? <ChevronLeft size={11} style={{ color: 'var(--ink-3)' }} />
                : <ChevronRight size={11} style={{ color: 'var(--ink-3)' }} />
              }
            </span>
            {open && (
              <span style={{ fontSize: 11, whiteSpace: 'nowrap', color: 'var(--ink-4)' }}>
                Collapse
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* ─── Main content ────────────────────────────────────────────────── */}
      <main style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden',
        position: 'relative',
        background: 'var(--canvas)',
      }}>
        <Outlet />
      </main>
    </div>
  );
}
