import React from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthStore, useUiStore } from '../../store';
import { Button } from '../ui/Button';

const routeTitles: Record<string, string> = {
  '/table-editor': 'Table Editor',
  '/sql': 'SQL Editor',
  '/auth-users': 'Auth Users',
  '/database': 'Database',
  '/realtime': 'Realtime',
  '/logs': 'Logs',
};

function SunIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

function LogoutIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

export function TopBar(): React.ReactElement {
  const location = useLocation();
  const { theme, toggleTheme } = useUiStore();
  const logout = useAuthStore((s) => s.logout);

  const title = Object.entries(routeTitles).find(([key]) =>
    location.pathname.startsWith(key)
  )?.[1] ?? 'pgStack Studio';

  return (
    <header className="flex items-center justify-between px-5 py-3 border-b border-surface-200 bg-surface-100 flex-shrink-0">
      <h1 className="text-base font-semibold text-white">{title}</h1>
      <div className="flex items-center gap-2">
        <button
          onClick={toggleTheme}
          className="p-2 text-gray-400 hover:text-white transition-colors rounded-md hover:bg-surface-200"
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        <Button variant="secondary" size="sm" onClick={logout}>
          <LogoutIcon />
          Logout
        </Button>
      </div>
    </header>
  );
}
