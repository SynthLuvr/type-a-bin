// Copies the checked-in Windows trampoline launchers into dist/native
// so the published package carries them. Runs as part of build:lib —
// never compiles anything, keeping installs deterministic and free of
// toolchain prerequisites.

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "native", "bin", "win32");
const targetDir = path.join(root, "dist", "native", "win32");

const copyArch = (arch) => {
  mkdirSync(path.join(targetDir, arch), { recursive: true });
  copyFileSync(
    path.join(sourceDir, arch, "type-a-bin-trampoline.exe"),
    path.join(targetDir, arch, "type-a-bin-trampoline.exe"),
  );
};

for (const arch of ["x64", "arm64"]) copyArch(arch);
console.log("copied win32 trampolines to dist/native/win32/{x64,arm64}");
