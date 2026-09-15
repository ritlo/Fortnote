import {
  crdtBinaryAssociatedData,
  decryptBytes,
  encryptBytesV2,
  fromBase64
} from "@fortnote/shared";

interface CrdtAadInput {
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

export async function encryptCrdtMessage(
  input: CrdtAadInput & {
    noteKeyBase64: string;
    update: Uint8Array;
  }
) {
  return encryptBytesV2(
    input.update,
    fromBase64(input.noteKeyBase64),
    crdtBinaryAssociatedData(input)
  );
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
    crdtBinaryAssociatedData(input)
  );
}
