/**
 * The argument lists connectors run on the host. Each action has a fixed shape; the model or the user supplies only
 * values, and every value is checked before it reaches an argument list. There is no shell, so a value can never become
 * a command, and none can begin with `-`, so none can become an option.
 */

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}
function fail(message: string): never {
  throw new ArgumentError(message);
}

/** A program to run, its fixed arguments, and what the approval row says about it. */
export interface Call {
  program: string;
  args: string[];
  write: boolean;
  /** One line for the approval row and the transcript. */
  summary: string;
  /** What the approval row says before the text, when the summary carries a preview of it. */
  headline?: string;
  /** The text that goes out in full (a comment, a body, the flags), which the approval shows under the headline. */
  detail?: string;
  timeoutMs: number;
  /** Keep only the last lines of the output (long CI logs). */
  tail?: number;
}
export type Params = Readonly<Record<string, unknown>>;
interface Action {
  write: boolean;
  build(params: Params): { args: string[]; summary: string; headline?: string; detail?: string; tail?: number };
}

const READ_MS = 20_000;
const WRITE_MS = 120_000;
const NUMBER = /^#?(\d{1,9})$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;
const RUN_ID = /^\d{1,15}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

/** `42` or `#42`: the number, or undefined when none was given. */
function number(params: Params, key: string, required = false): string | undefined {
  const value = params[key];
  if (!present(value)) return required ? fail(`${key} is required, for example 42.`) : undefined;
  const match = NUMBER.exec(String(value).trim());
  return match ? match[1] : fail(`${key} must be a number such as 42.`);
}
/** A number, or a branch name; for commands that take either. */
function reference(params: Params, key: string): string | undefined {
  const value = params[key];
  if (!present(value)) return undefined;
  const text = String(value).trim();
  const match = NUMBER.exec(text);
  if (match) return match[1];
  return REF.test(text) && !text.includes('..') && !text.endsWith('/')
    ? text
    : fail(`${key} must be a number or a branch name.`);
}
function text(params: Params, key: string, max: number, required = true): string | undefined {
  const value = params[key];
  if (!present(value)) return required ? fail(`${key} is required.`) : undefined;
  if (typeof value !== 'string') return fail(`${key} must be text.`);
  if (value.length > max) return fail(`${key} is longer than ${max} characters.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return fail(`${key} contains control characters.`);
  return value;
}
function pick<T extends string>(params: Params, key: string, allowed: readonly T[], fallback: T): T {
  const value = params[key];
  if (!present(value)) return fallback;
  return allowed.includes(value as T) ? (value as T) : fail(`${key} must be one of: ${allowed.join(', ')}.`);
}
function limit(params: Params, key = 'limit', fallback = 20, max = 50): string {
  const value = params[key];
  if (!present(value)) return String(fallback);
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max
    ? String(n)
    : fail(`${key} must be a whole number from 1 to ${max}.`);
}
const preview = (value: string | undefined, max = 60): string => {
  const line = (value ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const label = (prefix: string, number?: string) => (number ? `${prefix} #${number}` : prefix);
/** What a create action sends, all of it: the title, then the body under a blank line. */
const posted = (title: string, body: string): string => (body ? `${title}\n\n${body}` : title);

// ---------------------------------------------------------------- GitHub (gh)

export const GITHUB_ACTIONS: Readonly<Record<string, Action>> = {
  pr_view: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return {
        args: [
          'pr',
          'view',
          ...(n ? [n] : []),
          '--json',
          'number,title,body,state,headRefName,baseRefName,author,labels,reviewDecision,reviews,comments,files',
        ],
        summary: label('view pull request', n),
      };
    },
  },
  pr_list: {
    write: false,
    build(p) {
      const state = pick(p, 'state', ['open', 'closed', 'merged', 'all'], 'open');
      return {
        args: [
          'pr',
          'list',
          '--state',
          state,
          '--limit',
          limit(p),
          '--json',
          'number,title,headRefName,author,state,updatedAt',
        ],
        summary: `list ${state} pull requests`,
      };
    },
  },
  pr_diff: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return { args: ['pr', 'diff', ...(n ? [n] : [])], summary: label('diff pull request', n) };
    },
  },
  pr_files: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return {
        args: ['pr', 'diff', ...(n ? [n] : []), '--name-only'],
        summary: label('changed files of pull request', n),
      };
    },
  },
  pr_checks: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return {
        args: ['pr', 'checks', ...(n ? [n] : []), '--json', 'name,state,bucket,link,workflow'],
        summary: label('checks of pull request', n),
      };
    },
  },
  run_failed_log: {
    write: false,
    build(p) {
      const id = String(p.run_id ?? '').trim();
      if (!RUN_ID.test(id)) fail('run_id must be the number of a workflow run.');
      return { args: ['run', 'view', id, '--log-failed'], summary: `failed log of run ${id}`, tail: 200 };
    },
  },
  issue_view: {
    write: false,
    build(p) {
      const n = number(p, 'number', true);
      return {
        args: ['issue', 'view', n!, '--json', 'number,title,body,state,labels,author,comments'],
        summary: label('view issue', n),
      };
    },
  },
  issue_list: {
    write: false,
    build(p) {
      const state = pick(p, 'state', ['open', 'closed', 'all'], 'open');
      return {
        args: ['issue', 'list', '--state', state, '--limit', limit(p), '--json', 'number,title,state,labels,updatedAt'],
        summary: `list ${state} issues`,
      };
    },
  },
  pr_create: {
    write: true,
    build(p) {
      const title = text(p, 'title', 200)!;
      const body = text(p, 'body', 8000, false) ?? '';
      const base = reference(p, 'base');
      return {
        args: [
          'pr',
          'create',
          `--title=${title}`,
          `--body=${body}`,
          ...(base ? [`--base=${base}`] : []),
          ...(p.draft === true ? ['--draft'] : []),
        ],
        summary: `open pull request "${preview(title)}"${base ? ` into ${base}` : ''}`,
        headline: `open pull request${base ? ` into ${base}` : ''}`,
        detail: posted(title, body),
      };
    },
  },
  pr_comment: {
    write: true,
    build(p) {
      const n = reference(p, 'number');
      const body = text(p, 'body', 8000)!;
      return {
        args: ['pr', 'comment', ...(n ? [n] : []), `--body=${body}`],
        summary: `${label('comment on pull request', n)}: "${preview(body)}"`,
        headline: label('comment on pull request', n),
        detail: body,
      };
    },
  },
  issue_create: {
    write: true,
    build(p) {
      const title = text(p, 'title', 200)!;
      const body = text(p, 'body', 8000, false) ?? '';
      return {
        args: ['issue', 'create', `--title=${title}`, `--body=${body}`],
        summary: `open issue "${preview(title)}"`,
        headline: 'open issue',
        detail: posted(title, body),
      };
    },
  },
  issue_comment: {
    write: true,
    build(p) {
      const n = number(p, 'number', true);
      const body = text(p, 'body', 8000)!;
      return {
        args: ['issue', 'comment', n!, `--body=${body}`],
        summary: `${label('comment on issue', n)}: "${preview(body)}"`,
        headline: label('comment on issue', n),
        detail: body,
      };
    },
  },
};

