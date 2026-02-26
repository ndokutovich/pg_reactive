import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

const ToastContext = createContext(null);

let nextId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef({});

  const toast = useCallback((message, type = 'info') => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message, type }]);

    timersRef.current[id] = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      delete timersRef.current[id];
    }, 3200);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-area">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
