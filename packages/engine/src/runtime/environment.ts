import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { requirePinnedImage } from '@oms/sandbox';
import { isBackendName, type BackendName } from './execution-backend.ts';
import type { HarnessEnvironment } from './session.ts';

interface RuntimeManifest {
  schema: string;
  surfpoolVersion: string;
  nodeImages: Record<string, string>;
}

/** Host-owned build receipt, never project configuration. */
export function configuredToolchainImage(): string | undefined {
  const receipt = new URL('../../../../.tmp/toolchain/image.json', import.meta.url);
  const image: unknown =
    process.env.OMS_TOOLCHAIN_IMAGE ||
    (existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8'))[process.arch] : undefined);
  if (image == null) return undefined;
  if (typeof image !== 'string') throw new Error('Installed OMS toolchain image must be a pinned image reference');
  requirePinnedImage(image, 'toolchain image');
  return image;
}

/** Installed host configuration, never project-discovered executable configuration. */
/** OMS_BENCH_AGENT_IMAGE (a local sha256 image id) runs the Solana Bench OMS cell's sandbox on the shared bench agent image. */
export function benchAgentImage(): string | undefined {
  const image = process.env.OMS_BENCH_AGENT_IMAGE;
  return image?.startsWith('sha256:') ? image : undefined;
}

export function defaultHarnessEnvironment(
  binary?: string,
  backend: BackendName = configuredBackend(),
  programs = false,
): HarnessEnvironment {
  // Program builds use the pinned toolchain image, so they always run in Docker.
  if (programs) backend = 'docker';
  const manifest = JSON.parse(
    readFileSync(new URL('../../runtime-manifest.json', import.meta.url), 'utf8'),
  ) as RuntimeManifest;
  if (manifest.schema !== 'oms.runtime/2' || manifest.surfpoolVersion !== '1.7.0')
    throw new Error('Installed OMS runtime manifest is invalid');
  const image = programs ? configuredToolchainImage() : (benchAgentImage() ?? manifest.nodeImages[process.arch]);
  if (programs && !image)
    throw new Error(
      'No local OMS toolchain image configured; run scripts/build-toolchain.sh or set OMS_TOOLCHAIN_IMAGE to an immutable image',
    );
  if (!image || !['darwin', 'linux'].includes(process.platform))
    throw new Error(
      `OMS runs on macOS and Linux (${process.platform}-${process.arch} is not supported). On Windows, install and run OMS inside WSL 2.`,
    );
  requirePinnedImage(image, 'approved runtime image');
  return {
    backend,
    binary: resolve(binary ?? defaultSurfpoolBinary(manifest.surfpoolVersion)),
    image,
    ...(programs ? { buildProfile: true } : {}),
    forwarderImage: manifest.nodeImages[process.arch]!,
    // The pinned Linux verifier can spawn the same trusted Surfpool as the dev grader.
    // OMS_BENCH_DEPENDENCIES: one read-only dependency set for every cell of the Solana Bench harness.
    ...(process.env.OMS_BENCH_DEPENDENCIES
      ? { dependencies: resolve(process.env.OMS_BENCH_DEPENDENCIES) }
      : backend === 'docker' && process.platform === 'linux' && process.arch === 'x64'
        ? { dependencies: fileURLToPath(new URL('../../../../', import.meta.url)) }
        : {}),
  };
}

/** A source checkout keeps its own copy; an installed package uses one per-user copy that survives upgrades and npx cache moves. */
function defaultSurfpoolBinary(version: string): string {
  const checkout = fileURLToPath(new URL('../../../../.tmp/tools/surfpool', import.meta.url));
  return existsSync(checkout) ? checkout : join(homedir(), '.oms', 'tools', `surfpool-${version}`, 'surfpool');
}

/** Trusted process setting, never read from repository configuration. */
export function configuredBackend(value = process.env.OMS_SANDBOX ?? 'host'): BackendName {
  if (!isBackendName(value)) throw new Error('OMS_SANDBOX / --sandbox must be host or docker');
  return value;
}
