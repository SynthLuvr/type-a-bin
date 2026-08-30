// Copies the plain-JS observer hook into dist so the published
// package can point spawned children at it through the
// `type-a-bin/subprocess-coverage/coverage-hook.mjs` subpath export.
// Runs as part of build:lib — never compiles anything, keeping
// installs deterministic and free of toolchain prerequisites.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(
  root,
  "src",
  "subprocess-coverage",
  "coverage-hook.mjs",
);
const target = path.join(
  root,
  "dist",
  "subprocess-coverage",
  "coverage-hook.mjs",
);

mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(
  "copied coverage hook to dist/subprocess-coverage/coverage-hook.mjs",
);
