const MOCKS_VAR = "TYPE_A_BIN_MOCKS";

// The mock registry travels from mockBin to the preload in this env
// var. mock-bin-preload keeps its own copy of the name — it runs as a
// standalone script inside child processes and cannot import library
// code — so the two must stay in sync (mock-bin-windows imports the
// constant from here).

/**
 * Copies an environment without the mock registry.
 *
 * A child spawned from inside a mock inherits the registry, and on
 * Windows a spawn through the shim executable (`process.execPath` *is*
 * the shim there) would be redirected back into a mock. Passing
 * `withoutMocks(process.env)` as the child's `env` leaves the preload
 * loaded but inert: it finds no registry and lets the child run
 * untouched.
 *
 * @param env - The environment to copy, usually `process.env`
 * @returns A copy of `env` with the mock registry variable removed
 */
const withoutMocks = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const childEnv = { ...env };
  delete childEnv[MOCKS_VAR];
  return childEnv;
};

export { MOCKS_VAR, withoutMocks };
