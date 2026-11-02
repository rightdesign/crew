/** Bundle entry for `/opt/crew/bin/intel-bridge` (CREW-2922); see `sandbox-intel-bridge.ts`. */
import { main } from './sandbox-intel-bridge.ts';

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`intel-bridge: ${(e as Error).message}\n`);
  process.exit(1);
});
