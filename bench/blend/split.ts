import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashTaskDirectory } from './tree.ts';
export { hashTaskDirectory } from './tree.ts';

export const FIXED_SEED = 'blend-solana-v1-2026-11-20';
export const HARD_SEED = 'blend-solana-hard-v1-2026-11-20';
export const EXPERT_SEED = 'blend-solana-expert-v1-2026-11-20';
export const HARD_THEMES = [
  'token2022-fee-hook',
  'v0-alt-signatures',
  'cpi-rollback-conservation',
  'anchor-borsh-layouts',
] as const;
export type Entry = { id: string; sha256: string };
export type Manifest = { seed: string; dev: Entry[]; heldout: Entry[] };

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

export async function createHardManifest(
  directory: string,
  seed = HARD_SEED,
): Promise<Manifest & { stratified_by: 'theme' }> {
  return createThemedManifest(directory, seed, 4);
}

export async function createExpertManifest(
  directory: string,
  seed = EXPERT_SEED,
): Promise<Manifest & { stratified_by: 'theme' }> {
  return createThemedManifest(directory, seed, 5);
}

async function createThemedManifest(
  directory: string,
  seed: string,
  difficulty: number,
): Promise<Manifest & { stratified_by: 'theme' }> {
  if (!seed) throw new Error('Seed must not be empty');
  const groups = new Map<string, Entry[]>(HARD_THEMES.map((theme) => [theme, []]));
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error('Expected task directory');
    const path = join(directory, entry.name),
      meta = JSON.parse(await readFile(join(path, 'meta.json'), 'utf8'));
    if (meta.id !== entry.name || meta.difficulty !== difficulty || !groups.has(meta.theme))
      throw new Error('Invalid hard-task metadata');
    groups.get(meta.theme)!.push({ id: meta.id, sha256: await hashTaskDirectory(path) });
  }
  if ([...groups.values()].some((group) => group.length !== 4))
    throw new Error('Hard split requires four tasks per theme');
  const manifest: Manifest & { stratified_by: 'theme' } = { seed, stratified_by: 'theme', dev: [], heldout: [] };
  for (const [theme, group] of groups) {
    const index = randomIndex(`${seed}:theme:${theme}`);
    for (let i = group.length - 1; i > 0; i--) {
      const j = index(i + 1);
      [group[i], group[j]] = [group[j], group[i]];
    }
    manifest.dev.push(...group.slice(0, 2));
    manifest.heldout.push(...group.slice(2));
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = dirname(fileURLToPath(import.meta.url));
  const [, , seed = FIXED_SEED, tasks = join(root, 'tasks'), output = join(root, 'manifest.json'), ...extra] =
    process.argv;
  if (extra.length) throw new Error('Usage: node split.ts [seed] [tasks-directory] [manifest-path]');
  const create = seed === EXPERT_SEED ? createExpertManifest : seed === HARD_SEED ? createHardManifest : createManifest;
  const manifest = await create(resolve(tasks), seed);
  await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Split seed ${seed}: ${manifest.dev.length} dev / ${manifest.heldout.length} held-out`);
}
