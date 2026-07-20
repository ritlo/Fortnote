import type { CollaborationState } from "../lib/collaborationState";

interface CollaborationStatusProps {
  state: CollaborationState;
  progress?: { completed: number; total: number } | undefined;
}

export function CollaborationStatus({ state, progress }: CollaborationStatusProps) {
  const liveProps = state.announcement === "alert"
    ? { role: "alert" as const }
    : state.announcement === "none"
      ? {}
      : { role: "status" as const, "aria-live": state.announcement };
  return (
    <div className={`collaboration-status collaboration-status-${state.id}`} {...liveProps}>
      <span>{state.label}</span>
      {progress ? (
        <progress
          aria-label="Encrypted synchronization progress"
          value={progress.completed}
          max={progress.total}
        />
      ) : null}
    </div>
  );
}
