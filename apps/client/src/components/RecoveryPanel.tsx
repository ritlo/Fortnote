import type { CollaborationAction, CollaborationState } from "../lib/collaborationState";

export interface RecoveryCallbacks {
  cleanup: () => void | Promise<void>;
  copy: () => void | Promise<void>;
  discard: () => void | Promise<void>;
  encryptedExport: () => void | Promise<void>;
  reapply: () => void | Promise<void>;
  repairAccess: () => void | Promise<void>;
  retry: () => void | Promise<void>;
  reviewAccess: () => void | Promise<void>;
  reviewDraft: () => void | Promise<void>;
  splitSection: () => void | Promise<void>;
  tryAgain: () => void | Promise<void>;
}

interface RecoveryPanelProps {
  state: CollaborationState;
  callbacks: RecoveryCallbacks;
}

const actions: Record<CollaborationAction, [string, keyof RecoveryCallbacks]> = {
  cleanup: ["Clean up", "cleanup"],
  copy: ["Copy encrypted draft", "copy"],
  discard: ["Discard draft", "discard"],
  "encrypted-export": ["Encrypted export", "encryptedExport"],
  reapply: ["Reapply", "reapply"],
  "repair-access": ["Repair access", "repairAccess"],
  retry: ["Retry", "retry"],
  "review-access": ["Review access", "reviewAccess"],
  "review-draft": ["Review draft", "reviewDraft"],
  "split-section": ["Split section", "splitSection"],
  "try-again": ["Try again", "tryAgain"]
};

export function RecoveryPanel({ state, callbacks }: RecoveryPanelProps) {
  if (state.actions.length === 0) return null;
  return (
    <section className="recovery-panel" aria-label="Recovery actions">
      {state.draftRetained ? (
        <p>Your encrypted draft is retained until you explicitly discard it.</p>
      ) : null}
      <div className="action-row">
        {state.actions.map((action) => {
          const [label, callback] = actions[action];
          return <button type="button" key={action} onClick={() => void callbacks[callback]()}>{label}</button>;
        })}
      </div>
    </section>
  );
}
