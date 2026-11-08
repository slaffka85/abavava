import { useToastStore } from '../store/toast';
import { IconAlert, IconCheck, IconClose } from './Icons';

/** Всплывающие баннеры ошибок API/WS (кнопка закрытия + автозакрытие). */
export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          <span className="toast__icon">
            {toast.kind === 'error' ? <IconAlert size={18} /> : <IconCheck size={18} />}
          </span>
          <div className="toast__body">
            <p className="toast__title">{toast.title}</p>
            {toast.message ? <p className="toast__message">{toast.message}</p> : null}
          </div>
          <button type="button" className="toast__close" aria-label="Закрыть" onClick={() => dismiss(toast.id)}>
            <IconClose size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
