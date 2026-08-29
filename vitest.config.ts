import { vitestPreset } from "ts-canon/presets/vitest";

// The library splits its implementation by platform: mock-bin.ts writes
// POSIX shims, mock-bin-windows.ts is the Windows twin, and the active
// one is chosen at runtime — each OS can only execute its own half.
// mock-bin-preload.ts runs inside spawned child processes (via
// NODE_OPTIONS), and mock-bin-behaviour-runtime.ts inside the mocked
// binary itself — both invisible to this process's v8 coverage.
// index.ts is a
// pure re-export barrel, exercised end-to-end by the bin-test workspace
// package. None of those can meet the gate; the rest must.
const inactiveTwin =
  process.platform === "win32" ? "src/mock-bin.ts" : "src/mock-bin-windows.ts";

const config = vitestPreset({
  // The override replaces the preset's coverage section, so spell out
  // the whole thing: the preset defaults plus this repo's excludes.
  coverage: {
    provider: "v8",
    include: ["src/**/*.ts"],
    exclude: [
      "src/tests/**",
      "src/index.ts",
      "src/mock-bin-behaviour-runtime.ts",
      "src/mock-bin-preload.ts",
      inactiveTwin,
    ],
    thresholds: {
      lines: 80,
      functions: 80,
      statements: 80,
      branches: 80,
    },
  },
});

export { config as default };
