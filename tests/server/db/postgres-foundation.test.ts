import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findPostgresMigrationsDirectory } from "@server/db/postgres/client.js";

describe("PostgreSQL foundation", () => {
  it("discovers versioned migrations from a nested server directory", () => {
    const migrationsDirectory = findPostgresMigrationsDirectory(
      path.join(process.cwd(), "apps/server/src")
    );

    expect(migrationsDirectory).toBe(path.join(process.cwd(), "drizzle/postgres"));
  });

  it("defines chunked bytea attachment storage and folder integrity triggers", () => {
    const migrationsDirectory = findPostgresMigrationsDirectory(process.cwd());
    const migrationSql = fs
      .readdirSync(migrationsDirectory)
      .filter((filename) => filename.endsWith(".sql"))
      .sort()
      .map((filename) => fs.readFileSync(path.join(migrationsDirectory, filename), "utf8"))
      .join("\n");

    expect(migrationSql).toContain('CREATE TABLE "attachment_objects"');
    expect(migrationSql).toContain('CREATE TABLE "attachment_object_chunks"');
    expect(migrationSql).toContain('"ciphertext" "bytea" NOT NULL');
    expect(migrationSql).toContain("fortnote_validate_folder_parent_owner");
    expect(migrationSql).not.toMatch(/pg_largeobject/iu);
  });
});
