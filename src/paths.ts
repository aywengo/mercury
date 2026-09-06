import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The directory npm created for this package: the nearest ancestor holding this package's manifest.
 *
 * Data files (`.agents/skills`, `ui/`, `*-agents/`) are published at the package root, but the code
 * that reads them now lives at two different depths: `src/` in a checkout and during development, and
 * `dist/src/` once compiled for the published `bin`. A path written as `resolve(import.meta.dirname,
 * '..', 'ui')` is correct at one depth and silently wrong at the other -- and "silently wrong" is the
 * whole problem, because a missing skills directory or a 404 dashboard looks like a configuration
 * mistake rather than a packaging bug.
 *
 * Walking up to the manifest instead of counting levels makes the answer independent of depth. The
 * manifest is matched by name on purpose: reaching a `package.json` that belongs to a *consumer* would
 * mean the walk escaped the package, and returning that directory would resolve every data path to a
 * plausible-looking place full of nothing. Running off the filesystem root therefore throws.
 */
export function packageRoot(): string {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 12; depth++) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      let name: unknown;
      try {
        name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
      } catch {
        // An unreadable manifest above us is not this package's manifest; keep walking rather than
        // guessing a root from a file we could not parse.
        name = undefined;
      }
      if (name === PACKAGE_NAME) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `cannot locate the ${PACKAGE_NAME} package root above ${import.meta.dirname}; ` +
      'data directories (skills, ui, agent registries) are resolved relative to it',
  );
}

/** The published name. Kept next to the walk so a rename fails loudly instead of resolving elsewhere. */
const PACKAGE_NAME = '@aywengo/mercury';

/** A published data directory, resolved against the package root rather than the module's own depth. */
export function dataPath(...segments: string[]): string {
  return resolve(packageRoot(), ...segments);
}
