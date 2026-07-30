"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

// Extracted from app/ClientLayout.tsx's previously-local ToastMsg/ToastBanner/
// showToast (and the near-identical copy in app/cases/page.tsx) so any
// component — not just ClientLayout's own polling effects — can fire a toast.
// New capability over the original: passing a `route` makes the toast
// clickable, navigating there in addition to dismissing (used by the chat
// agent's "action completed" events to jump to the affected record).

interface Notification {
  id: number;
  text: string;
  ok: boolean;
  route?: string;
}

interface NotificationContextType {
  notify: (text: string, ok: boolean, route?: string) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

function ToastBanner({ notifications, onDismiss }: { notifications: Notification[]; onDismiss: (id: number) => void }) {
  const router = useRouter();
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
      {notifications.map((n) => (
        <div
          key={n.id}
          onClick={() => {
            if (n.route) router.push(`/${n.route}`);
            onDismiss(n.id);
          }}
          className={`pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg text-sm font-semibold border cursor-pointer select-none transition-all
            ${n.ok ? "bg-blue-50 border-blue-200 text-blue-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}
        >
          {n.ok ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          )}
          {n.text}
        </div>
      ))}
    </div>
  );
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const idRef = useRef(0);
  // ClientLayout (a descendant of this provider) renders the app's actual
  // <body> JSX — portaling into document.body places the banner as a proper
  // child of it regardless of where NotificationProvider itself sits in the
  // tree, instead of requiring it to be structurally nested inside <body>.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const notify = useCallback((text: string, ok: boolean, route?: string) => {
    const id = ++idRef.current;
    setNotifications((prev) => [...prev, { id, text, ok, route }]);
    setTimeout(() => setNotifications((prev) => prev.filter((n) => n.id !== id)), 5000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return (
    <NotificationContext.Provider value={{ notify }}>
      {children}
      {mounted && createPortal(<ToastBanner notifications={notifications} onDismiss={dismiss} />, document.body)}
    </NotificationContext.Provider>
  );
}

export function useNotify() {
  const ctx = useContext(NotificationContext);
  if (ctx === undefined) {
    throw new Error("useNotify must be used within a NotificationProvider");
  }
  return ctx;
}
