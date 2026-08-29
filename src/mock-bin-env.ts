const MOCKS_VAR = "TYPE_A_BIN_MOCKS";

// The mock registry travels from mockBin to the Windows dispatch in
// this env var. mock-bin-runtime keeps its own copy of the name — it
// runs inside child processes, as a compiled module or a type-stripped
// source file, and cannot import library code — so the two must stay
// in sync.

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
 * With the Windows trampoline launcher, mocks already run inside a real
 * Node executable, so ordinary helper spawns escape interception on
 * their own; the copy remains for children spawned through a legacy
 * hard-link shim, and for trampoline spawns that must reach the real
 * binary instead of the mock.
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
