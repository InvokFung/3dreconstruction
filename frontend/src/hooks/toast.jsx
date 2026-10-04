import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import Icon from '../components/ui/Icon.jsx';
import styles from './toast.module.css';

const ToastContext = createContext(null);

const ICON = { ok: 'check', danger: 'alert', info: 'info' };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback(
    ({ tone = 'info', title, message, timeout = 5000 }) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((t) => [...t.slice(-3), { id, tone, title, message }]);
      if (timeout) setTimeout(() => dismiss(id), timeout);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      push,
      dismiss,
      success: (title, message) => push({ tone: 'ok', title, message }),
      error: (title, message) => push({ tone: 'danger', title, message, timeout: 8000 }),
      info: (title, message) => push({ tone: 'info', title, message }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.region} role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`${styles.toast} ${styles[t.tone] ?? ''}`} role={t.tone === 'danger' ? 'alert' : 'status'}>
            <Icon name={ICON[t.tone] ?? 'info'} className={styles.icon} />
            <div className={styles.text}>
              {t.title && <strong>{t.title}</strong>}
              {t.message && <span>{t.message}</span>}
            </div>
            <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
