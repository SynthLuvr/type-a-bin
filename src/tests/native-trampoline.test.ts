import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the packaging contract of the Windows trampoline launcher:
// the checked-in artifacts exist for both supported architectures, the
// recorded SHA-256 checksums match them, and a dist build carries the
// same bytes into dist/native. CI additionally rebuilds from source on
// Windows and compares against these checksums (see ci.yml).
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const artifacts = ["x64", "arm64"].map((arch) => ({
  arch,
  source: path.join(
    root,
    "native",
    "bin",
    "win32",
    arch,
    "type-a-bin-trampoline.exe",
  ),
  dist: path.join(
    root,
    "dist",
    "native",
    "win32",
    arch,
    "type-a-bin-trampoline.exe",
  ),
}));

const sha256 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

describe("native trampoline artifacts", () => {
  it("ships a launcher for every supported Windows architecture", () => {
    for (const { arch, source } of artifacts)
      expect(existsSync(source), `${arch} launcher at ${source}`).toBe(true);
  });

  it("records checksums that match the checked-in launchers", () => {
    const checksumFile = path.join(root, "native", "checksums.txt");
    const recorded = new Map(
      readFileSync(checksumFile, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line !== "")
        .map((line) => {
          const [digest, file] = line.split(/\s+/);
          return [path.join(root, file), digest] as const;
        }),
    );

    for (const { source } of artifacts) {
      expect(recorded.get(source)).toBeDefined();
      expect(sha256(source)).toBe(recorded.get(source));
    }
  });

  it("copies the launchers into dist/native during build:lib", () => {
    const distBuilt = existsSync(path.join(root, "dist", "mock-bin.js"));
    if (!distBuilt) return; // running from source without a build

    for (const { source, dist } of artifacts) {
      expect(existsSync(dist), `${dist} after build`).toBe(true);
      expect(sha256(dist)).toBe(sha256(source));
    }
  });
});
