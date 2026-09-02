export const ROOT_CRDT_SECTION_ID = "root";

export function storageSectionId(noteId: string, sectionId: string): string {
  return sectionId === ROOT_CRDT_SECTION_ID ? noteId : sectionId;
}
