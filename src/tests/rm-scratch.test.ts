import { accessSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { rmScratch } from "../rm-scratch.js";

const exists = (target: string): boolean => {
  try {
    accessSync(target);
    return true;
  } catch {
    return false;
  }
};

describe("rmScratch", () => {
  it("removes a directory tree", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rmscratch-"));
    await mkdir(path.join(dir, "nested", "deeper"), { recursive: true });
    await writeFile(path.join(dir, "nested", "deeper", "payload.txt"), "x");

    rmScratch(dir);

    expect(exists(dir)).toBe(false);
  });

  it("tolerates a path that does not exist", () => {
    const missing = path.join(tmpdir(), "rmscratch-definitely-missing");

    rmScratch(missing);

    expect(exists(missing)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "warns instead of throwing when removal fails",
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "rmscratch-ro-"));
      const guarded = path.join(parent, "guarded");
      await mkdir(guarded);
      await writeFile(path.join(guarded, "payload.txt"), "x");
      // A read-only parent makes removing the tree root fail with
      // EACCES, which rmSync does not retry, so the failure is fast.
      await chmod(parent, 0o500);
      const warn = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      try {
        rmScratch(guarded);
        // The directory surviving proves the removal really failed.
        expect(exists(guarded)).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(guarded));
      } finally {
        await chmod(parent, 0o700);
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
