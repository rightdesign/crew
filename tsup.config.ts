import { readFileSync } from 'node:fs';
import { build, defineConfig } from 'tsup';

// CREW-3236: the version this bundle was built from, so a checkout pulled but not
// rebuilt can say so (src/bundle-staleness.ts).
const builtVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

// CREW-2908: esbuild reports a repeated `case` label in one switch as a
// warning, and a warning does not fail the build. Three `case 'sandbox'`
// clauses merged into one `switch` that way and two of them were silently
// unreachable. Promote it to an error so `make validate` and the release gate
// stop on it. Other esbuild warnings are left as they are.
export default defineConfig({
  esbuildOptions(options) {
    options.define = { ...options.define, __CREW_BUILT_VERSION__: JSON.stringify(builtVersion) };
    options.logOverride = { ...options.logOverride, 'duplicate-case': 'error' };
  },
  // CREW-2922: the in-sandbox symbol bridge, one self-contained CommonJS file (the MCP SDK
  // bundled in) that the sandbox crew layer copies to /opt/crew/bin/intel-bridge and runs with
  // the image's node. Built here so the one `tsup src/cli.ts` command every build hook runs
  // produces it beside dist/cli.js. Extensionless CommonJS: node loads a file with no
  // extension and no package.json beside it as CJS.
  async onSuccess() {
    await build({
      config: false,
      entry: { 'sandbox-intel-bridge': 'src/sandbox-intel-bridge-main.ts' },
      format: ['cjs'], platform: 'node', target: 'node22', outDir: 'dist', clean: false, dts: false, splitting: false,
      noExternal: [/.*/],
      esbuildOptions(options) {
        options.logOverride = { ...options.logOverride, 'duplicate-case': 'error' };
      },
    });
  },
});
