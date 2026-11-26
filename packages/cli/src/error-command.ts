import { decodeProgramError, omsCommand, parseErrorCode, readLocalIdls } from '@oms/engine';
import { describeDecoding } from './tui/solana-commands.ts';
import { displayText } from './tui/transcript.ts';

/** `oms error <code> [program]`: the offline half of the chat's /error, over this folder's IDLs. */
export function runErrorCommand(
  args: string[],
  folder: string,
  log: (line: string) => void,
  error: (line: string) => void,
): number {
  const [code, program, ...extra] = args
    .join(' ')
    .replace(/^\s*custom program error:\s*/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const parsed = code === undefined ? undefined : parseErrorCode(code);
  if (parsed === undefined || extra.length) {
    error(`Usage: ${omsCommand()} error <code> [program] · decimal or 0x hex`);
    return 2;
  }
  const decoding = decodeProgramError(parsed, program, readLocalIdls(folder));
  // IDL text comes from the repository, so it is cleaned before it reaches the terminal.
  const line = (text: string) => log(displayText(text, 500).replace(/\s+/g, ' '));
  line(`Custom error ${parsed} (0x${parsed.toString(16)})${program ? ` in ${program}` : ''}`);
  if (!decoding.matches.length) line("Unknown code (not in the built-in tables or this project's IDLs)");
  describeDecoding(decoding).forEach(line);
  return decoding.matches.length ? 0 : 1;
}
