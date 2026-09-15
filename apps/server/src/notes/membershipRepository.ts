export type EditableMemberRole = "editor" | "viewer";

export interface InviteNoteMemberInput {
  noteId: string;
  actorUserId: string;
  noteVersion: number;
  username: string;
  role: EditableMemberRole;
  sharingKeyVersion: number;
  encryptedNoteKey: string;
  formatVersion: number;
  clientInstanceId?: string;
}

export type InviteNoteMemberOutcome =
  | { status: "invited"; cursor: number; userId: string; username: string }
  | { status: "note_not_found" }
  | { status: "sharing_key_not_found" }
  | { status: "self" }
  | { status: "owner" };

export interface ChangeNoteMemberInput {
  noteId: string;
  actorUserId: string;
  targetUserId: string;
  noteVersion: number;
  clientInstanceId?: string;
}

export interface UpdateNoteMemberRoleInput extends ChangeNoteMemberInput {
  role: EditableMemberRole;
}

export interface NoteMembershipRepository {
  invite(input: InviteNoteMemberInput): Promise<InviteNoteMemberOutcome>;
  updateRole(input: UpdateNoteMemberRoleInput): Promise<number | null>;
  revoke(input: ChangeNoteMemberInput): Promise<number | null>;
}
