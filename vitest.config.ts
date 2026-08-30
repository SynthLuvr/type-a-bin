import { vitestPreset } from "ts-canon/presets/vitest";

// The library splits its implementation by platform: mock-bin.ts writes
// POSIX shims, mock-bin-windows.ts is the Windows twin, and the active
// one is chosen at runtime — each OS can only execute its own half.
// mock-bin-runtime.ts, mock-bin-preload.ts and
// mock-bin-behaviour-runtime.ts run inside spawned child processes
// (behind the trampoline bootstrap, the NODE_OPTIONS preload, or the
// mocked binary itself), so in-process collection alone cannot see
// them: the custom provider below merges the raw V8 profiles those
// children write once `pnpm test:lib` opts in (see
// src/subprocess-coverage/merge.ts), and the gate covers them like any
// other module. src/index.ts and src/subprocess-coverage/index.ts stay
// excluded as pure re-export barrels, exercised end-to-end by the
// bin-test workspace package; provider.ts runs only in the vitest main
// process (that is what customProviderModule loads), which no
// collector in the tree can see; and the inactive platform twin can
// never execute on the OS running the gate.
const inactiveTwin =
  process.platform === "win32" ? "src/mock-bin.ts" : "src/mock-bin-windows.ts";

// Propagation is opted into through the environment (set by
// scripts/vitest-coverage.mts behind `pnpm test:lib`). Without it, the
// child-run modules are excluded exactly as they always were — their
// coverage arrives only through the merged child profiles, so a run
// that did not opt in would gate them on zeros.
const propagationOn =
  process.env.TYPE_A_BIN_SUBPROCESS_COVERAGE_DIR !== undefined;

const config = vitestPreset({
  // The override replaces the preset's coverage section, so spell out
  // the whole thing: the preset defaults plus this repo's provider and
  // excludes.
  coverage: {
    // Extends the stock v8 provider: when the runner names a raw
    // profile directory (scripts/vitest-coverage.mts behind
    // `pnpm test:lib` does), it also merges the coverage written by
    // the Node children the suite spawns. Without the opt-in env var
    // it reports exactly what the stock v8 provider would.
    provider: "custom",
    customProviderModule: "./src/subprocess-coverage/provider.ts",
    include: ["src/**/*.ts"],
    exclude: [
      "src/tests/**",
      "src/index.ts",
      "src/subprocess-coverage/index.ts",
      "src/subprocess-coverage/provider.ts",
      inactiveTwin,
      ...(propagationOn
        ? []
        : [
            "src/mock-bin-behaviour-runtime.ts",
            "src/mock-bin-preload.ts",
            "src/mock-bin-runtime.ts",
          ]),
    ],
    // Threshold groups, not a global: a global floor aggregates every
    // included file, and the child-run modules would drag it below 80
    // by existing (they could not be measured at all before). The
    // in-process pool keeps the 80% floors — the brace keeps the gate
    // platform-symmetric, matching whichever twin this OS executes —
    // and the three child-run modules carry their own floors instead:
    // raw NODE_V8_COVERAGE profiles are best-effort (functions a child
    // never calls are never even compiled, so they cannot credit),
    // children that are killed rather than exit never flush a profile,
    // and mock-bin-runtime.ts also keeps Windows-only helpers that
    // cannot execute on a Linux gate (and vice versa). The floors sit
    // below the observed numbers with headroom; the point is that
    // these files are now measured at all, so regressions in what
    // children execute show up.
    thresholds: {
      "src/{mock-bin,mock-bin-windows,mock-bin-behaviour,mock-bin-env,mock-bin-tsx,rm-scratch}.ts":
        { lines: 80, functions: 80, statements: 80, branches: 80 },
      "src/subprocess-coverage/merge.ts": {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
      "src/mock-bin-behaviour-runtime.ts": { statements: 75, lines: 90 },
      "src/mock-bin-preload.ts": { statements: 55, lines: 80 },
      "src/mock-bin-runtime.ts": { statements: 60, lines: 72 },
    },
  },
});

export { config as default };
