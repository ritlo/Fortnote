import {
  crdtBinaryAssociatedData,
  crdtCheckpointAssociatedData,
  crdtUpdateAssociatedData,
  decryptBytes,
  encryptBytes,
  encryptBytesV2,
  fromBase64
} from "@fortnote/shared";

type LegacyCrdtAadInput = {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  updateId: string;
  formatVersion: number;
} & ({ type: "crdt-update" } | { type: "crdt-checkpoint"; compactedUpdateIds: string[] });

interface BinaryCrdtAadInput {
  type: "crdt-update" | "crdt-checkpoint";
  formatVersion: 2;
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff?: number;
}

type CrdtAadInput = LegacyCrdtAadInput | BinaryCrdtAadInput;

export async function encryptCrdtMessage(
  input: CrdtAadInput & {
    noteKeyBase64: string;
    update: Uint8Array;
  }
) {
  const encrypt = input.formatVersion === 2 ? encryptBytesV2 : encryptBytes;
  return encrypt(input.update, fromBase64(input.noteKeyBase64), crdtMessageAad(input));
}

export async function decryptCrdtMessage(
  input: CrdtAadInput & {
    noteKeyBase64: string;
    cipher: string;
    nonce: string;
  }
): Promise<Uint8Array> {
  return decryptBytes(
    {
      cipher: input.cipher,
      nonce: input.nonce,
      formatVersion: input.formatVersion
    },
    fromBase64(input.noteKeyBase64),
    crdtMessageAad(input)
  );
}

function crdtMessageAad(input: CrdtAadInput): Uint8Array {
  if ("sectionId" in input) {
    return crdtBinaryAssociatedData(input);
  }
  return input.type === "crdt-checkpoint"
    ? crdtCheckpointAssociatedData(input)
    : crdtUpdateAssociatedData(input);
}