// ---------------------------------------------------------------- GitLab (glab)

export const GITLAB_ACTIONS: Readonly<Record<string, Action>> = {
  mr_view: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return { args: ['mr', 'view', ...(n ? [n] : []), '--comments'], summary: label('view merge request', n) };
    },
  },
  mr_list: {
    write: false,
    build(p) {
      return { args: ['mr', 'list', '--per-page', limit(p)], summary: 'list merge requests' };
    },
  },
  mr_diff: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return { args: ['mr', 'diff', ...(n ? [n] : [])], summary: label('diff merge request', n) };
    },
  },
  issue_view: {
    write: false,
    build(p) {
      const n = number(p, 'number', true);
      return { args: ['issue', 'view', n!, '--comments'], summary: label('view issue', n) };
    },
  },
  issue_list: {
    write: false,
    build(p) {
      return { args: ['issue', 'list', '--per-page', limit(p)], summary: 'list issues' };
    },
  },
  ci_status: {
    write: false,
    build() {
      return { args: ['ci', 'status'], summary: 'pipeline status of this branch', tail: 200 };
    },
  },
  mr_create: {
    write: true,
    build(p) {
      const title = text(p, 'title', 200)!;
      const body = text(p, 'body', 8000, false) ?? '';
      const base = reference(p, 'base');
      return {
        args: [
          'mr',
          'create',
          `--title=${title}`,
          `--description=${body}`,
          '--yes',
          ...(base ? [`--target-branch=${base}`] : []),
        ],
        summary: `open merge request "${preview(title)}"${base ? ` into ${base}` : ''}`,
        headline: `open merge request${base ? ` into ${base}` : ''}`,
        detail: posted(title, body),
      };
    },
  },
  mr_comment: {
    write: true,
    build(p) {
      const n = reference(p, 'number');
      const body = text(p, 'body', 8000)!;
      return {
        args: ['mr', 'note', ...(n ? [n] : []), `--message=${body}`],
        summary: `${label('comment on merge request', n)}: "${preview(body)}"`,
        headline: label('comment on merge request', n),
        detail: body,
      };
    },
  },
  issue_create: {
    write: true,
    build(p) {
      const title = text(p, 'title', 200)!;
      const body = text(p, 'body', 8000, false) ?? '';
      return {
        args: ['issue', 'create', `--title=${title}`, `--description=${body}`, '--yes'],
        summary: `open issue "${preview(title)}"`,
        headline: 'open issue',
        detail: posted(title, body),
      };
    },
  },
  issue_comment: {
    write: true,
    build(p) {
      const n = number(p, 'number', true);
      const body = text(p, 'body', 8000)!;
      return {
        args: ['issue', 'note', n!, `--message=${body}`],
        summary: `${label('comment on issue', n)}: "${preview(body)}"`,
        headline: label('comment on issue', n),
        detail: body,
      };
    },
  },
};

