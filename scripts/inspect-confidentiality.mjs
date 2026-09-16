#!/usr/bin/env node

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const surfaceOptions = [
  ["database-dump", "--database-dump"],
  ["ciphertext-files", "--ciphertext-files"],
  ["http", "--http"],
  ["websocket", "--websocket"],
  ["logs", "--logs"],
  ["browser-storage", "--browser-storage"]
];

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !value)
      throw new Error(`Invalid argument near ${option ?? "end"}`);
    values.set(option, path.resolve(value));
  }
  for (const option of [
    "--canary-file",
    "--report",
    ...surfaceOptions.map(([, flag]) => flag)
  ]) {
    if (!values.has(option)) throw new Error(`Missing required option: ${option}`);
  }
  return values;
}

function filesAt(target) {
  if (!existsSync(target)) return [];
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => filesAt(path.join(target, entry.name)));
}

async function containsAny(file, needles) {
  const longest = Math.max(...needles.map((needle) => needle.length));
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const bytes = Buffer.concat([tail, chunk]);
    if (needles.some((needle) => bytes.includes(needle))) return true;
    tail = bytes.subarray(Math.max(0, bytes.length - longest + 1));
  }
  return false;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const needles = readFileSync(options.get("--canary-file"), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((value) => Buffer.from(value));
  if (needles.length === 0) throw new Error("Canary file is empty");

  const inspected = [];
  const findings = [];
  for (const [surface, option] of surfaceOptions) {
    inspected.push(surface);
    const files = filesAt(options.get(option));
    if (files.length === 0) throw new Error(`Inspection target is missing: ${surface}`);
    let detected = false;
    for (const file of files) {
      if (await containsAny(file, needles)) {
        detected = true;
        break;
      }
    }
    if (detected) findings.push({ surface, location: "protected value detected" });
  }

  const report = { result: findings.length === 0 ? "pass" : "fail", inspected, findings };
  const reportPath = options.get("--report");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = findings.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
