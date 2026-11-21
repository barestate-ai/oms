import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { dockerEnv, type HostRun } from './host.ts';

export type ComposePlan = { ok: true; text: string; fingerprint: string } | { ok: false; reason: string };

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const word = (value: unknown, max = 120): string =>
  String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, max);
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const expandHome = (path: string): string =>
  path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? resolve(homedir(), path.slice(2)) : path;
const remoteRef = (value: string): boolean =>
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || /^[\w.-]+@[\w.-]+:/.test(value);

/**
 * What `compose up` would start from the compose files in this folder, read before the person is asked. The agent can
 * write those files itself, and compose runs on the host, so a file can ask for the host's own folders (`/:/host`), a
 * privileged container, the host's namespaces or the Docker socket. Those are refused; everything else is listed so the
 * approval says what will run. Environment variables are named, never shown: they can hold interpolated secrets.
 */
export async function planCompose(
  run: HostRun,
  folder: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ComposePlan> {
  const result = await run('docker', ['compose', 'config', '--format', 'json'], {
    cwd: folder,
    timeoutMs: 20_000,
    signal,
    env: dockerEnv(env),
  });
  if (result.error === 'missing') return { ok: false, reason: 'Docker is not installed.' };
  if (result.code !== 0) {
    const why = word(result.stderr.split('\n').find((line) => line.trim()) ?? 'no compose file found here', 160);
    return { ok: false, reason: `Docker could not read the compose file: ${why}` };
  }
  let config: unknown;
  try {
    config = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: 'Docker could not read the compose file: its answer was not JSON.' };
  }
  const file = isRecord(config) ? config : {};
  const services = isRecord(file.services) ? file.services : {};
  const root = real(folder);
  const inside = (path: string) => {
    const target = real(resolve(folder, expandHome(path)));
    return target === root || target.startsWith(root + sep);
  };
  const problems: string[] = [];
  const lines: string[] = [];
  for (const kind of ['secrets', 'configs'] as const) {
    const entries = isRecord(file[kind]) ? file[kind] : {};
    for (const [name, entry] of Object.entries(entries)) {
      if (!isRecord(entry) || typeof entry.file !== 'string' || !entry.file) continue;
      if (!inside(entry.file))
        problems.push(
          `${kind === 'secrets' ? 'secret' : 'config'} ${word(name, 40)} reads ${word(entry.file, 160)}, outside this folder`,
        );
    }
  }
  const named = isRecord(file.volumes) ? file.volumes : {};
  for (const [name, entry] of Object.entries(named)) {
    if (!isRecord(entry)) continue;
    const driver = typeof entry.driver === 'string' ? entry.driver : '';
    if (driver && driver !== 'local') problems.push(`volume ${word(name, 40)} uses the ${word(driver, 40)} driver`);
    const device = isRecord(entry.driver_opts) ? entry.driver_opts.device : undefined;
    if (typeof device === 'string' && device && !inside(device))
      problems.push(`volume ${word(name, 40)} mounts ${word(device, 160)}, outside this folder`);
  }
  const buildSpec = (build: unknown): { context: string; spec: Json } => {
    const spec = isRecord(build) ? build : {};
    const context =
      typeof spec.context === 'string' && spec.context ? spec.context : typeof build === 'string' ? build : '';
    return { context, spec };
  };
  const buildText = (build: unknown): string => {
    if (!build) return 'no image';
    const { context } = buildSpec(build);
    if (!context) return 'built from this folder';
    if (remoteRef(context)) return `built from ${word(context)}`;
    const target = real(resolve(folder, expandHome(context)));
    if (target === root) return 'built from this folder';
    return `built from ./${relative(root, target).split(sep).join('/')}`;
  };
  for (const [name, raw] of Object.entries(services)) {
    if (!isRecord(raw)) continue;
    const here = `${word(name, 40)}`;
    const parts: string[] = [];
    parts.push(raw.image ? `image ${word(raw.image)}` : buildText(raw.build));
    const ports = list(raw.ports)
      .map((port) => (isRecord(port) ? `${word(port.published ?? '')}→${word(port.target ?? '')}` : word(port)))
      .filter(Boolean);
    if (ports.length) parts.push(`ports ${ports.join(', ')}`);
    const mounts: string[] = [];
    for (const volume of list(raw.volumes)) {
      if (!isRecord(volume)) continue;
      const type = word(volume.type);
      const source = word(volume.source, 160);
      const target = word(volume.target, 120);
      if (type === 'bind') {
        if (/docker\.sock/.test(source) || /docker\.sock/.test(real(source)))
          problems.push(`${here} mounts the Docker socket`);
        else if (!inside(source)) problems.push(`${here} mounts ${source}, outside this folder`);
        mounts.push(`${source} → ${target}`);
      } else mounts.push(`${type || 'volume'} ${source} → ${target}`);
    }
    if (mounts.length) parts.push(`mounts ${mounts.join('; ')}`);
    const names = isRecord(raw.environment) ? Object.keys(raw.environment) : [];
    if (names.length)
      parts.push(`env ${names.slice(0, 12).join(', ')}${names.length > 12 ? ` +${names.length - 12}` : ''}`);
    if (raw.privileged === true) problems.push(`${here} is privileged`);
    for (const key of ['network_mode', 'pid', 'ipc', 'userns_mode', 'uts', 'cgroup'])
      if (raw[key] === 'host') problems.push(`${here} shares the host's ${key.replace('_mode', '')}`);
    if (list(raw.devices).length) problems.push(`${here} takes host devices`);
    if (
      list(raw.cap_add).some((cap) =>
        /^(ALL|SYS_ADMIN|SYS_MODULE|SYS_PTRACE|DAC_READ_SEARCH|SYS_RAWIO|NET_ADMIN)$/i.test(String(cap)),
      )
    )
      problems.push(`${here} adds powerful capabilities`);
    if (list(raw.volumes_from).length) problems.push(`${here} takes volumes from another container`);
    if (list(raw.security_opt).some((option) => /unconfined/i.test(String(option))))
      problems.push(`${here} turns off a security profile`);
    if (raw.build) {
      const { context, spec } = buildSpec(raw.build);
      const remote = context !== '' && remoteRef(context);
      if (context && !remote && !inside(context))
        problems.push(`${here} builds from ${word(context, 160)}, outside this folder`);
      if (!remote) {
        const dockerfile = spec.dockerfile;
        if (
          typeof dockerfile === 'string' &&
          dockerfile &&
          !inside(resolve(folder, expandHome(context || '.'), expandHome(dockerfile)))
        )
          problems.push(`${here} builds with dockerfile ${word(dockerfile, 160)}, outside this folder`);
      }
      for (const secret of list(spec.secrets)) {
        if (!isRecord(secret)) continue;
        const source = secret.source;
        if (typeof source === 'string' && source && !inside(source))
          problems.push(`${here} build reads secret ${word(source, 160)}, outside this folder`);
      }
      for (const entry of list(spec.ssh)) {
        const value =
          typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.source === 'string' ? entry.source : '';
        const path = value.includes('=') ? value.slice(value.indexOf('=') + 1) : value;
        const looksLikePath = path.includes('/') || path.includes('\\') || path.startsWith('.');
        if (path && path !== 'default' && !remoteRef(path) && looksLikePath && !inside(path))
          problems.push(`${here} build uses ssh key ${word(path, 160)}, outside this folder`);
      }
      const extra = spec.additional_contexts;
      if (isRecord(extra))
        for (const [key, value] of Object.entries(extra)) {
          if (typeof value !== 'string' || !value || remoteRef(value) || inside(value)) continue;
          problems.push(`${here} build context ${word(key, 40)} reads ${word(value, 160)}, outside this folder`);
        }
    }
    lines.push(`${here}: ${parts.join(' · ')}`);
  }
  if (problems.length)
    return {
      ok: false,
      reason: `The compose file here asks for something the Docker connector will not start: ${[...new Set(problems)].slice(0, 4).join('; ')}. Start it yourself if you mean it.`,
    };
  if (!lines.length) return { ok: false, reason: 'The compose file here defines no services.' };
  return {
    ok: true,
    text: `Starts from the compose file in this folder:\n${lines.join('\n')}`,
    fingerprint: createHash('sha256').update(result.stdout).digest('hex'),
  };
}
