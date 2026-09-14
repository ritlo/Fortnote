import type {
  SectionRejectionCode,
  SectionWriteInput
} from "./contracts.js";

export interface WritableSectionAccess {
  cryptoOwnerId: string;
  keyEpoch: number;
  version: number;
  rootVersion: number;
  rotationFenced: boolean;
  isDeleted: boolean;
  role: string;
  status: string;
}

export function validateWritableSectionAccess(
  access: WritableSectionAccess | null,
  input: SectionWriteInput
): WritableSectionAccess | SectionRejectionCode {
  if (
    access?.status !== "active" ||
    access.isDeleted ||
    (access.role !== "owner" && access.role !== "editor")
  ) {
    return "forbidden";
  }
  if (access.keyEpoch !== input.expectedKeyEpoch) {
    return "stale-epoch";
  }
  if (access.rotationFenced) {
    return "rotation-pending";
  }
  return access;
}

export function isWritableSectionAccess(
  value: WritableSectionAccess | string
): value is WritableSectionAccess {
  return typeof value !== "string";
}
