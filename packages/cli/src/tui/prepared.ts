/** What a slash command shows: a conversation note, plus optionally the full text for a read-only workbench report. */
export interface CommandOutput {
  title: string;
  text: string;
  report?: { id: string; text: string };
  /** The note is shown, then the action fails with this message. */
  failure?: string;
  /** The note already says what `failure` says, so the failure adds no second note. */
  failureShown?: true;
  /** Show the note without moving to the agent conversation: the view and focus stay where they are. */
  inPlace?: true;
  /** Clear the notice row once the note is shown. */
  clearNotice?: true;
  /** Once the command's own work has ended, send this to the agent as the person's next message (/pr, /issue, /ci). */
  ask?: string;
}
/**
 * A parsed command: either a refusal, whose message is the whole notice, or the work to run. The work returns nothing when
 * it has nothing to show.
 */
export type Prepared =
  { ok: true; run(signal: AbortSignal): Promise<CommandOutput | undefined> } | { ok: false; message: string };
export const refuse = (message: string): Prepared => ({ ok: false, message });
/** The same as refuse; kept for the call sites that read better saying the message is complete. */
export const refuseWith = refuse;

/** The workbench editor holds 64 KiB; a preview stays under it. */
export const REPORT_BYTES = 60 * 1024;

/** The first `limit` bytes of `text` without splitting a character; a cut preview ends with `marker`. */
export function previewBytes(text: string, limit: number, marker = '\n[Preview truncated]'): string {
  let bytes = 0;
  let preview = '';
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) return preview + marker;
    preview += character;
  }
  return preview;
}
