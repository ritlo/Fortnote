import { useEffect, useRef, type RefObject } from "react";
import type { DecryptedNote } from "../store/appStore";
import { SharingPanel } from "./SharingPanel";

interface SharingDialogProps {
  selectedNote: DecryptedNote | null;
  open: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

export function SharingDialog({ selectedNote, open, onClose, returnFocusRef }: SharingDialogProps) {
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
    const handler = () => {
      onClose();
      returnFocusRef?.current?.focus();
    };
    el.addEventListener("close", handler);
    return () => { el.removeEventListener("close", handler); };
  }, [onClose, returnFocusRef]);

  if (!open && !ref.current?.open) return null;

  return (
    <dialog
      ref={ref}
      aria-label="Share note"
      className="sharing-dialog"
    >
      <div className="sharing-dialog-content">
        <div className="sharing-dialog-header">
          <h3>Share note</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="text-button"
            onClick={() => { ref.current?.close(); }}
            aria-label="Close sharing dialog"
          >
            Close
          </button>
        </div>
        <SharingPanel selectedNote={selectedNote} disabled={false} />
      </div>
    </dialog>
  );
}
