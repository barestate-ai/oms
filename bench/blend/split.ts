import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXED_SEED = 'blend-solana-v1-2026-11-20';
export type Entry = { id: string; sha256: string };
export type Manifest = { seed: string; dev: Entry[]; heldout: Entry[] };

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

function randomIndex(seed: string) {
  let counter = 0;
  return (upper: number) => {
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % upper);
    for (;;) {
      const number = createHash('sha256').update(`${seed}:${counter++}`).digest().readUInt32LE(0);
      if (number < limit) return number % upper;
    }
  };
}

export async function createManifest(directory: string, seed = FIXED_SEED): Promise<Manifest> {
  if (!seed) throw new Error('Seed must not be empty');
  const groups: Entry[][] = [[], [], []];
  const directories = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of directories) {
    if (!entry.isDirectory()) throw new Error(`Expected task directory: ${entry.name}`);
    const path = join(directory, entry.name);
    const meta = JSON.parse(await readFile(join(path, 'meta.json'), 'utf8'));
    if (meta.id !== entry.name || ![1, 2, 3].includes(meta.difficulty)) throw new Error('Invalid task metadata');
    groups[meta.difficulty - 1].push({ id: meta.id, sha256: await hashTaskDirectory(path) });
  }
  if (groups.some((group, index) => group.length !== [10, 12, 10][index])) {
    throw new Error('Split requires all 32 unsealed tasks in strata 10/12/10');
  }
  const manifest: Manifest = { seed, dev: [], heldout: [] };
  for (let difficulty = 1; difficulty <= 3; difficulty++) {
    const group = groups[difficulty - 1];
    const index = randomIndex(`${seed}:difficulty:${difficulty}`);
    for (let i = group.length - 1; i > 0; i--) {
      const j = index(i + 1);
      [group[i], group[j]] = [group[j], group[i]];
    }
    manifest.dev.push(...group.slice(0, group.length / 2));
    manifest.heldout.push(...group.slice(group.length / 2));
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = dirname(fileURLToPath(import.meta.url));
  const [, , seed = FIXED_SEED, tasks = join(root, 'tasks'), output = join(root, 'manifest.json'), ...extra] =
    process.argv;
  if (extra.length) throw new Error('Usage: node split.ts [seed] [tasks-directory] [manifest-path]');
  const manifest = await createManifest(resolve(tasks), seed);
  await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Split seed ${seed}: ${manifest.dev.length} dev / ${manifest.heldout.length} held-out`);
}
