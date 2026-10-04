import { createContext, useCallback, useContext, useState } from 'react';
import './Toasts.css';

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((toast) => {
    const id = nextId++;
    setToasts(t => [...t, { id, kind: 'info', ...toast }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), toast.kind === 'error' ? 9000 : 6000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div className="toast-title">{t.title}</div>
            {t.message && <div className="toast-msg">{t.message}</div>}
            {t.link && <a href={t.link} target="_blank" rel="noreferrer">View transaction ↗</a>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
