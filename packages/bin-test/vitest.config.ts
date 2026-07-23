import { defineConfig } from "vitest/config";

const config = defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
  },
});

export { config as default };
