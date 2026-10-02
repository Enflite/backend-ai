/**
 * App.tsx — application root.
 *
 * AuthProvider restores the session; unauthenticated users get the Login
 * screen; everyone else gets the routed app shell. ChatView keeps the
 * existing single-page chat exactly as it was — the shell adds Agents,
 * Board, Form AI Agent, and SyteLine views around it.
 */
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, Login, useAuth } from './auth';
import AppShell from './shell/AppShell';
import ChatView from './views/ChatView';
import AgentsView from './views/AgentsView';
import BoardView from './views/BoardView';
import FormsView from './views/FormsView';
import SytelineView from './views/SytelineView';

function RootRoutes() {
  const { user, login, authError } = useAuth();

  useEffect(() => {
    document.title = 'Enflite';
  }, []);

  if (user === undefined) {
    return <div className="h-screen grid place-items-center text-sm">Restoring secure session…</div>;
  }
  if (!user) {
    return <Login onLogin={login} error={authError} />;
  }
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<ChatView />} />
          <Route path="agents/*" element={<AgentsView />} />
          <Route path="board/*" element={<BoardView />} />
          <Route path="forms/*" element={<FormsView />} />
          <Route path="syteline/*" element={<SytelineView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <RootRoutes />
    </AuthProvider>
  );
}
