import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findMigrationsDirectory } from "@server/db/client.js";

describe("database migrations", () => {
  it("discovers versioned migrations from a nested server directory", () => {
    const migrationsDirectory = findMigrationsDirectory(
      path.join(process.cwd(), "apps/server/src")
    );

    expect(migrationsDirectory).toBe(path.join(process.cwd(), "drizzle"));
  });

  it("defines chunked bytea attachment storage and folder integrity triggers", () => {
    const migrationsDirectory = findMigrationsDirectory(process.cwd());
    const migrationSql = fs
      .readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith(".sql"))
      .sort()
      .map((filename) =>
        fs.readFileSync(path.join(migrationsDirectory, filename), "utf8")
      )
      .join("\n");

    expect(migrationSql).toContain('CREATE TABLE "attachment_objects"');
    expect(migrationSql).toContain('CREATE TABLE "attachment_object_chunks"');
    expect(migrationSql).toContain('"ciphertext" "bytea" NOT NULL');
    expect(migrationSql).toContain("fortnote_validate_folder_parent_owner");
    expect(migrationSql).not.toMatch(/pg_largeobject/iu);
  });
});
