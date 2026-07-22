import { useEffect, useRef } from "react";
import type { CollaborationState } from "../lib/collaborationState";
import { RecoveryPanel, type RecoveryCallbacks } from "./RecoveryPanel";

interface RecoveryDialogProps {
  state: CollaborationState;
  callbacks: RecoveryCallbacks;
  open: boolean;
  onClose: () => void;
}

export function RecoveryDialog({ state, callbacks, open, onClose }: RecoveryDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      closeButtonRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = () => { onClose(); };
    el.addEventListener("close", handler);
    return () => { el.removeEventListener("close", handler); };
  }, [onClose]);

  if (!open && !ref.current?.open) return null;

  return (
    <dialog
      ref={ref}
      aria-label="Recovery actions"
      className="recovery-dialog"
    >
      <div className="recovery-dialog-content">
        <div className="recovery-dialog-header">
          <h3>Recovery</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="text-button"
            onClick={onClose}
            aria-label="Close recovery dialog"
          >
            Close
          </button>
        </div>
        <RecoveryPanel state={state} callbacks={callbacks} />
      </div>
    </dialog>
  );
}
