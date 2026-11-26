import { COMMANDS } from './help.ts';

export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

/** Words that follow a command and are not flags. */
const ACTIONS: Record<string, string[]> = {
  toolchain: ['check', 'fix'],
  workspace: ['init'],
  task: ['create'],
  completion: [...SHELLS],
};

const flagsOf = (name: string): string[] => [
  ...new Set([...COMMANDS[name]!.usage.join(' ').matchAll(/--[a-z-]+/g)].map((match) => match[0])),
];
const wordsOf = (name: string): string[] => [...(ACTIONS[name] ?? []), ...flagsOf(name), '--help'];

/** A completion script built from the same table that prints each command's help. */
export function completionScript(shell: Shell): string {
  const names = Object.keys(COMMANDS);
  const first = [...names, 'help', '--help', '--version', ...flagsOf('start')].join(' ');
  if (shell === 'fish') {
    return [
      '# oms completion for fish: oms completion fish > ~/.config/fish/completions/oms.fish',
      ...names.map(
        (name) =>
          `complete -c oms -n __fish_use_subcommand -a ${name} -d '${COMMANDS[name]!.about.split(/[.\n]/)[0]!.replaceAll("'", '')}'`,
      ),
      ...flagsOf('start').map((flag) => `complete -c oms -n __fish_use_subcommand -l ${flag.slice(2)}`),
      ...names.flatMap((name) => {
        const when = `complete -c oms -n '__fish_seen_subcommand_from ${name}'`;
        return [
          ...(ACTIONS[name] ? [`${when} -a '${ACTIONS[name].join(' ')}'`] : []),
          ...[...flagsOf(name), '--help'].map((flag) => `${when} -l ${flag.slice(2)}`),
        ];
      }),
    ].join('\n');
  }
  const cases = names.map((name) =>
    shell === 'bash'
      ? `    ${name}) words="${wordsOf(name).join(' ')}" ;;`
      : `    ${name}) compadd -- ${wordsOf(name).join(' ')}; _files ;;`,
  );
  if (shell === 'bash') {
    return [
      '# oms completion for bash: add to ~/.bashrc: eval "$(oms completion bash)"',
      '_oms() {',
      '  local cur=${COMP_WORDS[COMP_CWORD]} words=""',
      '  if [ "$COMP_CWORD" -eq 1 ]; then',
      `    words="${first}"`,
      '  else',
      '    case ${COMP_WORDS[1]} in',
      ...cases,
      '    esac',
      '  fi',
      '  COMPREPLY=($(compgen -W "$words" -- "$cur"))',
      '}',
      'complete -o default -F _oms oms',
    ].join('\n');
  }
  return [
    '# oms completion for zsh: add to ~/.zshrc after compinit: eval "$(oms completion zsh)"',
    '_oms() {',
    '  if (( CURRENT == 2 )); then',
    `    compadd -- ${first}`,
    '    return',
    '  fi',
    '  case $words[2] in',
    ...cases,
    '    *) _files ;;',
    '  esac',
    '}',
    'compdef _oms oms',
  ].join('\n');
}
