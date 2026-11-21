import { join } from 'node:path';
import { createMcpExtension, type ExtensionFactory, type McpExtensionOptions } from '@earendil-works/pi-coding-agent';
import { CATALOG, CONNECTOR_TOOLS, connectorSpec, type ConnectorSpec } from './catalog.ts';
import {
  effectiveAccess,
  readConnectorsConfig,
  writeConnectorsConfig,
  type Access,
  type ConnectorId,
  type ConnectorsConfig,
} from './config.ts';
import { detectAll, verifyAws, type Detection, type DetectDeps } from './detect.ts';
import { createConnectorExtension, type Approver, type ConnectorExtension } from './extension.ts';
import { hostRun, type HostRun } from './host.ts';
import { credentialsFile, mcpToolPrefix, McpCredentials, signInMcp } from './mcp.ts';
import { signInWithCli, type DeviceInfo, type SignInOutcome, type SpawnLike } from './signin.ts';
import { afterShown, LOGIN_TIP, remoteKind, shouldShowTip, tipLine, type RemoteKind } from './tips.ts';

export interface ConnectorsOptions {
  stateRoot: string;
  /** The chat folder: where programs run. */
  folder: string;
  env?: NodeJS.ProcessEnv;
  run?: HostRun;
  fetch?: typeof fetch;
  spawn?: SpawnLike;
}

/** One catalog entry as /connectors shows it. */
export interface ConnectorRow {
  spec: ConnectorSpec;
  enabled: boolean;
  /** What the agent has now: off unless the connector is on. */
  access: Access;
  /** Undefined until the first check finishes. */
  detection?: Detection;
}

/** A small status mark for the status row: one per connector that is on. */
export interface ConnectorChip {
  id: ConnectorId;
  /** Short name that fits a status row: gh, glab, linear, slack, docker, aws, rpc. */
  short: string;
  state: 'ok' | 'signin' | 'error' | 'unknown';
}
const SHORT: Record<ConnectorId, string> = {
  github: 'gh',
  gitlab: 'glab',
  'gitlab-remote': 'gitlab',
  linear: 'linear',
  slack: 'slack',
  docker: 'docker',
  aws: 'aws',
  'solana-rpc': 'rpc',
};

/** The marks for a status row, one per connector that is on; none when nothing is on or there are no connectors. */
export const statusChips = (connectors: Pick<Connectors, 'chips'> | undefined): ConnectorChip[] =>
  connectors?.chips() ?? [];

/** `gh ● linear ◐ docker ○`: ● working, ◐ needs a sign-in, ✕ not working, ○ not checked yet. */
export const chipsText = (chips: readonly ConnectorChip[]): string =>
  chips.map((chip) => `${chip.short} ${{ ok: '●', signin: '◐', error: '✕', unknown: '○' }[chip.state]}`).join(' ');

export const accessLabel = (spec: ConnectorSpec, access: Access): string =>
  access === 'off'
    ? 'off'
    : access === 'read'
      ? 'read only'
      : access === 'ask'
        ? spec.id === 'aws'
          ? 'asks every call'
          : 'asks before changes'
        : 'changes without asking';

export interface SignInUi {
  signal: AbortSignal;
  /** The page and one-time code to show. */
  show(info: DeviceInfo): void;
}
export interface SignInResult {
  outcome: SignInOutcome;
  /** One plain sentence for the pane. */
  message: string;
}

