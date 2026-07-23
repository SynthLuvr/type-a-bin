import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mockBin } from "type-a-bin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hoard } from "../dragon.js";

interface HoardRow {
  dragon: string;
  hoarded_at: string;
  id: number;
  quantity: number;
  treasure: string;
}

/**
 * The mocked `dragon` binary keeps a persistent ledger of every treasure it
 * hoards inside a SQLite database.
 *
 * mockBin writes the mock to an extensionless temp file, which Node parses as
 * CommonJS, so the script uses `require` together with the built-in
 * `node:sqlite` module — no native add-ons or extra dependencies needed. The
 * database path and the dragon's name are passed in via the environment so the
 * test controls where state lands and can read it straight back.
 */
const hoardScript = `
const { DatabaseSync } = require("node:sqlite");

const subcommand = process.argv[2];

if (subcommand !== "hoard") {
  console.log("dragon has no interest in '" + (subcommand || "") + "'");
  process.exit(0);
}

const dbPath = process.env.DRAGON_DB;
if (!dbPath) {
  console.error("dragon: DRAGON_DB path is not set");
  process.exit(1);
}

const dragon = process.env.DRAGON_NAME || "Smaug";
const treasure = "gold coins";
const quantity = 999;

const db = new DatabaseSync(dbPath);
db.exec(
  "CREATE TABLE IF NOT EXISTS hoard_ledger (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "dragon TEXT NOT NULL, " +
    "treasure TEXT NOT NULL, " +
    "quantity INTEGER NOT NULL, " +
    "hoarded_at TEXT NOT NULL)",
);
db.prepare(
  "INSERT INTO hoard_ledger (dragon, treasure, quantity, hoarded_at) " +
    "VALUES (?, ?, ?, ?)",
).run(dragon, treasure, quantity, new Date().toISOString());
console.log(
  "The dragon " + dragon + " hoards " + quantity + " " + treasure + ".",
);
db.close();
`;

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

  it("records a hoarded treasure in the SQLite ledger", async () => {
    cleanup = await mockBin("dragon", "node", hoardScript);

    const reply = hoard();

    expect(reply).toBe("The dragon Pyrho hoards 999 gold coins.");

    const db = new DatabaseSync(dbPath);
    const rows = db
      .prepare("SELECT * FROM hoard_ledger ORDER BY id")
      .all() as unknown as HoardRow[];
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dragon: "Pyrho",
      quantity: 999,
      treasure: "gold coins",
    });
    expect(rows[0].hoarded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accumulates state across multiple hoards", async () => {
    cleanup = await mockBin("dragon", "node", hoardScript);

    hoard();
    hoard();
    hoard();

    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM hoard_ledger")
      .get() as unknown as { n: number };
    db.close();

    expect(row.n).toBe(3);
  });
});
