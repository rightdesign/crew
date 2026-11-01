import { defineConfig } from 'tsup';

// CREW-2908: esbuild reports a repeated `case` label in one switch as a
// warning, and a warning does not fail the build. Three `case 'sandbox'`
// clauses merged into one `switch` that way and two of them were silently
// unreachable. Promote it to an error so `make validate` and the release gate
// stop on it. Other esbuild warnings are left as they are.
export default defineConfig({
  esbuildOptions(options) {
    options.logOverride = { ...options.logOverride, 'duplicate-case': 'error' };
  },
});
