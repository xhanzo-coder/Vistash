import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { IconButton } from "../button/Button";
import styles from "./Toast.module.css";

const DEFAULT_TOAST_DURATION_MS = 4_200;

export type ToastTone = "info" | "success" | "warning";

export type ToastInput = {
  tone: ToastTone;
  title: string;
  description?: string;
  durationMs?: number;
};

type ToastRecord = ToastInput & {
  id: string;
  durationMs: number;
};

export type ToastController = {
  publish: (input: ToastInput) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastController | null>(null);

function ToneIcon({ tone }: { tone: ToastTone }): ReactNode {
  switch (tone) {
    case "success":
      return <CheckCircleIcon weight="fill" aria-hidden="true" />;
    case "warning":
      return <WarningIcon weight="fill" aria-hidden="true" />;
    case "info":
      return <InfoIcon weight="fill" aria-hidden="true" />;
  }
  throw new Error(`未知 Toast tone：${String(tone)}`);
}

function ToastItem({ record, onDismiss }: { record: ToastRecord; onDismiss: (id: string) => void }): ReactNode {
  useEffect(() => {
    const timeout = window.setTimeout(() => onDismiss(record.id), record.durationMs);
    return () => window.clearTimeout(timeout);
  }, [onDismiss, record.durationMs, record.id]);

  return (
    <div className={styles.toast} data-tone={record.tone} role="status">
      <span className={styles.toneIcon} aria-hidden="true"><ToneIcon tone={record.tone} /></span>
      <div className={styles.copy}>
        <strong>{record.title}</strong>
        {record.description === undefined ? null : <p>{record.description}</p>}
      </div>
      <IconButton
        className={styles.close}
        size="compact"
        label="关闭通知"
        icon={<XIcon />}
        onClick={() => onDismiss(record.id)}
      />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [records, setRecords] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string): void => {
    setRecords((current) => current.filter((record) => record.id !== id));
  }, []);

  const publish = useCallback((input: ToastInput): string => {
    const durationMs = input.durationMs ?? DEFAULT_TOAST_DURATION_MS;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new RangeError(`Toast 持续时间必须大于 0：${durationMs}`);
    }
    const id = crypto.randomUUID();
    setRecords((current) => [...current, { ...input, id, durationMs }]);
    return id;
  }, []);

  const controller = useMemo<ToastController>(() => ({ dismiss, publish }), [dismiss, publish]);

  return (
    <ToastContext.Provider value={controller}>
      {children}
      {createPortal(
        <div className={styles.viewport} aria-live="polite" aria-label="通知">
          {records.map((record) => (
            <ToastItem key={record.id} record={record} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastController {
  const controller = useContext(ToastContext);
  if (controller === null) throw new Error("useToast 必须在 ToastProvider 内使用");
  return controller;
}
