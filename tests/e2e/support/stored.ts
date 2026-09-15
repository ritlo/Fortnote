import { Client } from "pg";
import { getConfig, type ServerConfig } from "../../../apps/server/src/config.js";
import { validateStorageId } from "../../../apps/server/src/attachments/storage.js";
import { e2eServerEnvironment } from "./environment.js";

type Row = Record<string, unknown>;
type Select = (sql: string, parameters: string[]) => Promise<Row[]>;

function inspectionConfig(): ServerConfig {
  return getConfig(e2eServerEnvironment());
}

async function inspect<T>(
  config: ServerConfig,
  read: (select: Select) => Promise<T>
): Promise<T> {
  const client = new Client({
    connectionString: config.database.url,
    connectionTimeoutMillis: 5_000
  });
  try {
    await client.connect();
    return await read(async (sql, parameters) => {
      let index = 0;
      const result = await client.query<Row>(
        sql.replace(/\?/g, () => `$${String(++index)}`),
        parameters
      );
      return result.rows;
    });
  } finally {
    await client.end();
  }
}

async function readCiphertext(select: Select, storageKey: string): Promise<Buffer> {
  validateStorageId(storageKey);
  const object = (
    await select("SELECT byte_length FROM attachment_objects WHERE storage_key = ?", [
      storageKey
    ])
  ).at(0);
  if (!object) throw new Error("Stored ciphertext not found");
  const chunks = await select(
    "SELECT ciphertext FROM attachment_object_chunks WHERE storage_key = ? ORDER BY chunk_index",
    [storageKey]
  );
  const bytes = Buffer.concat(
    chunks.map((row) => {
      if (!Buffer.isBuffer(row.ciphertext)) throw new Error("Invalid stored ciphertext");
      return row.ciphertext;
    })
  );
  if (bytes.length !== Number(object.byte_length))
    throw new Error("Incomplete stored ciphertext");
  return bytes;
}

export function readStoredAttachment(
  storageKey: string,
  config = inspectionConfig()
): Promise<Buffer> {
  return inspect(config, (select) => readCiphertext(select, storageKey));
}

export function readStoredNote(ownerUsername: string, config = inspectionConfig()) {
  return inspect(config, async (select) => {
    const note = (
      await select(
        "SELECT n.* FROM notes n JOIN users u ON u.id = n.user_id WHERE u.username = ? ORDER BY n.created_at DESC LIMIT 1",
        [ownerUsername]
      )
    ).at(0);
    if (!note || typeof note.id !== "string")
      throw new Error(`Stored note not found for: ${ownerUsername}`);
    const noteId = note.id;
    const forNote = (table: string) =>
      select(`SELECT * FROM ${table} WHERE note_id = ?`, [noteId]);
    const metadata = {
      attachments: await forNote("attachments"),
      note_updates: await forNote("note_updates"),
      note_key_shares: await forNote("note_key_shares"),
      section_updates: await forNote("section_updates"),
      content_manifests: await forNote("content_manifests"),
      content_uploads: await forNote("content_uploads"),
      content_chunks: await select(
        "SELECT c.* FROM content_chunks c JOIN content_uploads u ON u.id = c.upload_id WHERE u.note_id = ?",
        [noteId]
      )
    };
    const attachments = await Promise.all(
      metadata.attachments.map(async (row) => {
        if (typeof row.id !== "string" || typeof row.storage_key !== "string")
          throw new Error("Invalid stored attachment");
        return {
          id: row.id,
          storageKey: row.storage_key,
          bytes: await readCiphertext(select, row.storage_key)
        };
      })
    );
    const contentBytes: Buffer[] = [];
    for (const row of metadata.content_chunks) {
      if (typeof row.file_cipher_path !== "string") {
        throw new Error("Invalid stored content chunk");
      }
      contentBytes.push(await readCiphertext(select, row.file_cipher_path));
    }
    for (const row of metadata.section_updates) {
      if (Buffer.isBuffer(row.inline_cipher) || row.inline_cipher instanceof Uint8Array) {
        contentBytes.push(Buffer.from(row.inline_cipher));
      }
    }
    return {
      databasePayload: JSON.stringify({ note, ...metadata }),
      attachments,
      contentBytes
    };
  });
}
