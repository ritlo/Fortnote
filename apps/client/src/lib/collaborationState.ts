export type CollaborationAction =
  | "cleanup"
  | "copy"
  | "discard"
  | "encrypted-export"
  | "reapply"
  | "repair-access"
  | "retry"
  | "review-access"
  | "review-draft"
  | "try-again";

export interface CollaborationDimensions {
  access: "owner" | "editor" | "viewer" | "trash" | "removed";
  protection: "ready" | "undecryptable" | "stale" | "preparing" | "activated" | "aborted";
  section: "idle" | "opening" | "loading" | "ready" | "unavailable";
  durability: "clean" | "memory" | "pending" | "saving" | "uploading" | "local-full" | "server-full" | "compacting";
  connection: "connected" | "offline" | "reconnecting";
  recovery: "none" | "divergent" | "reviewing" | "conflict" | "error";
  vault: "loading" | "empty" | "ready";
  draftRetained: boolean;
}

export interface CollaborationState {
  id: string;
  label: string;
  announcement: "none" | "polite" | "assertive" | "alert";
  editing: boolean;
  actions: CollaborationAction[];
  draftRetained: boolean;
  saved: boolean;
  synchronized: boolean;
}

export const defaultCollaborationDimensions: CollaborationDimensions = {
  access: "owner",
  protection: "ready",
  section: "ready",
  durability: "clean",
  connection: "connected",
  recovery: "none",
  vault: "ready",
  draftRetained: false
};

export function deriveCollaborationState(
  value: CollaborationDimensions
): CollaborationState {
  const editable = value.access === "owner" || value.access === "editor";
  const state = pickState(value, editable);
  return {
    ...state,
    draftRetained: value.draftRetained,
    saved: state.id === "saved",
    synchronized: state.id === "saved"
  };
}

function pickState(
  value: CollaborationDimensions,
  editable: boolean
): Omit<CollaborationState, "draftRetained" | "saved" | "synchronized"> {
  if (value.access === "removed") return state("removed", "You no longer have access", "alert", false);
  if (value.protection === "undecryptable") return state("undecryptable", "This note cannot be decrypted", "alert", false, ["retry", "repair-access"]);
  if (value.recovery === "reviewing") return state("reviewing", "Review retained encrypted draft", "alert", false, ["copy", "encrypted-export", "reapply", "discard"]);
  if (value.recovery === "divergent" || value.recovery === "conflict") return state("review", "Changes need review", "alert", false, ["review-draft", "encrypted-export", "reapply"]);
  if (value.durability === "local-full") return state("local-full", "Local storage full — changes need attention", "alert", editable, ["retry", "encrypted-export", "cleanup"]);
  if (value.durability === "server-full") return state("server-full", "Server storage full — changes kept on this device", "alert", editable, ["retry", "encrypted-export"]);
  if (value.protection === "stale") return state("stale", "Access changed — refreshing protection", "assertive", false);
  if (value.protection === "preparing") return state("rotation-preparing", "Securing access — editing paused", "assertive", false, ["retry", "review-access"]);
  if (value.protection === "activated") return state("rotation-activated", "Access revoked and protection updated", "polite", false);
  if (value.protection === "aborted") return state("rotation-aborted", "Access change not completed", "alert", editable, ["try-again", "review-access"]);
  if (value.access === "trash") return state("trash", "In trash — view only", "polite", false);
  if (value.access === "viewer") return state("viewer", "View only", "polite", false);
  if (value.section === "opening") return state("opening", "Opening encrypted note…", "polite", false);
  if (value.section === "loading" || value.section === "unavailable") return state("section-loading", "Loading encrypted note…", "polite", false, ["retry"]);
  if (value.connection === "offline") return state("offline", "Offline — changes kept on this device", "assertive", editable);
  if (value.connection === "reconnecting") return state("reconnecting", "Reconnecting…", "polite", editable);
  if (value.durability === "memory") return state("preserving", "Preserving changes…", "polite", editable);
  if (value.durability === "uploading") return state("uploading", "Uploading encrypted changes…", "polite", editable);
  if (value.durability === "saving") return state("saving", "Saving encrypted note…", "polite", editable);
  if (value.durability === "pending") return state("synchronizing", "Synchronizing…", "polite", editable);
  if (value.durability === "compacting") return state("compacting", "Synchronizing paused — optimizing history", "polite", editable, ["retry"]);
  if (value.recovery === "error") return state("error", "Operation failed", "alert", editable, ["retry"]);
  if (value.vault === "loading") return state("vault-loading", "Loading vault…", "polite", false);
  if (value.vault === "empty") return state("empty", "No notes yet", "none", editable);
  if (value.section === "ready") return state("saved", "Saved and synchronized", "polite", editable);
  return state("ready", "Ready", "none", editable);
}

function state(
  id: string,
  label: string,
  announcement: CollaborationState["announcement"],
  editing: boolean,
  actions: CollaborationAction[] = []
): Omit<CollaborationState, "draftRetained" | "saved" | "synchronized"> {
  return { id, label, announcement, editing, actions };
}
