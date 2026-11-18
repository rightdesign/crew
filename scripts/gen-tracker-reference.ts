// Regenerates docs/WORK_TRACKER.md from the work tracker interface definition (CREW-3579).
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReferencePage } from '../src/tracker-interface.ts';

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'WORK_TRACKER.md'), renderReferencePage());
