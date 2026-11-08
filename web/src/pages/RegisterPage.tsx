import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { IconSpinner } from '../components/Icons';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Контракт: 422 при пароле короче 8 символов. */
const MIN_PASSWORD_LENGTH = 8;

interface FieldErrors {
  email?: string;
  displayName?: string;
  password?: string;
}

export function RegisterPage() {
  const navigate = useNavigate();
  const register = useAuthStore((state) => state.register);
  const user = useAuthStore((state) => state.user);
  const error = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  useEffect(() => () => clearError(), [clearError]);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    if (!email.trim()) nextErrors.email = 'Укажите email';
    else if (!EMAIL_RE.test(email.trim())) nextErrors.email = 'Похоже, email указан неверно';
    if (!displayName.trim()) nextErrors.displayName = 'Как вас называть?';
    if (password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = `Минимум ${MIN_PASSWORD_LENGTH} символов`;
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    const ok = await register(email, displayName, password);
    setSubmitting(false);
    if (ok) navigate('/', { replace: true });
  };

  const resetError = (): void => {
    if (error) clearError();
  };

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={handleSubmit} noValidate>
        <h1 className="auth__title">Регистрация</h1>
        <p className="auth__subtitle">Создайте аккаунт chat-abavava</p>

        {error ? <p className="auth__error">{error}</p> : null}

        <label className="field">
          <span className="field__label">Имя</span>
          <input
            className={`field__input${fieldErrors.displayName ? ' field__input--invalid' : ''}`}
            type="text"
            value={displayName}
            autoComplete="nickname"
            placeholder="Аня"
            onChange={(event) => {
              setDisplayName(event.target.value);
              resetError();
            }}
          />
          {fieldErrors.displayName ? (
            <span className="field__hint field__hint--error">{fieldErrors.displayName}</span>
          ) : null}
        </label>

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
              resetError();
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
            autoComplete="new-password"
            placeholder={`минимум ${MIN_PASSWORD_LENGTH} символов`}
            onChange={(event) => {
              setPassword(event.target.value);
              resetError();
            }}
          />
          {fieldErrors.password ? (
            <span className="field__hint field__hint--error">{fieldErrors.password}</span>
          ) : null}
        </label>

        <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
          {submitting ? <IconSpinner size={18} /> : null}
          Создать аккаунт
        </button>

        <p className="auth__footer">
          Уже есть аккаунт? <Link to="/login">Войти</Link>
        </p>
      </form>
    </div>
  );
}
