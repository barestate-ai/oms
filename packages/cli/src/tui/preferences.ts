import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { StartupArtMode } from './startup-art.ts';
import { DEFAULT_THEME_ID, getTheme, type Backdrop, type OmsThemeId } from './theme.ts';

/** Look-and-feel choices kept across launches in `<state root>/tui.json`. Nothing secret belongs here. */
export interface TuiPreferences {
  theme: OmsThemeId;
  background: Backdrop;
  /** Absent until the user picks one with /art, so each layout keeps its own default. */
  startupArt?: StartupArtMode;
}

const ART_MODES: readonly string[] = ['auto', 'image', 'truecolor', '256', 'off'] satisfies StartupArtMode[];
const file = (stateRoot: string) => join(stateRoot, 'tui.json');

/** The saved choices. A missing, unreadable or malformed file, or any unknown value, quietly gives the default. */
export function readTuiPreferences(stateRoot: string): TuiPreferences {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(stateRoot), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    // Defaults below.
  }
  const text = (key: string) => (typeof saved[key] === 'string' ? (saved[key] as string) : '');
  const startupArt = text('startupArt');
  return {
    theme: getTheme(text('theme'))?.id ?? DEFAULT_THEME_ID,
    background: text('background') === 'terminal' ? 'terminal' : 'theme',
    ...(ART_MODES.includes(startupArt) ? { startupArt: startupArt as StartupArtMode } : {}),
  };
}

/** Merge `change` into the saved choices: a private file replaced atomically. False when it could not be written. */
export function saveTuiPreferences(stateRoot: string, change: Partial<TuiPreferences>): boolean {
  try {
    readFileSync(file(stateRoot));
  } catch (error) {
    // Only a missing file starts from defaults; an unreadable one must not be replaced by them.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  const next = { ...readTuiPreferences(stateRoot), ...change };
  const temporary = `${file(stateRoot)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file(stateRoot));
    return true;
  } catch {
    rmSync(temporary, { force: true });
    return false;
  }
}

/** runOmsInterface options that start from the saved choices and save each change (best effort, never fatal). */
export function interfacePreferences(stateRoot: string) {
  const saved = readTuiPreferences(stateRoot);
  return {
    theme: saved.theme,
    background: saved.background,
    ...(saved.startupArt ? { startupArt: saved.startupArt } : {}),
    onThemeChange: (theme: OmsThemeId) => void saveTuiPreferences(stateRoot, { theme }),
    onStartupArtChange: (startupArt: StartupArtMode) => void saveTuiPreferences(stateRoot, { startupArt }),
  };
}
