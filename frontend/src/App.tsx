/**
 * App.tsx — application root.
 *
 * AuthProvider restores the session; unauthenticated users get the Login
 * screen; everyone else gets the routed app shell. The index route is the
 * command-center home; ChatView moved to /chat in the same slice.
 */
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, Login, useAuth } from './auth';
import AppShell from './shell/AppShell';
import HomeView from './views/HomeView';
import ChatView from './views/ChatView';
import AgentsView, { RequireTaskUi } from './views/AgentsView';
import TaskWorkspace from './tasks/TaskWorkspace';
import BoardView from './views/BoardView';
import FormsView from './views/FormsView';
import SytelineView from './views/SytelineView';
import StudioView from './studio/StudioView';

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
          <Route index element={<HomeView />} />
          <Route path="chat" element={<ChatView />} />
          <Route path="agents/*" element={<AgentsView />} />
          <Route
            path="tasks/:id"
            element={
              <RequireTaskUi>
                <TaskWorkspace />
              </RequireTaskUi>
            }
          />
          <Route path="board/*" element={<BoardView />} />
          <Route path="forms/*" element={<FormsView />} />
          <Route path="syteline/*" element={<SytelineView />} />
          <Route path="studio/*" element={<StudioView />} />
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
