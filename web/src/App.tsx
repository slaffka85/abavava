import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastHost } from './components/ToastHost';
import { RequireAuth } from './components/RequireAuth';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { bootstrapApp, registerAuthFailureHandler, startSession, stopSession } from './app/session';
import { useAuthStore } from './store/auth';

export default function App() {
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    // Обработчик «сессию восстановить нельзя» (невалидный refresh) → /login.
    const unsubscribe = registerAuthFailureHandler();
    void bootstrapApp();
    return unsubscribe;
  }, []);

  // Realtime поднимается, когда появился пользователь, и глушится при выходе.
  useEffect(() => {
    if (!user) return;
    startSession(user.id);
    return () => stopSession();
  }, [user]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </BrowserRouter>
  );
}
