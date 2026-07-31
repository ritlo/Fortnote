import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "@server/config.js";
import { removeOrphanedEncryptedAttachments } from "@server/attachments/storage.js";

describe("attachment storage cleanup", () => {
  it("preserves a recently written file while its upload is being committed", async () => {
    const dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "fortnote-attachments-"));
    const storageId = "11111111-1111-4111-8111-111111111111";
    const filePath = path.join(dataDir, storageId);

    try {
      await fsPromises.writeFile(filePath, Buffer.from("encrypted bytes"));

      removeOrphanedEncryptedAttachments(
        { dataDir } as ServerConfig,
        new Set()
      );

      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      await fsPromises.rm(dataDir, { recursive: true, force: true });
    }
  });
});
