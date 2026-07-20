import type { CollaborationAction, CollaborationState } from "../lib/collaborationState";

export interface RecoveryCallbacks {
  cleanup: () => void;
  encryptedExport: () => void;
  reapply: () => void;
  repairAccess: () => void;
  retry: () => void;
  reviewAccess: () => void;
  reviewDraft: () => void;
  splitSection: () => void;
  tryAgain: () => void;
}

interface RecoveryPanelProps {
  state: CollaborationState;
  callbacks: RecoveryCallbacks;
}

const actions: Record<CollaborationAction, [string, keyof RecoveryCallbacks]> = {
  cleanup: ["Clean up", "cleanup"],
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
          return <button type="button" key={action} onClick={callbacks[callback]}>{label}</button>;
        })}
      </div>
    </section>
  );
}
