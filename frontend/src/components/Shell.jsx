import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, GitBranch,
  LogOut, Menu, X, Cable, Briefcase, ScrollText,
} from 'lucide-react';

const nav = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/pipelines',   icon: GitBranch,        label: 'Pipelines' },
  { to: '/jobs',        icon: Briefcase,         label: 'Jobs' },
  { to: '/log-history', icon: ScrollText,        label: 'Log History' },
  { to: '/connections', icon: Cable,             label: 'Connections' },
];

export default function Shell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const username = localStorage.getItem('lb_user') || 'admin';

  function logout() {
    localStorage.removeItem('lb_token');
    localStorage.removeItem('lb_user');
    navigate('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className={`${open ? 'w-56' : 'w-14'} flex-shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col transition-all duration-200`}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-800">
          <img src="/logo.png" alt="LogBridge" className="w-7 h-7 rounded-md flex-shrink-0 object-contain" />
          {open && (
            <div className="flex flex-col leading-tight">
              <span className="font-bold text-white text-sm tracking-wide">LogBridge</span>
              <span className="text-[10px] font-semibold tracking-widest text-brand-400 uppercase">V2 · Multi-Thread</span>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 space-y-1 px-2">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-brand-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`
              }
            >
              <Icon size={16} className="flex-shrink-0" />
              {open && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-800 px-2 py-3 space-y-1">
          {open && <div className="px-3 py-1 text-xs text-slate-500 truncate">{username}</div>}
          <button
            onClick={logout}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <LogOut size={16} className="flex-shrink-0" />
            {open && <span>Logout</span>}
          </button>
          <button
            onClick={() => setOpen(v => !v)}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
          >
            {open ? <X size={16} /> : <Menu size={16} />}
            {open && <span className="text-xs">Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-slate-950">
        <Outlet />
      </main>
    </div>
  );
}
