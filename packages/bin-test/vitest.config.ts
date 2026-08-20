import { defineConfig } from "vitest/config";

const config = defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    // Each mocked spawn is a node.exe shim that boots tsx (plus its
    // esbuild service) before the mock script runs; a test issuing
    // several spawns needs more than vitest's 5s default on Windows.
    testTimeout: 30000,
  },
});

export { config as default };
