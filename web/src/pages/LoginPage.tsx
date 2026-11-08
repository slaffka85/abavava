import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { IconSpinner } from '../components/Icons';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const user = useAuthStore((state) => state.user);
  const error = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  useEffect(() => () => clearError(), [clearError]);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const nextErrors: { email?: string; password?: string } = {};
    if (!email.trim()) nextErrors.email = 'Укажите email';
    else if (!EMAIL_RE.test(email.trim())) nextErrors.email = 'Похоже, email указан неверно';
    if (!password) nextErrors.password = 'Введите пароль';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    const ok = await login(email, password);
    setSubmitting(false);
    if (ok) navigate('/', { replace: true });
  };

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={handleSubmit} noValidate>
        <h1 className="auth__title">chat-abavava</h1>
        <p className="auth__subtitle">Войдите, чтобы продолжить общение</p>

        {error ? <p className="auth__error">{error}</p> : null}

        <label className="field">
          <span className="field__label">Email</span>
          <input
            className={`field__input${fieldErrors.email ? ' field__input--invalid' : ''}`}
            type="email"
            value={email}
            autoComplete="email"
            placeholder="you@example.com"
            onChange={(event) => {
              setEmail(event.target.value);
              if (error) clearError();
            }}
          />
          {fieldErrors.email ? <span className="field__hint field__hint--error">{fieldErrors.email}</span> : null}
        </label>

        <label className="field">
          <span className="field__label">Пароль</span>
          <input
            className={`field__input${fieldErrors.password ? ' field__input--invalid' : ''}`}
            type="password"
            value={password}
            autoComplete="current-password"
            placeholder="••••••••"
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) clearError();
            }}
          />
          {fieldErrors.password ? (
            <span className="field__hint field__hint--error">{fieldErrors.password}</span>
          ) : null}
        </label>

        <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
          {submitting ? <IconSpinner size={18} /> : null}
          Войти
        </button>

        <p className="auth__footer">
          Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
        </p>
      </form>
    </div>
  );
}
