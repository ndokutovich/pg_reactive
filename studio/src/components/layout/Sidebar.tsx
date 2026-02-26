import React from 'react';
import { NavLink } from 'react-router-dom';
import { StatusDot } from './StatusDot';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactElement;
}

function GridIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

function TerminalIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function UsersIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function DatabaseIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function ActivityIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function FileTextIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

const navItems: NavItem[] = [
  { to: '/table-editor', label: 'Table Editor', icon: <GridIcon /> },
  { to: '/sql', label: 'SQL Editor', icon: <TerminalIcon /> },
  { to: '/auth-users', label: 'Auth Users', icon: <UsersIcon /> },
  { to: '/database', label: 'Database', icon: <DatabaseIcon /> },
  { to: '/realtime', label: 'Realtime', icon: <ActivityIcon /> },
  { to: '/logs', label: 'Logs', icon: <FileTextIcon /> },
];

export function Sidebar(): React.ReactElement {
  return (
    <aside className="w-60 flex-shrink-0 bg-surface-100 border-r border-surface-200 flex flex-col h-full">
      <div className="px-4 py-5 border-b border-surface-200">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-brand flex items-center justify-center">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="black" strokeWidth="2.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-bold text-white leading-tight">pgStack</p>
            <p className="text-xs text-gray-500 leading-tight">Studio</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 py-2 overflow-y-auto">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                isActive
                  ? 'text-brand border-l-2 border-brand bg-brand/10'
                  : 'text-gray-400 hover:text-white hover:bg-surface-200 border-l-2 border-transparent'
              }`
            }
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-surface-200 py-1">
        <StatusDot />
      </div>
    </aside>
  );
}
