import { defineConfig } from "vitest/config";

const config = defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    passWithNoTests: true,
  },
});

export { config as default };