export interface Connectors {
  /** What to hand the engine's `extensions` option. */
  readonly extensions: ExtensionFactory[];
  /** What to hand its `extensionTools` option: the connector tools' names, and a pattern for each hosted server's tools. */
  readonly extensionTools: readonly string[];
  /** Plain sentences about a connectors file that could not be used, shown once. */
  readonly problems: readonly string[];
  readonly credentials: McpCredentials;
  readonly folder: string;
  readonly env: NodeJS.ProcessEnv;
  readonly run: HostRun;
  config(): ConnectorsConfig;
  access(id: ConnectorId): Access;
  option(id: ConnectorId, key: string): string | undefined;
  rows(): ConnectorRow[];
  anyEnabled(): boolean;
  /** A hosted connector that is on but was not on when OMS started: the agent reaches it after a restart. */
  needsRestart(id: ConnectorId): boolean;
  /** Turn a connector on or off. `restart` means it is saved but needs a new OMS to reach the agent. */
  setEnabled(id: ConnectorId, on: boolean): { saved: boolean; restart: boolean };
  /** Step to the next access level the connector offers. */
  cycleAccess(id: ConnectorId): { saved: boolean; access: Access };
  /** Check everything on this machine (no changes). Resolves when done; `onChange` fires as results arrive. */
  detect(): Promise<void>;
  /** The one network check: `aws sts get-caller-identity`. */
  verifyAws(): Promise<void>;
  signIn(id: ConnectorId, ui: SignInUi): Promise<SignInResult>;
  /** Remove a hosted connector's stored sign-in and turn it off. */
  signOut(id: ConnectorId): void;
  setApprover(approver: Approver | undefined): void;
  onChange(listener: () => void): () => void;
  chips(): ConnectorChip[];
  /** Count this launch for the tip's schedule. Best effort. */
  recordLaunch(): void;
  /** The tip line for a place it may show, recording that it showed; undefined when it should not. */
  tip(where: 'empty' | 'login', context: { chat: boolean; modelConfigured: boolean; rows: number }): string | undefined;
  /** Never show the tip again. */
  dismissTip(): void;
  /** Look at the folder's git remote so the tip can name the right service. Resolves quickly; never throws. */
  prime(): Promise<void>;
  remote(): RemoteKind | undefined;
  /** Hosts: apply the current levels to the agent's tools now. */
  sync(): void;
}

