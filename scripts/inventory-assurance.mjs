#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function scanOpenSpec(specRoot, sourceRoot = path.dirname(path.dirname(specRoot))) {
  const items = [];
  for (const file of specFiles(specRoot)) {
    const source = path.relative(sourceRoot, file).split(path.sep).join("/");
    let parent;
    let fenced = false;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
      if (/^\s*(?:```|~~~)/u.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const requirement = line.match(/^###\s+Requirement:\s*(.+?)\s*$/u);
      if (requirement) {
        const heading = requirement[1];
        parent = stableId("requirement", source, heading);
        items.push({ id: parent, kind: "requirement", source, heading });
        continue;
      }
      const scenario = line.match(/^####\s+Scenario:\s*(.+?)\s*$/u);
      if (scenario && parent) {
        const heading = scenario[1];
        items.push({
          id: stableId("scenario", source, parent, heading),
          kind: "scenario",
          source,
          heading,
          parentId: parent
        });
      }
    }
  }
  return items;
}

function specFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return specFiles(target);
      return entry.isFile() && entry.name === "spec.md" ? [target] : [];
    });
}

function stableId(kind, ...parts) {
  const slug = parts.at(-1)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48)
    .replace(/-$/u, "") || kind;
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
  return `${kind}.${slug}.${digest}`;
}

function parseArguments(argv) {
  const values = {
    specRoot: path.resolve("openspec/specs"),
    ledger: path.resolve("specs/001-collaboration-design-assurance/assurance.json"),
    mode: "check"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") values.mode = "write";
    else if (argument === "--check") values.mode = "check";
    else if (argument === "--spec-root") values.specRoot = path.resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--ledger") values.ledger = path.resolve(requiredValue(argv, ++index, argument));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function validateInventory(actual, expected, ledgerDirectory) {
  const errors = [];
  const ids = new Set();
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  const actualById = new Map();
  for (const item of actual) {
    if (!item || typeof item !== "object" || typeof item.id !== "string"
      || typeof item.heading !== "string" || typeof item.source !== "string"
      || !["requirement", "scenario"].includes(item.kind)) {
      errors.push(`Malformed inventory row: ${JSON.stringify(item)}`);
      continue;
    }
    if (ids.has(item.id)) errors.push(`Duplicate inventory ID: ${item.id}`);
    ids.add(item.id);
    actualById.set(item.id, item);
    if (!existsSync(path.resolve(ledgerDirectory, item.source))) {
      errors.push(`Stale source path: ${item.source}`);
    }
    if (item.kind === "scenario" && (!item.parentId || !ids.has(item.parentId))) {
      errors.push(`Scenario ${item.heading} has missing parent ${item.parentId ?? "(none)"}`);
    }
  }
  for (const [id, item] of expectedById) {
    const recorded = actualById.get(id);
    if (!recorded) errors.push(`Inventory drift: missing ${item.kind} heading "${item.heading}" (${item.source})`);
    else if (recorded.heading !== item.heading || recorded.source !== item.source
      || recorded.kind !== item.kind || recorded.parentId !== item.parentId) {
      errors.push(`Inventory drift for ${id}: expected heading "${item.heading}" at ${item.source}`);
    }
  }
  for (const [id, item] of actualById) {
    if (!expectedById.has(id)) errors.push(`Inventory drift: stale ${item.kind} heading "${item.heading}" (${item.source})`);
  }
  return errors;
}

function writeInventory(ledger, expected) {
  const document = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : {};
  const previous = new Map((document.sourceInventory ?? []).map((item) => [item.id, item]));
  document.sourceInventory = expected.map((item) => ({ ...previous.get(item.id), ...item }));
  writeFileSync(ledger, `${JSON.stringify(document, null, 2)}\n`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
let options;
if (isMain) {
  try {
    options = parseArguments(process.argv.slice(2));
    const sourceRoot = path.dirname(path.dirname(options.specRoot));
    const expected = scanOpenSpec(options.specRoot, sourceRoot);
    if (options.mode === "write") {
      writeInventory(options.ledger, expected);
      console.log(`Wrote ${expected.length} assurance inventory rows.`);
    } else {
      if (!existsSync(options.ledger)) throw new Error(`Missing assurance ledger: ${options.ledger}`);
      const document = JSON.parse(readFileSync(options.ledger, "utf8"));
      if (!Array.isArray(document.sourceInventory)) throw new Error("Malformed sourceInventory: expected an array");
      const errors = validateInventory(document.sourceInventory, expected, sourceRoot);
      if (errors.length > 0) throw new Error(errors.join("\n"));
      console.log(`Assurance inventory matches ${expected.length} OpenSpec headings.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