// ---------------------------------------------------------------- Docker

function containerName(params: Params): string {
  const value = String(params.container ?? '').trim();
  return NAME.test(value) ? value : fail('container must be a container name or id.');
}
/** Printed fields only: `docker inspect` as a whole carries the container's environment, which can hold secrets. */
const INSPECT_FORMAT =
  '{"image":{{json .Config.Image}},"command":{{json .Config.Cmd}},"state":{{json .State}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}';

export const DOCKER_ACTIONS: Readonly<Record<string, Action>> = {
  ps: {
    write: false,
    build: () => ({
      args: ['ps', '--all', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'],
      summary: 'list containers',
    }),
  },
  logs: {
    write: false,
    build(p) {
      const c = containerName(p);
      const tail = limit(p, 'tail', 200, 1000);
      return { args: ['logs', '--tail', tail, c], summary: `last ${tail} log lines of ${c}` };
    },
  },
  inspect: {
    write: false,
    build(p) {
      const c = containerName(p);
      return { args: ['inspect', '--format', INSPECT_FORMAT, c], summary: `inspect ${c}` };
    },
  },
  images: {
    write: false,
    build: () => ({
      args: ['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}'],
      summary: 'list images',
    }),
  },
  compose_up: {
    write: true,
    build(p) {
      const services = Array.isArray(p.services)
        ? p.services
        : p.services === undefined
          ? []
          : fail('services must be a list of names.');
      if (services.length > 10) fail('services can name at most 10.');
      for (const service of services)
        if (typeof service !== 'string' || !NAME.test(service)) fail('services must be names.');
      return {
        args: ['compose', 'up', '-d', '--no-color', ...(services as string[])],
        summary: `compose up${services.length ? ' ' + services.join(' ') : ''}`,
      };
    },
  },
  compose_down: {
    write: true,
    // No -v: named volumes, which can hold data, stay.
    build: () => ({ args: ['compose', 'down'], summary: 'compose down (volumes stay)' }),
  },
  run: {
    write: true,
    build(p) {
      const image = String(p.image ?? '').trim();
      if (!IMAGE.test(image)) fail('image must be an image name such as node:22.');
      const command = p.command === undefined ? [] : p.command;
      if (!Array.isArray(command) || command.length > 20) fail('command must be a list of at most 20 words.');
      for (const word of command as unknown[]) {
        if (typeof word !== 'string' || word.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(word))
          fail('command words must be short text.');
      }
      return {
        // No mounts, no extra privileges: the image and what it runs, then it is removed.
        args: ['run', '--rm', image, ...(command as string[])],
        summary: `run ${[image, ...(command as string[])].join(' ')}`,
      };
    },
  },
};

// ---------------------------------------------------------------- AWS

/**
 * The read operations the agent may run, by service. Anything not listed is refused, whatever its name looks like: a
 * get- or describe- can return a secret (a function's environment, a task definition's variables, a cluster token,
 * an instance's user data), and a list of names cannot know which. A new operation is added after reading what it returns.
 */
const AWS_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  acm: ['describe-certificate', 'list-certificates'],
  apigateway: ['get-rest-apis', 'get-rest-api', 'get-stages', 'get-resources', 'get-deployments', 'get-domain-names'],
  apigatewayv2: ['get-apis', 'get-api', 'get-stages', 'get-routes', 'get-integrations', 'get-domain-names'],
  cloudformation: [
    'describe-stacks',
    'describe-stack-events',
    'describe-stack-resources',
    'describe-stack-resource',
    'list-stacks',
    'list-stack-resources',
    'list-exports',
  ],
  cloudfront: ['list-distributions', 'list-invalidations', 'get-invalidation'],
  cloudwatch: [
    'describe-alarms',
    'describe-alarm-history',
    'list-metrics',
    'get-metric-statistics',
    'get-metric-data',
    'list-dashboards',
  ],
  dynamodb: ['describe-table', 'list-tables', 'describe-time-to-live', 'describe-continuous-backups', 'list-backups'],
  ec2: [
    'describe-instances',
    'describe-instance-status',
    'describe-vpcs',
    'describe-subnets',
    'describe-security-groups',
    'describe-security-group-rules',
    'describe-volumes',
    'describe-images',
    'describe-key-pairs',
    'describe-addresses',
    'describe-regions',
    'describe-availability-zones',
    'describe-route-tables',
    'describe-internet-gateways',
    'describe-nat-gateways',
    'describe-network-interfaces',
    'describe-snapshots',
    'describe-tags',
    'describe-launch-templates',
  ],
  ecr: [
    'describe-repositories',
    'describe-images',
    'list-images',
    'describe-image-scan-findings',
    'get-lifecycle-policy',
    'get-repository-policy',
  ],
  ecs: [
    'list-clusters',
    'describe-clusters',
    'list-services',
    'describe-services',
    'list-tasks',
    'list-container-instances',
    'list-task-definitions',
    'list-task-definition-families',
  ],
  eks: [
    'list-clusters',
    'describe-cluster',
    'list-nodegroups',
    'describe-nodegroup',
    'list-addons',
    'describe-addon',
    'list-fargate-profiles',
  ],
  elbv2: [
    'describe-load-balancers',
    'describe-target-groups',
    'describe-target-health',
    'describe-listeners',
    'describe-rules',
    'describe-load-balancer-attributes',
  ],
  iam: [
    'get-account-summary',
    'list-users',
    'list-roles',
    'list-groups',
    'list-policies',
    'get-role',
    'get-policy',
    'get-user',
    'list-attached-role-policies',
    'list-role-policies',
    'list-attached-user-policies',
    'list-account-aliases',
  ],
  // A function's environment variables are where its secrets live: these two answer with a fixed set of fields.
  lambda: [
    'list-functions',
    'get-function-configuration',
    'list-aliases',
    'list-layers',
    'get-policy',
    'list-event-source-mappings',
  ],
  logs: ['describe-log-groups', 'describe-log-streams', 'get-log-events', 'get-query-results'],
  rds: [
    'describe-db-instances',
    'describe-db-clusters',
    'describe-db-snapshots',
    'describe-db-parameter-groups',
    'describe-events',
  ],
  route53: ['list-hosted-zones', 'list-resource-record-sets', 'get-hosted-zone', 'list-health-checks'],
  s3api: [
    'list-buckets',
    'get-bucket-location',
    'get-bucket-versioning',
    'list-objects-v2',
    'list-objects',
    'get-bucket-policy',
    'get-bucket-tagging',
    'get-bucket-encryption',
    'get-public-access-block',
    'get-bucket-lifecycle-configuration',
  ],
  sns: ['list-topics', 'get-topic-attributes', 'list-subscriptions', 'list-subscriptions-by-topic'],
  sqs: ['list-queues', 'get-queue-attributes', 'get-queue-url'],
  sts: ['get-caller-identity'],
};
/** Services the agent may look at. */
export const AWS_SERVICES: readonly string[] = Object.keys(AWS_ALLOWED);
const AWS_OPERATION = /^(describe|list|get)-[a-z0-9]+(-[a-z0-9]+)*$/;
/** Output fields that are safe, for the operations that also return secrets: the agent cannot ask for others. */
const AWS_FIXED_QUERY: Readonly<Record<string, string>> = {
  'lambda:list-functions':
    'Functions[].{FunctionName:FunctionName,Runtime:Runtime,Handler:Handler,MemorySize:MemorySize,Timeout:Timeout,LastModified:LastModified,Role:Role,State:State}',
  'lambda:get-function-configuration':
    '{FunctionName:FunctionName,Runtime:Runtime,Handler:Handler,MemorySize:MemorySize,Timeout:Timeout,LastModified:LastModified,Role:Role,State:State}',
};
const AWS_FLAG = /^[a-z][a-z0-9-]{0,40}$/;
/** Flags that would change where the request goes, whose credentials it uses, or what it reads from disk or reveals. */
const AWS_REFUSED_FLAGS = new Set([
  'profile',
  'region',
  'output',
  'endpoint-url',
  'no-verify-ssl',
  'ca-bundle',
  'debug',
  'cli-input-json',
  'cli-input-yaml',
  'generate-cli-skeleton',
  'cli-binary-format',
  'cli-auto-prompt',
  'cli-read-timeout',
  'cli-connect-timeout',
  'with-decryption',
  'include-values',
  'include-value',
  'no-sign-request',
  'no-cli-pager',
  'color',
]);
/**
 * The AWS CLI accepts a flag by any unambiguous start of its name (`--profil` is `--profile`), so a name that begins one
 * of the refused ones is refused too.
 */
