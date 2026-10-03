import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import "./toast.css";

export interface ToastOptions {
  message: string;
  /** One optional action, such as undo; running it dismisses the toast. */
  action?: { label: string; run(): void };
  /** Milliseconds before it fades out on its own. */
  duration?: number;
}
interface Toast extends ToastOptions {
  id: number;
}
type ShowToast = (toast: ToastOptions) => void;

const ToastContext = createContext<ShowToast>(() => undefined);

/** Brief, self-dismissing notices at the top of the workbench. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const show = useCallback<ShowToast>((toast) => {
    const id = ++next.current;
    // A newer notice replaces older ones; undo only makes sense for the latest.
    setToasts([{ ...toast, id }]);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="region" aria-label="通知">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  /** Stable across renders, so app re-renders never restart the countdown. */
  onDismiss(id: number): void;
}) {
  const [paused, setPaused] = useState(false);
  const { id } = toast;
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(id), toast.duration ?? 5000);
    return () => clearTimeout(timer);
  }, [paused, toast.duration, id, onDismiss]);
  return (
    <div
      className="toast"
      role="status"
      aria-live="polite"
      // Hovering or focusing holds the toast so its action stays reachable.
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            onDismiss(id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="toast-close"
        aria-label="关闭通知"
        onClick={() => onDismiss(id)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
