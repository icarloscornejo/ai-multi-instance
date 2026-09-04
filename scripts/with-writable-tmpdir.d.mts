// Hand-written types for the plain-JS wrapper script, so server/src/tmpdir.test.ts can import
// its pure helpers under `tsc --noEmit` without an implicit-any error.
export function resolveWritableTmpdir(env?: NodeJS.ProcessEnv): string | undefined;
export function resolveTmuxTmpdir(env?: NodeJS.ProcessEnv): string | undefined;
