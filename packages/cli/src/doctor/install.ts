import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { privateDirectory } from '@oms/engine';

const run = promisify(execFile);

export interface SurfpoolArchive {
  url: string;
  sha256: string;
}

/** Download a Surfpool archive, refuse it unless its SHA-256 matches, and put the `surfpool` executable at `target`. */
export async function installSurfpool(
  archive: SurfpoolArchive,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let bytes: Buffer;
  try {
    const response = await fetchImpl(archive.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`Could not download ${archive.url}: ${error instanceof Error ? error.message : 'request failed'}`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== archive.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${archive.url}: expected ${archive.sha256}, got ${actual}. Nothing was installed.`,
    );
  }
  const work = mkdtempSync(join(tmpdir(), 'oms-surfpool-'));
  try {
    writeFileSync(join(work, 'surfpool.tar.gz'), bytes);
    await run('tar', ['-xzf', 'surfpool.tar.gz'], { cwd: work }).catch(() => {
      throw new Error('Could not extract the archive (is `tar` installed?)');
    });
    const found = findFile(work, 'surfpool');
    if (!found) throw new Error('The archive contains no `surfpool` executable');
    mkdirSync(dirname(target), { recursive: true });
    const stage = mkdtempSync(join(dirname(target), '.surfpool-install-'));
    try {
      const executable = join(stage, 'surfpool');
      copyFileSync(found, executable);
      chmodSync(executable, 0o755);
      renameSync(executable, target);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function findFile(directory: string, name: string): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(path, name);
      if (hit) return hit;
    } else if (entry.name === name && statSync(path).size > 0) return path;
  }
  return undefined;
}

/** Install the Surfpool build pinned in the runtime manifest for this platform at `target`. */
export async function installPinnedSurfpool(target: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const manifest = JSON.parse(readFileSync(new URL('../../../engine/runtime-manifest.json', import.meta.url), 'utf8'));
  const archive: SurfpoolArchive | undefined = manifest.surfpoolArchives[`${process.platform}-${process.arch}`];
  if (!archive)
    throw new Error(`No Surfpool ${manifest.surfpoolVersion} build for ${process.platform}-${process.arch}`);
  if (target === join(homedir(), '.oms', 'tools', `surfpool-${manifest.surfpoolVersion}`, 'surfpool'))
    privateDirectory(join(homedir(), '.oms'));
  await installSurfpool(archive, target, fetchImpl);
  return manifest.surfpoolVersion;
}
