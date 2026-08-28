import { vitestPreset } from "ts-canon/presets/vitest";

// Each mocked spawn is a node.exe shim that boots tsx (plus its
// esbuild service) before the mock script runs; a test issuing
// several spawns needs more than vitest's 5s default on Windows.
const config = vitestPreset({ testTimeout: 30000 });

export { config as default };
