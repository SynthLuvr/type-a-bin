import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { mockBin } from "type-a-bin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hoard } from "../dragon.js";

const hoardRow = type({
  dragon: "string",
  hoarded_at: "string",
  id: "number",
  quantity: "number",
  treasure: "string",
});

type HoardRow = typeof hoardRow.infer;

// The mock runs \`node --import tsx\` against this script. Keeping it as a
// real .ts file means tsx transforms it (the mock binary itself is an
// extensionless temp file, which tsx cannot parse). The DB path and
// dragon name are passed through the environment.
const hoardScriptPath = fileURLToPath(
  new URL("./hoard-script.ts", import.meta.url),
);

describe("dragon hoard ledger (SQLite)", () => {
  let cleanup: (() => void) | undefined;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "dragon-ledger-"));
    dbPath = path.join(tempDir, "hoard.sqlite");
    process.env.DRAGON_DB = dbPath;
    process.env.DRAGON_NAME = "Pyrho";
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    delete process.env.DRAGON_DB;
    delete process.env.DRAGON_NAME;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const readRows = (sql: string): HoardRow[] => {
    const db = new DatabaseSync(dbPath);
    const rows = hoardRow.array().assert(db.prepare(sql).all());
    db.close();
    return rows;
  };

  it("records a hoarded treasure in the SQLite ledger", async () => {
    cleanup = await mockBin("dragon", "node --import tsx", {
      file: hoardScriptPath,
    });

    expect(hoard()).toBe("The dragon Pyrho hoards 999 gold coins.");

    const rows = readRows("SELECT * FROM hoard_ledger ORDER BY id");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dragon: "Pyrho",
      quantity: 999,
      treasure: "gold coins",
    });
    expect(rows[0].hoarded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accumulates state across multiple hoards", async () => {
    cleanup = await mockBin("dragon", "node --import tsx", {
      file: hoardScriptPath,
    });

    hoard();
    hoard();
    hoard();

    expect(readRows("SELECT * FROM hoard_ledger")).toHaveLength(3);
  });
});
