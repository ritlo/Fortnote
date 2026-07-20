import { useEffect, useRef } from "react";
import { sectionRuntimeKey, useAppStore } from "../store/appStore";

interface SectionNavigatorProps {
  noteId: string;
  canEdit: boolean;
  onCreate?: () => void;
  onCopy?: (sectionId: string) => void;
  onDelete?: (sectionId: string) => void;
  onMerge?: (sectionId: string) => void;
  onMove?: (sectionId: string, direction: -1 | 1) => void;
  onRetry?: (() => void) | undefined;
  onSplit?: (sectionId: string) => void;
}

export function SectionNavigator({
  noteId,
  canEdit,
  onCreate,
  onCopy,
  onDelete,
  onMerge,
  onMove,
  onRetry,
  onSplit
}: SectionNavigatorProps) {
  const index = useAppStore((state) => state.sectionIndexes[noteId]);
  const selectedSectionId = useAppStore(
    (state) => state.selectedSectionByNote[noteId] ?? null
  );
  const loadedSections = useAppStore((state) => state.loadedSections);
  const setSelectedSection = useAppStore((state) => state.setSelectedSection);
  const currentButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const source = document.activeElement;
    if (
      source instanceof HTMLElement &&
      source.dataset.sectionTarget === selectedSectionId
    ) {
      currentButtonRef.current?.focus();
    }
  }, [selectedSectionId]);

  if (!index || index.status === "idle" || index.status === "loading") {
    return (
      <nav aria-label="Note sections" className="section-navigator">
        <p aria-live="polite">Opening encrypted note…</p>
      </nav>
    );
  }
  if (index.status === "error") {
    return (
      <nav aria-label="Note sections" className="section-navigator">
        <p role="alert">{index.error ?? "Encrypted note index could not load"}</p>
        <button type="button" disabled={!onRetry} onClick={onRetry}>Retry</button>
      </nav>
    );
  }

  const visibleById = new Map(
    index.sections
      .filter((section) => !section.isDeleted)
      .map((section) => [section.id, section])
  );
  const ordered = index.orderedSectionIds.filter((sectionId) =>
    visibleById.has(sectionId)
  );
  const currentIndex = selectedSectionId
    ? ordered.indexOf(selectedSectionId)
    : -1;
  const current = selectedSectionId
    ? loadedSections[sectionRuntimeKey(noteId, selectedSectionId)]
    : undefined;

  return (
    <nav
      aria-busy={current?.status === "loading" ? true : undefined}
      aria-label="Note sections"
      className="section-navigator"
    >
      <div className="section-position" role="status" aria-live="polite">
        {currentIndex >= 0
          ? `Section ${String(currentIndex + 1)} of ${String(ordered.length)}`
          : `${String(ordered.length)} sections`}
        {current?.status === "loading" ? " — Loading section…" : ""}
        {current?.status === "releasing" ? " — Securing pending changes…" : ""}
      </div>
      {current?.transferProgress ? (
        <progress
          aria-label={`Section ${current.transferProgress.phase} progress`}
          max={current.transferProgress.totalBytes}
          value={current.transferProgress.transferredBytes}
        >
          {String(current.transferProgress.completedChunks)} of{" "}
          {String(current.transferProgress.totalChunks)} chunks
        </progress>
      ) : null}
      <ol aria-label="Sections in note">
        {ordered.map((sectionId, position) => {
          const section = loadedSections[sectionRuntimeKey(noteId, sectionId)];
          const isCurrent = sectionId === selectedSectionId;
          return (
            <li key={sectionId}>
              <button
                type="button"
                aria-current={isCurrent ? "page" : undefined}
                aria-describedby={`section-status-${sectionId}`}
                ref={isCurrent ? currentButtonRef : undefined}
                onClick={() => {
                  setSelectedSection(noteId, sectionId);
                }}
              >
                Section {String(position + 1)}
              </button>
              <span
                className="section-boundary-status"
                id={`section-status-${sectionId}`}
              >
                {sectionStatus(section?.status)}
              </span>
            </li>
          );
        })}
      </ol>
      {current?.status === "error" ? (
        <div role="alert">
          {current.error ?? "Encrypted section could not load"}
          <button type="button" disabled={!onRetry} onClick={onRetry}>Retry section</button>
        </div>
      ) : null}
      {canEdit ? (
        <div className="action-row section-actions">
          <button type="button" disabled={!onCreate} onClick={onCreate}>
            Add section
          </button>
          <button
            type="button"
            disabled={!onMove || currentIndex <= 0 || !selectedSectionId}
            onClick={() => {
              if (selectedSectionId) {
                onMove?.(selectedSectionId, -1);
              }
            }}
          >
            Move up
          </button>
          <button
            type="button"
            disabled={
              !onMove ||
              currentIndex < 0 ||
              currentIndex >= ordered.length - 1 ||
              !selectedSectionId
            }
            onClick={() => {
              if (selectedSectionId) {
                onMove?.(selectedSectionId, 1);
              }
            }}
          >
            Move down
          </button>
          <button
            type="button"
            disabled={!onSplit || !selectedSectionId || current?.status !== "ready"}
            onClick={() => {
              if (selectedSectionId) {
                onSplit?.(selectedSectionId);
              }
            }}
          >
            Split section
          </button>
          <button
            type="button"
            disabled={
              !onCopy ||
              !selectedSectionId ||
              currentIndex < 0 ||
              currentIndex >= ordered.length - 1 ||
              current?.status !== "ready"
            }
            onClick={() => {
              if (selectedSectionId) {
                onCopy?.(selectedSectionId);
              }
            }}
          >
            Copy into next
          </button>
          <button
            type="button"
            disabled={
              !onMerge ||
              !selectedSectionId ||
              currentIndex < 0 ||
              currentIndex >= ordered.length - 1 ||
              current?.status !== "ready"
            }
            onClick={() => {
              if (selectedSectionId) {
                onMerge?.(selectedSectionId);
              }
            }}
          >
            Merge with next
          </button>
          <button
            type="button"
            disabled={
              !onDelete ||
              !selectedSectionId ||
              ordered.length <= 1 ||
              current?.status === "loading" ||
              current?.status === "releasing"
            }
            onClick={() => {
              if (selectedSectionId) {
                onDelete?.(selectedSectionId);
              }
            }}
          >
            Delete section
          </button>
        </div>
      ) : null}
    </nav>
  );
}

function sectionStatus(status: string | undefined): string {
  switch (status) {
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "releasing":
      return "Securing changes";
    case "error":
      return "Needs attention";
    default:
      return "Unloaded";
  }
}
