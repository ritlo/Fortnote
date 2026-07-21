// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import { NotesPane } from "./NotesPane";

afterEach(cleanup);

describe("NotesPane protected search", () => {
  it("discloses incomplete coverage, offers retry, and opens a section match", () => {
    const retrySearchIndex = vi.fn();
    const selectSearchMatch = vi.fn();
    const match = {
      blockId: "block-a",
      excerpt: "Needle in encrypted section",
      indexedSequence: 2,
      noteId: "note-a",
      sectionId: "section-a"
    };
    render(
      <NotesPane
        addNote={vi.fn()}
        error={null}
        filteredNotes={[note()]}
        notesView="notes"
        realtimeStatus="connected"
        recoverySecret={null}
        retrySearchIndex={retrySearchIndex}
        search="needle"
        searchCoverage={{
          complete: false,
          indexedSections: 1,
          totalSections: 3,
          pending: []
        }}
        searchIndexError="Background indexing paused."
        searchIndexStatus="error"
        searchMatches={[match]}
        selectSearchMatch={selectSearchMatch}
        selectedNoteId={null}
        setSearch={vi.fn()}
        setSelectedNoteId={vi.fn()}
        status="Ready"
      />
    );

    expect(screen.getByLabelText("Search notes")).toBeTruthy();
    expect(screen.getByLabelText("Search notes").getAttribute("aria-describedby"))
      .toBe("search-coverage-status");
    expect(screen.getByText(/more results may appear.*1 of 3/u)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Search indexing progress" }))
      .toHaveProperty("value", 1);
    expect(screen.getByText("Background indexing paused.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry indexing" }));
    fireEvent.click(screen.getByRole("button", {
      name: /Search result 1 of 1.*Needle in encrypted section/u
    }));
    expect(retrySearchIndex).toHaveBeenCalledOnce();
    expect(selectSearchMatch).toHaveBeenCalledWith(match);
  });
});

function note(): DecryptedNote {
  return {
    contentLength: 1024,
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note-a",
    isDeleted: false,
    keyEpoch: 1,
    noteKeyBase64: "note-key",
    ownerUserId: "alice",
    role: "owner",
    rootSectionId: "section-a",
    title: "Searchable note",
    updatedAt: "2026-07-19T00:00:00.000Z",
    version: 1
  };
}
