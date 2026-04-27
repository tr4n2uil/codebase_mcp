import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * `scripts/ripper_definitions.rb` next to the package root (sibling to `dist/` in development).
 */
export function ripperDefinitionsScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ripper_definitions.rb');
}

export function hasRipperScriptOnDisk(): boolean {
  return existsSync(ripperDefinitionsScriptPath());
}
