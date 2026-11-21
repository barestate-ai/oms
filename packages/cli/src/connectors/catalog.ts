import type { Access, ConnectorId } from './config.ts';

export type ConnectorKind = 'cli' | 'mcp-remote' | 'rpc';
export type ConnectorGroup = 'code' | 'team' | 'cloud' | 'solana';

/** A hosted MCP server and the few of its tools the agent is offered. Everything else stays hidden. */
export interface McpPreset {
  /** The server's name; its tools are `mcp__<name>__<tool>` with `-` written as `_`. */
  server: string;
  url: string;
  description: string;
  /** Tool names or `*` patterns the agent may call at any access above off. */
  read: readonly string[];
  /** Tool names or patterns that change something. Offered only at ask and allow, and each one asks at ask. */
  write: readonly string[];
}

export interface ConnectorSpec {
  id: ConnectorId;
  label: string;
  group: ConnectorGroup;
  kind: ConnectorKind;
  /** What the agent gets, in one plain sentence. */
  summary: string;
  /** The levels A steps through, in order. `off` is the Space key, not a level. */
  levels: readonly Exclude<Access, 'off'>[];
  defaultAccess: Exclude<Access, 'off'>;
  /** The command that installs the tool, for the person to run themselves. */
  install?: string;
  /** The command that signs in, for the person to run themselves. */
  signIn?: string;
  /** The program a CLI connector runs, and the host a sign-in is for. */
  program?: string;
  host?: string;
  mcp?: McpPreset;
}

/** Linear's own tool names, curated to the few a coding agent needs. */
const LINEAR: McpPreset = {
  server: 'linear',
  url: 'https://mcp.linear.app/mcp',
  description: 'Linear issues, projects and comments',
  read: [
    'get_issue',
    'list_issues',
    'list_comments',
    'get_project',
    'list_projects',
    'list_teams',
    'list_issue_statuses',
  ],
  write: ['save_issue', 'save_comment'],
};
const SLACK: McpPreset = {
  server: 'slack',
  url: 'https://mcp.slack.com/mcp',
  description: 'Slack search and channel history',
  read: ['*search*', '*read*', '*list*', '*get*'],
  write: ['*send_message*', '*post_message*', '*reply*'],
};
const GITLAB_REMOTE: McpPreset = {
  server: 'gitlab-remote',
  url: 'https://gitlab.com/api/v4/mcp',
  description: 'GitLab issues, merge requests and pipelines',
  read: ['get_*', 'list_*', 'search_*', '*_search'],
  write: ['create_issue', 'create_merge_request', 'create_note', 'create_*_note'],
};

export const CATALOG: readonly ConnectorSpec[] = [
  {
    id: 'github',
    label: 'GitHub',
    group: 'code',
    kind: 'cli',
    program: 'gh',
    host: 'github.com',
    summary: 'Read pull requests, issues and CI. With ask, open pull requests and comment after you approve.',
    levels: ['read', 'ask', 'allow'],
    defaultAccess: 'ask',
    install: 'brew install gh',
    signIn: 'gh auth login',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    group: 'code',
    kind: 'cli',
    program: 'glab',
    host: 'gitlab.com',
    summary: 'Read merge requests, issues and pipelines. With ask, open merge requests and comment after you approve.',
    levels: ['read', 'ask', 'allow'],
    defaultAccess: 'ask',
    install: 'brew install glab',
    signIn: 'glab auth login',
  },
  {
    id: 'gitlab-remote',
    label: 'GitLab (hosted)',
    group: 'code',
    kind: 'mcp-remote',
    host: 'gitlab.com',
    summary: "GitLab's own hosted connector. Sign in with your browser; no command-line tool needed.",
    levels: ['read', 'ask', 'allow'],
    defaultAccess: 'ask',
    mcp: GITLAB_REMOTE,
  },
  {
    id: 'linear',
    label: 'Linear',
    group: 'team',
    kind: 'mcp-remote',
    host: 'linear.app',
    summary: 'Read issues and projects. With ask, create issues and comment after you approve.',
    levels: ['read', 'ask', 'allow'],
    defaultAccess: 'ask',
    mcp: LINEAR,
  },
  {
    id: 'slack',
    label: 'Slack',
    group: 'team',
    kind: 'mcp-remote',
    host: 'slack.com',
    summary: 'Search and read channels. With ask, post a message after you approve.',
    levels: ['read', 'ask', 'allow'],
    defaultAccess: 'ask',
    mcp: SLACK,
  },
  {
    id: 'docker',
    label: 'Docker',
    group: 'cloud',
    kind: 'cli',
    program: 'docker',
    summary:
      'See containers, logs and images. With ask, start or stop a compose project, or run an image, after you approve.',
    levels: ['read', 'ask'],
    defaultAccess: 'read',
    install: 'Install Docker Desktop from docker.com',
  },
  {
    id: 'aws',
    label: 'AWS',
    group: 'cloud',
    kind: 'cli',
    program: 'aws',
    summary:
      'Look at your AWS resources with read-only describe, list and get calls. Nothing is changed. Ask checks every call.',
    // For AWS "ask" means every call is approved; there are no writes in this version.
    levels: ['ask', 'read'],
    defaultAccess: 'ask',
    install: 'brew install awscli',
    signIn: 'aws configure sso',
  },
  {
    id: 'solana-rpc',
    label: 'Solana RPC',
    group: 'solana',
    kind: 'rpc',
    summary: 'Look up accounts and transactions on devnet or mainnet, read-only, through your own RPC (Helius works).',
    levels: ['read'],
    defaultAccess: 'read',
  },
];

export const connectorSpec = (id: string): ConnectorSpec | undefined => CATALOG.find((spec) => spec.id === id);
export const GROUP_LABEL: Record<ConnectorGroup, string> = {
  code: 'code',
  team: 'team',
  cloud: 'infrastructure',
  solana: 'solana',
};

/** The tool names the model sees for the connectors that run on the host. */
export const CONNECTOR_TOOLS = {
  github: 'github',
  gitlab: 'gitlab',
  docker: 'docker',
  aws: 'aws',
  'solana-rpc': 'solana_rpc',
} as const;
