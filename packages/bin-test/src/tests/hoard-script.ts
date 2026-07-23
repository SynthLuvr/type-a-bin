import { DatabaseSync } from "node:sqlite";

const subcommand = process.argv[2];

if (subcommand !== "hoard") {
  console.log("dragon has no interest in '" + (subcommand ?? "") + "'");
  process.exit(0);
}

const dbPath = process.env.DRAGON_DB;
if (!dbPath) {
  console.error("dragon: DRAGON_DB path is not set");
  process.exit(1);
}

const dragon = process.env.DRAGON_NAME ?? "Smaug";
const treasure = "gold coins";
const quantity = 999;

const db = new DatabaseSync(dbPath);
db.exec(
  "CREATE TABLE IF NOT EXISTS hoard_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, dragon TEXT NOT NULL, treasure TEXT NOT NULL, quantity INTEGER NOT NULL, hoarded_at TEXT NOT NULL)",
);
db.prepare(
  "INSERT INTO hoard_ledger (dragon, treasure, quantity, hoarded_at) VALUES (?, ?, ?, ?)",
).run(dragon, treasure, quantity, new Date().toISOString());
console.log(
  "The dragon " + dragon + " hoards " + quantity + " " + treasure + ".",
);
db.close();
