// Shell completion (docs/cli-tui-design.md §16 Milestone 4).
//
// The scripts are GENERATED from the same command table --help renders and the dispatcher consults.
// A hand-written completion file is a third copy of the command list, and it drifts the way the help
// text would have: a command that works but does not complete teaches operators the tool is smaller
// than it is, and one that completes but does not work is worse. The drift test asserts the generated
// output covers exactly IMPLEMENTED.
//
// Completion never resolves a configuration and never touches the network, so it works offline and
// with no credential -- which is the acceptance criterion, and also the only sane behaviour for a
// function the shell calls on every keystroke.

import { COMMAND_SUMMARIES, PROGRAM } from '../cli.ts';
import { UsageError } from '../api/errors.ts';

export const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

const GLOBAL_FLAGS = ['--profile', '--url', '--json', '--no-color', '--timeout', '--yes', '--help', '--version'];

/** Command path split into its two levels: { runs: ['list', 'show', ...] }. */
function commandTree(): Map<string, string[]> {
  const tree = new Map<string, string[]>();
  for (const [name] of COMMAND_SUMMARIES) {
    const [group, sub] = name.split(' ');
    if (!group || !sub) continue;
    const list = tree.get(group) ?? [];
    list.push(sub);
    tree.set(group, list);
  }
  return tree;
}

function isSupported(shell: string): shell is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(shell);
}

/**
 * The completion script for one shell, ready to be written to stdout.
 *
 * An unsupported shell is a usage error rather than a silent empty script: an empty file dropped into
 * a shell's completion directory fails invisibly, and the operator blames the shell rather than the
 * tool that wrote it.
 */
export function completionScript(shell: string): string {
  if (!isSupported(shell)) {
    throw new UsageError(
      `unsupported shell ${JSON.stringify(shell)}. Supported: ${SUPPORTED_SHELLS.join(', ')}. ` +
        'Pass the name of the shell you use, e.g. `mercuryctl completion zsh`.',
    );
  }
  const tree = commandTree();
  const groups = [...tree.keys()].sort();
  if (shell === 'bash') return bashScript(groups, tree);
  if (shell === 'zsh') return zshScript(groups, tree);
  return fishScript(tree);
}

function bashScript(groups: string[], tree: Map<string, string[]>): string {
  const cases = [...tree.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    // The `-- "$cur"` filter is not decoration: without it the case branch offers every subcommand
    // whatever the operator has typed, so `runs w` lists all eight.
    .map(([group, subs]) =>
      `    ${group}) [[ "\${COMP_CWORD}" -eq 2 ]] && COMPREPLY=( $(compgen -W "${[...subs].sort().join(' ')}" -- "$cur") ) ;;`)
    .join('\n');
  // Escaped \${...} so the shell, not TypeScript, expands these.
  return `# ${PROGRAM} completion for bash. Install with:
#   ${PROGRAM} completion bash > /etc/bash_completion.d/${PROGRAM}
# or, per user:
#   source <(${PROGRAM} completion bash)
_${PROGRAM.replace(/-/g, '_')}_completion() {
  local cur groups
  cur="\${COMP_WORDS[COMP_CWORD]}"
  groups="${groups.join(' ')}"
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "${GLOBAL_FLAGS.join(' ')}" -- "$cur") )
    return 0
  fi
  if [[ "\${COMP_CWORD}" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$groups completion" -- "$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
  return 0
}
complete -o default -F _${PROGRAM.replace(/-/g, '_')}_completion ${PROGRAM}
`;
}

function zshScript(groups: string[], tree: Map<string, string[]>): string {
  const cases = [...tree.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, subs]) => `      ${group})\n        _values 'command' ${[...subs].sort().map((s) => `'${s}'`).join(' ')}\n        ;;`)
    .join('\n');
  return `#compdef ${PROGRAM}
# ${PROGRAM} completion for zsh. Install with:
#   ${PROGRAM} completion zsh > "\${fpath[1]}/_${PROGRAM}"
# then restart the shell, or:
#   source <(${PROGRAM} completion zsh)
_${PROGRAM.replace(/-/g, '_')}() {
  local state
  _arguments -C \\
    '1: :->level1' \\
    '2: :->level2' \\
    '*:: :->rest'
  case $state in
    level1)
      _values 'command' ${[...groups, 'completion'].map((g) => `'${g}'`).join(' ')} \\
        ${GLOBAL_FLAGS.map((f) => `'${f}'`).join(' ')}
      ;;
    level2)
      case $words[2] in
${cases}
      esac
      ;;
  esac
}
_${PROGRAM.replace(/-/g, '_')} "$@"
`;
}

function fishScript(tree: Map<string, string[]>): string {
  const lines: string[] = [
    `# ${PROGRAM} completion for fish. Install with:`,
    `#   ${PROGRAM} completion fish > ~/.config/fish/completions/${PROGRAM}.fish`,
    `complete -c ${PROGRAM} -f`,
  ];
  for (const group of [...tree.keys()].sort()) {
    lines.push(`complete -c ${PROGRAM} -n "__fish_use_subcommand" -a "${group}"`);
    for (const sub of [...tree.get(group)!].sort()) {
      lines.push(
        `complete -c ${PROGRAM} -n "__fish_seen_subcommand_from ${group}" -a "${sub}"`,
      );
    }
  }
  lines.push(`complete -c ${PROGRAM} -s h -l help -d 'Show help'`);
  lines.push(`complete -c ${PROGRAM} -l version -s V -d 'Print the client version'`);
  lines.push(`complete -c ${PROGRAM} -l json -d 'Machine-readable output'`);
  lines.push(`complete -c ${PROGRAM} -l profile -d 'Select a profile' -r`);
  lines.push(`complete -c ${PROGRAM} -l url -d 'Endpoint override' -r`);
  lines.push(`complete -c ${PROGRAM} -l timeout -d 'Per-request deadline' -r`);
  lines.push(`complete -c ${PROGRAM} -l yes -d 'Skip confirmation prompts'`);
  lines.push(`complete -c ${PROGRAM} -l no-color -d 'Disable ANSI colour'`);
  return lines.join('\n') + '\n';
}
