import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function hashTaskDirectory(directory: string): Promise<string> {
  const paths: string[] = [];
  async function visit(relative: string) {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Task contains symlink: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`Task contains nonregular file: ${path}`);
    }
  }
  await visit('');
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const bytes = await readFile(join(directory, path));
    hash.update(path, 'utf8').update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}