const refusedFlag = (flag: string): boolean =>
  [...AWS_REFUSED_FLAGS].some((refused) => refused.startsWith(flag) || flag.startsWith(`${refused}=`));
const AWS_VALUE = /^[^\x00-\x1f\x7f]{1,512}$/;
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function awsCall(params: Params, profile?: string): Call {
  const service = String(params.service ?? '').trim();
  const operation = String(params.operation ?? '').trim();
  if (!AWS_SERVICES.includes(service))
    fail(`AWS service ${service || '(none)'} is not available. Choose one of: ${AWS_SERVICES.join(', ')}.`);
  if (!AWS_OPERATION.test(operation)) fail('Only describe-, list- and get- operations are allowed.');
  if (!AWS_ALLOWED[service]!.includes(operation))
    fail(
      `${service} ${operation} is not available: only reviewed read operations run, and this one can return secrets or is not on the list. ` +
        `Available for ${service}: ${AWS_ALLOWED[service]!.join(', ')}.`,
    );
  const fixedQuery = AWS_FIXED_QUERY[`${service}:${operation}`];
  const extra: string[] = [];
  const flags = params.args === undefined ? {} : params.args;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags))
    fail('args must be an object of flag names and values.');
  const entries = Object.entries(flags as Record<string, unknown>);
  if (entries.length > 12) fail('args can have at most 12 flags.');
  for (const [flag, value] of entries) {
    if (!AWS_FLAG.test(flag) || refusedFlag(flag)) fail(`The flag --${flag} is not allowed.`);
    if (fixedQuery && 'query'.startsWith(flag) && flag.length >= 1)
      fail(`${service} ${operation} answers with a fixed set of fields; --${flag} is not allowed there.`);
    if (typeof value !== 'string' || !AWS_VALUE.test(value) || value.startsWith('-'))
      fail(`The value of --${flag} must be short text that does not start with a dash.`);
    // The AWS CLI reads a local file, or fetches an address, when a value starts like this.
    if (/^(file|fileb|https?):\/\//i.test(value.trim()))
      fail(`The value of --${flag} cannot read a file or an address.`);
    extra.push(`--${flag}`, value);
  }
  const region = params.region === undefined ? undefined : String(params.region).trim();
  if (region !== undefined && !AWS_REGION.test(region)) fail('region must be a region name such as us-east-1.');
  if (profile !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(profile))
    fail('The saved AWS profile name is not valid.');
  const shownFlags = extra.join(' ');
  return {
    program: 'aws',
    args: [
      service,
      operation,
      ...extra,
      ...(fixedQuery ? ['--query', fixedQuery] : []),
      '--output',
      'json',
      '--no-cli-pager',
      ...(region ? ['--region', region] : []),
      ...(profile ? ['--profile', profile] : []),
    ],
    write: false,
    summary: `aws ${service} ${operation}${region ? ` in ${region}` : ''}`,
    // What the approval shows beyond the name: every flag with its value, the profile, and the fixed fields.
    detail: [
      shownFlags && `flags: ${shownFlags}`,
      fixedQuery && 'fields: a fixed list without environment variables',
      `profile: ${profile ?? 'default'}`,
      `region: ${region ?? 'from the profile'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    timeoutMs: READ_MS,
  };
}

// ---------------------------------------------------------------- lookup

const PROGRAMS = { github: 'gh', gitlab: 'glab', docker: 'docker' } as const;
const TABLES = { github: GITHUB_ACTIONS, gitlab: GITLAB_ACTIONS, docker: DOCKER_ACTIONS } as const;

export type CliConnector = keyof typeof TABLES;
export const actionsOf = (connector: CliConnector): readonly string[] => Object.keys(TABLES[connector]);
export const writeActionsOf = (connector: CliConnector): readonly string[] =>
  Object.entries(TABLES[connector])
    .filter(([, action]) => action.write)
    .map(([name]) => name);
export const readActionsOf = (connector: CliConnector): readonly string[] =>
  Object.entries(TABLES[connector])
    .filter(([, action]) => !action.write)
    .map(([name]) => name);

/** The call for `action` of a command-line connector, or an ArgumentError saying what to fix. */
export function buildCall(connector: CliConnector, action: unknown, params: Params): Call {
  const spec =
    typeof action === 'string' && Object.hasOwn(TABLES[connector], action) ? TABLES[connector][action] : undefined;
  if (!spec)
    return fail(
      `${connector} has no action ${String(action).slice(0, 40)}. Choose one of: ${actionsOf(connector).join(', ')}.`,
    );
  const built = spec.build(params);
  return { program: PROGRAMS[connector], ...built, write: spec.write, timeoutMs: spec.write ? WRITE_MS : READ_MS };
}
