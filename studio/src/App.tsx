import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import { LoginPage } from './pages/LoginPage';
import { TableEditorPage } from './pages/TableEditorPage';
import { SqlEditorPage } from './pages/SqlEditorPage';
import { AuthUsersPage } from './pages/AuthUsersPage';
import { DatabasePage } from './pages/DatabasePage';
import { RealtimePage } from './pages/RealtimePage';
import { LogsPage } from './pages/LogsPage';
import { useAuthStore } from './store';

function AuthGuard({ children }: { children: React.ReactNode }): React.ReactElement {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export function App(): React.ReactElement {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <AuthGuard>
            <Shell />
          </AuthGuard>
        }
      >
        <Route index element={<Navigate to="/table-editor" replace />} />
        <Route path="table-editor" element={<TableEditorPage />} />
        <Route path="table-editor/:schema/:table" element={<TableEditorPage />} />
        <Route path="sql" element={<SqlEditorPage />} />
        <Route path="auth-users" element={<AuthUsersPage />} />
        <Route path="database" element={<DatabasePage />} />
        <Route path="database/:schema/:table" element={<DatabasePage />} />
        <Route path="realtime" element={<RealtimePage />} />
        <Route path="logs" element={<LogsPage />} />
      </Route>
    </Routes>
  );
}
