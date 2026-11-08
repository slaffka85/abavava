import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { IconSpinner } from './Icons';

/** Защищённый роут: без пользователя уводит на /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const user = useAuthStore((state) => state.user);
  const status = useAuthStore((state) => state.status);

  if (user) return <>{children}</>;

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="splash">
        <IconSpinner size={28} />
        <p>Загружаем сессию…</p>
      </div>
    );
  }

  return <Navigate to="/login" replace />;
}