export function createConnectors(options: ConnectorsOptions): Connectors {
  const env = options.env ?? process.env;
  const run = options.run ?? hostRun;
  const loaded = readConnectorsConfig(options.stateRoot);
  let config = loaded.config;
  const writable = loaded.writable;
  const credentials = new McpCredentials(credentialsFile(options.stateRoot));
  const detections: Partial<Record<ConnectorId, Detection>> = {};
  const listeners = new Set<() => void>();
  let approver: Approver | undefined;
  let remote: RemoteKind | undefined;
  const hostedLoaded = CATALOG.some((spec) => spec.mcp && effectiveAccess(config.connectors[spec.id]) !== 'off');
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const access = (id: ConnectorId): Access => effectiveAccess(config.connectors[id]);
  /** Keep `next`. A file that could not be read is never overwritten: its changes then live only in this session. */
  const save = (next: ConnectorsConfig): boolean => {
    config = next;
    return writable ? writeConnectorsConfig(options.stateRoot, next) : false;
  };

  const extension: ConnectorExtension = createConnectorExtension({
    access,
    option: (id, key) => config.connectors[id]?.options?.[key],
    folder: options.folder,
    env,
    run,
    fetch: options.fetch,
    approver: () => approver,
    hostedLoaded,
  });
  const extensions: ExtensionFactory[] = [extension.factory];
  if (hostedLoaded) {
    extensions.push(
      createMcpExtension({
        // Only the connectors turned on here. Neither ~/.oms/agent/mcp.json nor a project's file is ever read.
        loadConfig: () => ({ servers: [], errors: [] }),
        credentials: credentials as unknown as NonNullable<McpExtensionOptions['credentials']>,
        logPath: join(options.stateRoot, 'connectors.log'),
        // Signing in happens in /connectors; the agent never opens a browser.
        openUrl: () => {},
        updateConfig: () => {},
      }),
    );
  }

  const deps = (): DetectDeps => ({
    run,
    env,
    cwd: options.folder,
    config,
    hasSignIn: (server, url) => credentials.has(server, url),
  });
  const entryOf = (spec: ConnectorSpec) => config.connectors[spec.id];

  const self: Connectors = {
    extensions,
    extensionTools: [
      ...Object.values(CONNECTOR_TOOLS),
      ...CATALOG.flatMap((spec) => (spec.mcp ? [`${mcpToolPrefix(spec.mcp.server)}*`] : [])),
    ],
    problems: loaded.problems,
    credentials,
    folder: options.folder,
    env,
    run,
    config: () => config,
    access,
    option: (id, key) => config.connectors[id]?.options?.[key],
    rows: () =>
      CATALOG.map((spec) => ({
        spec,
        enabled: !!entryOf(spec)?.enabled && entryOf(spec)!.access !== 'off',
        access: access(spec.id),
        detection: detections[spec.id],
      })),
    anyEnabled: () => CATALOG.some((spec) => access(spec.id) !== 'off'),
    needsRestart: (id) => !hostedLoaded && !!connectorSpec(id)?.mcp && access(id) !== 'off',
    setEnabled(id, on) {
      const spec = connectorSpec(id)!;
      const previous = config.connectors[id];
      const next: ConnectorsConfig = {
        ...config,
        connectors: {
          ...config.connectors,
          [id]: {
            ...previous,
            enabled: on,
            access: previous && previous.access !== 'off' ? previous.access : spec.defaultAccess,
          },
        },
      };
      const saved = save(next);
      extension.sync();
      changed();
      return { saved, restart: on && !!spec.mcp && !hostedLoaded };
    },
    cycleAccess(id) {
      const spec = connectorSpec(id)!;
      const current = config.connectors[id]?.access;
      const index = spec.levels.indexOf(current as never);
      const nextLevel = spec.levels[(index + 1) % spec.levels.length]!;
      const saved = save({
        ...config,
        connectors: {
          ...config.connectors,
          [id]: { enabled: config.connectors[id]?.enabled ?? false, ...config.connectors[id], access: nextLevel },
        },
      });
      extension.sync();
      changed();
      return { saved, access: nextLevel };
    },
    async detect() {
      Object.assign(detections, await detectAll(deps()));
      changed();
    },
    async verifyAws() {
      detections.aws = await verifyAws(deps());
      changed();
    },
    async signIn(id, ui) {
      const spec = connectorSpec(id)!;
      if (spec.kind === 'cli' && spec.program && spec.signIn) {
        const host = config.connectors[id]?.options?.host ?? spec.host;
        if (id === 'docker' || id === 'aws' || !host)
          return { outcome: 'manual', message: `Run ${spec.signIn} in your own terminal, then recheck with R.` };
        const outcome = await signInWithCli({
          program: spec.program,
          args: ['auth', 'login', '--hostname', host, '--web', ...(id === 'github' ? ['--git-protocol', 'https'] : [])],
          host,
          cwd: options.folder,
          signal: ui.signal,
          show: ui.show,
          spawn: options.spawn,
          env,
        });
        const message: Record<SignInOutcome, string> = {
          done: 'Signed in.',
          cancelled: 'Cancelled.',
          manual: `Run ${spec.signIn} in your own terminal, then recheck with R.`,
          missing: `${spec.program} is not installed. ${spec.install ?? ''}`.trim(),
          failed: `Sign-in did not finish. Run ${spec.signIn} in your own terminal, then recheck with R.`,
          timeout: 'Sign-in took too long. Try again.',
        };
        return { outcome, message: message[outcome] };
      }
      if (spec.kind === 'mcp-remote' && spec.mcp) {
        try {
          await signInMcp({
            name: spec.mcp.server,
            url: spec.mcp.url,
            credentials,
            signal: ui.signal,
            show: (url) => ui.show({ url: url.href }),
          });
          return { outcome: 'done', message: 'Signed in.' };
        } catch (error) {
          const cancelled = ui.signal.aborted;
          return {
            outcome: cancelled ? 'cancelled' : 'failed',
            message: cancelled
              ? 'Cancelled.'
              : `Sign-in did not finish${error instanceof Error && /safe https/.test(error.message) ? ': the service gave an unsafe address' : ''}. Try again.`,
          };
        }
      }
      return {
        outcome: 'manual',
        message: spec.signIn
          ? `Run ${spec.signIn} in your own terminal, then recheck with R.`
          : 'Nothing to sign in to.',
      };
    },
    signOut(id) {
      const spec = connectorSpec(id)!;
      if (spec.mcp) credentials.remove(spec.mcp.server, spec.mcp.url);
      self.setEnabled(id, false);
    },
    setApprover(next) {
      approver = next;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    chips: () =>
      CATALOG.filter((spec) => access(spec.id) !== 'off').map((spec) => {
        const state = detections[spec.id]?.state;
        return {
          id: spec.id,
          short: SHORT[spec.id],
          state:
            state === 'ready'
              ? 'ok'
              : state === 'signin' || state === 'missing'
                ? 'signin'
                : state === 'error'
                  ? 'error'
                  : 'unknown',
        };
      }),
    recordLaunch() {
      const tips = { ...config.tips, launches: config.tips.launches + 1 };
      save({ ...config, tips });
    },
    tip(where, context) {
      if (!shouldShowTip({ tips: config.tips, config, ...context })) return undefined;
      save({ ...config, tips: afterShown(config.tips) });
      return where === 'login' ? LOGIN_TIP : tipLine(remote ?? 'other');
    },
    dismissTip() {
      if (!config.tips.dismissed) save({ ...config, tips: { ...config.tips, dismissed: true } });
    },
    async prime() {
      remote = await remoteKind(run, options.folder).catch(() => 'other' as const);
      changed();
    },
    remote: () => remote,
    sync: () => extension.sync(),
  };
  return self;
}
