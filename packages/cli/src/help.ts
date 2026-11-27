import { omsCommand } from '@oms/engine';

/** Every command oms accepts: the usage lines and notes that `oms <command> --help` prints. */
export const COMMANDS: Record<string, { usage: string[]; about: string }> = {
  start: {
    usage: [
      'start [--new] [--spend-usd <n>] [--tokens <n>] [--minutes <n>] [--output-tokens <n>] [--bounded] [--no-web]',
      '      [--yolo]',
    ],
    about:
      'Open the chat in the current folder. Plain `oms` does the same, and takes the same options.\n' +
      "It resumes this folder's newest conversation; --new starts a separate one and keeps the old ones.",
  },
  exec: {
    usage: [
      'exec [--continue] [--json] [--provider <provider> --model <model>] [--spend-usd <n>] [--tokens <n>]',
      '    [--minutes <n>] [--output-tokens <n>] [--bounded] [--no-web] [--yolo] <prompt> [-]',
    ],
    about:
      'Run one prompt in the current folder and print the reply; progress goes to stderr. `-` adds standard input\n' +
      'to the prompt. Each run is a new conversation unless you pass --continue, which keeps the saved budget caps.\n' +
      'Nobody can approve commands, so any command that would need approval is refused unless you pass --yolo.\n' +
      'Connectors are not loaded.',
  },
  doctor: {
    usage: ['doctor [--json] [--programs] [--rpc <url>] [--surfpool-binary <path>] [--install]'],
    about: 'Check local prerequisites. --install downloads the pinned Surfpool and checks its SHA-256.',
  },
  review: {
    usage: [
      'review [path] --phase A [--program <name>] [--json] [--out <new-directory>] [--state-root <directory>]',
      'review [path] --purge <reviewId|all> [--state-root <directory>]',
    ],
    about: 'Run an offline security review of a Solana program.',
  },
  error: {
    usage: ['error <code> [program]'],
    about:
      'Name a custom program error. The code is decimal, hex or "custom program error: 0x…". It reads the built-in\n' +
      "Anchor, System and SPL tables and this project's target/idl/*.json, with no network.",
  },
  sessions: {
    usage: ['sessions [--json]', 'sessions --prune [--yes]'],
    about:
      'List the folders that have saved conversations. Run oms in a folder to continue there.\n' +
      '--prune deletes the saved state of folders that no longer exist, after asking.',
  },
  update: {
    usage: ['update [--check] [--version <x.y.z>]'],
    about: 'Install the latest release the way oms was installed. --check only reports.',
  },
  version: { usage: ['version'], about: 'Print the installed version.' },
  config: {
    usage: ['config [--json]'],
    about: 'Show where OMS keeps its settings and state. Secret files are never opened.',
  },
  login: {
    usage: ['login'],
    about: 'Sign in to your Oh My Sol account for Solana knowledge. Model providers are set up with /connect.',
  },
  logout: { usage: ['logout'], about: 'Sign out of your Oh My Sol account on this device.' },
  whoami: { usage: ['whoami'], about: 'Show the signed-in Oh My Sol account.' },
  completion: {
    usage: ['completion bash|zsh|fish'],
    about: 'Print a shell completion script. Its first line says where to put it.',
  },
  uninstall: {
    usage: ['uninstall [--purge] [--yes]'],
    about:
      'Remove oms the way it was installed, after asking. Your conversations, sign-ins and settings stay\n' +
      'unless you pass --purge.',
  },
  toolchain: {
    usage: ['toolchain check|fix [--project <path>] [--apply] [--verify]'],
    about: 'Find and repair Anchor and Kit version and build mismatches.',
  },
  workspace: {
    usage: ['workspace init <repository> --ignore gitignore|exclude|require-existing'],
    about: 'Initialize local repository identity and ignored OMS storage.',
  },
  task: {
    usage: ['task create --workspace <repository> [--base <revision>] --requirements <file> [--id <task-id>]'],
    about: 'Create a managed worktree and pin explicit requirements.',
  },
  run: {
    usage: [
      'run [--workspace <repository>] [--task <task-id>] [--session <session-id>]',
      '    [--provider <provider> --model <model>] [--bounded] [--tokens <cap>] [--spend-usd <cap>]',
      '    [--minutes <cap>] [--output-tokens <cap>] [--surfpool-binary <path>]',
      '    [--sandbox host|docker] [--host-approval deny|allow]',
    ],
    about: 'Open the task interface over its persistent session.',
  },
};

export function commandHelp(name: string): string {
  const { usage, about } = COMMANDS[name]!;
  const lines = usage.map((line) => (line.startsWith(' ') ? `      ${line}` : `  ${omsCommand()} ${line}`));
  return `Usage:\n${lines.join('\n')}\n\n${about}`;
}

/** True when help was asked for before any `--` separator. */
export function wantsHelp(args: readonly string[]): boolean {
  const end = args.indexOf('--');
  return (end < 0 ? args : args.slice(0, end)).some((arg) => arg === '--help' || arg === '-h');
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/** The command a typo most likely meant: at most two edits away, and never a rewrite of a very short word. */
export function suggestCommand(input: string): string | undefined {
  const [best] = Object.keys(COMMANDS)
    .map((name) => ({ name, edits: distance(input.toLowerCase(), name) }))
    .filter(({ edits }) => edits <= 2 && edits < input.length - 1)
    .sort((a, b) => a.edits - b.edits);
  return best?.name;
}
