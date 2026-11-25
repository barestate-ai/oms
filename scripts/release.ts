// The one place the release version is read, and the changelog lookup the release notes come from.
// Run: node scripts/release.ts version | node scripts/release.ts notes <version>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RELEASE = /^\d+\.\d+\.\d+$/;
const root = new URL('../', import.meta.url);

/** The release version is the `releaseVersion` field of the root package.json; the workspaces stay at 0.0.1. */
export function releaseVersion(manifest: { releaseVersion?: unknown }): string {
  const { releaseVersion: version } = manifest;
  if (typeof version !== 'string' || !RELEASE.test(version)) {
    throw new Error(`package.json releaseVersion must be a plain x.y.z release, got ${JSON.stringify(version)}`);
  }
  return version;
}

/** The body under `## <version>` up to the next `## ` heading. Throws when the section is missing or empty. */
export function changelogSection(changelog: string, version: string): string {
  if (!RELEASE.test(version)) throw new Error(`version must be a plain x.y.z release, got ${JSON.stringify(version)}`);
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section; add one before releasing`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
  if (!body) throw new Error(`The CHANGELOG.md section for ${version} is empty`);
  return body;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  try {
    const version = releaseVersion(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')));
    if (command === 'version') console.log(version);
    else if (command === 'notes')
      console.log(changelogSection(readFileSync(new URL('CHANGELOG.md', root), 'utf8'), argument ?? version));
    else throw new Error('usage: release.ts version | notes [version]');
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  }
}
