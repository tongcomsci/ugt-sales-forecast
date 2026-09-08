import { readFileSync } from 'node:fs';

/**
 * Read a source file with line endings normalised to LF.
 *
 * The repository is checked out with CRLF on Windows, so checks that locate a
 * function body by searching for "\n}" find nothing unless the content is
 * normalised first.
 */
export function readSource(path) {
  return readFileSync(path, 'utf8').split('\r\n').join('\n');
}
