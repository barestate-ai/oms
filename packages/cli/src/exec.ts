import type { AssistantMessage } from '@earendil-works/pi-ai';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import {
  backendFor,
  configuredBackend,
  createChatSession,
  defaultHarnessEnvironment,
  DOCKER_CHAT_REFUSAL,
  hideKnowledgeBlocks,
  inspectSavedChatBudget,
  latestChatSession,
  omsCommand,
  resolveChatFolder,
  scratchNotice,
  type HarnessEnvironment,
} from '@oms/engine';
import { parseLaunchOptions } from './harness.ts';
import { commandHelp } from './help.ts';
import { webSetting } from './interactive.ts';
import { maskSecrets } from './tui/secret-mask.ts';

export interface ExecDeps {
  folder: string;
  stateRoot: string;
  /** Checks and installs what a chat needs, without writing to stdout. */
  prepare: (environment: HarnessEnvironment, signal?: AbortSignal) => Promise<void>;
  readStdin: (signal?: AbortSignal) => Promise<string>;
  /** The reply, and nothing else. */
  out: (text: string) => void;
  /** Progress and problems. */
  note: (line: string) => void;
  environment?: HarnessEnvironment;
  start?: typeof createChatSession;
  signal?: AbortSignal;
}

const VALUED = ['--sandbox', '--tokens', '--spend-usd', '--minutes', '--output-tokens', '--provider', '--model'];
const OWN_SWITCHES = ['--continue', '--json', '--yolo'];
const CAP_OPTIONS = {
  '--tokens': 'tokens',
  '--spend-usd': 'spendMicroUsd',
  '--minutes': 'wallClockMs',
} as const;

/** Terminal sequences, hidden knowledge blocks and anything secret-shaped never reach the output; tabs stay. */
const clean = (text: string): string =>
  maskSecrets(
    stripTerminalSequences(hideKnowledgeBlocks(text))
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ''),
  );

async function parse(args: string[], readStdin: ExecDeps['readStdin'], signal?: AbortSignal) {
  const flags: string[] = [];
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) words.push(arg);
    else {
      flags.push(arg);
      if (VALUED.includes(arg)) flags.push(args[++index] ?? '');
    }
  }
  const launch = parseLaunchOptions(flags, [...OWN_SWITCHES, '--provider', '--model'], OWN_SWITCHES);
  if (launch.values.has('--provider') !== launch.values.has('--model'))
    throw new Error('--provider and --model go together');
  const typed = words.filter((word) => word !== '-').join(' ');
  const piped = words.includes('-') ? (await readStdin(signal)).trim() : '';
  const prompt = [typed, piped].filter(Boolean).join('\n\n').trim();
  if (!prompt) throw new Error('give a prompt, or - to read it from standard input');
  return { launch, prompt };
}

/** `oms exec`: one prompt in the current folder, with no interface and nobody to answer questions. */
export async function runExec(args: string[], deps: ExecDeps): Promise<number> {
  try {
    const code = await runExecPrompt(args, deps);
    if (code === 130 || !deps.signal?.aborted) return code;
  } catch (error) {
    if (!deps.signal?.aborted) throw error;
  }
  deps.note('oms: interrupted');
  return 130;
}

async function runExecPrompt(args: string[], deps: ExecDeps): Promise<number> {
  const { note, out, stateRoot, signal } = deps;
  signal?.throwIfAborted();
  let parsed: Awaited<ReturnType<typeof parse>>;
  try {
    parsed = await parse(args, deps.readStdin, signal);
  } catch (error) {
    signal?.throwIfAborted();
    note(`${omsCommand()} exec: ${error instanceof Error ? error.message : 'bad options'}\n${commandHelp('exec')}`);
    return 2;
  }
  signal?.throwIfAborted();
  const { launch, prompt } = parsed;
  const { values } = launch;
  // Internal SDK policy: no automatic catalog refresh, update checks or telemetry.
  process.env.PI_OFFLINE = '1';
  const environment =
    deps.environment ?? defaultHarnessEnvironment(undefined, configuredBackend(values.get('--sandbox')));
  if (backendFor(environment).requiresDocker) throw new Error(DOCKER_CHAT_REFUSAL);
  const folder = resolveChatFolder(deps.folder, { stateRoot });
  let sessionId: string | undefined;
  let caps = launch.caps;
  let executionMode = launch.executionMode;
  if (values.has('--continue')) {
    const saved = latestChatSession(folder, stateRoot);
    if (saved) {
      const budget = inspectSavedChatBudget(saved.journal);
      if (!budget) {
        note('oms: cannot read the saved conversation budget. Run without --continue to start a new one.');
        return 1;
      }
      for (const [option, key] of Object.entries(CAP_OPTIONS)) {
        if (values.has(option) && caps[key] !== budget.caps[key]) {
          note(
            `oms: ${option} does not match the saved budget. Omit it to use the saved limit, or run without --continue.`,
          );
          return 2;
        }
      }
      if (!budget.usable) {
        note('oms: the last conversation here cannot admit more work. Run without --continue to start a new one.');
        return 1;
      }
      caps = budget.caps;
      executionMode = budget.executionMode;
      sessionId = saved.sessionId;
    } else note('No earlier conversation here; starting a new one.');
  }
  signal?.throwIfAborted();
  await deps.prepare(environment, signal);
  signal?.throwIfAborted();
  const provider = values.get('--provider');
  const chat = await (deps.start ?? createChatSession)({
    folder,
    stateRoot,
    environment,
    caps,
    maxOutputTokens: launch.maxOutputTokens,
    executionMode,
    web: { enabled: !values.has('--no-web') && webSetting(stateRoot) === 'on' },
    ...(values.has('--yolo') ? { yolo: true } : {}),
    ...(provider ? { modelSelection: { provider, id: values.get('--model')! } } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(signal ? { startupSignal: signal } : {}),
  });
  let unsubscribe: (() => void) | undefined;
  const stop = () => void chat.session.abort().catch(() => {});
  try {
    signal?.throwIfAborted();
    if (folder.scratch) note(scratchNotice(folder.path));
    const model = chat.session.model;
    if (!model || model.provider === 'unknown') {
      note(`oms: No model is set up. Run ${omsCommand()}, then /connect and /model, or pass --provider and --model.`);
      return 1;
    }
    chat.setHostApproval?.(async ({ command, reasons }) => {
      note(
        `denied a command that needs approval (${reasons.join(', ')}): ${clean(command).slice(0, 300)}\n  --yolo runs commands without asking and without the sandbox`,
      );
      return false;
    });
    let reply: AssistantMessage | undefined;
    unsubscribe = chat.session.subscribe((event) => {
      if (event.type === 'tool_execution_start') note(`· ${clean(event.toolName)}`);
      if (event.type === 'message_end' && event.message.role === 'assistant') reply = event.message;
    });
    signal?.addEventListener('abort', stop, { once: true });
    signal?.throwIfAborted();
    await chat.session.prompt(prompt, { expandPromptTemplates: false });

    const text = clean(
      (reply?.content ?? [])
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n')
        .trim(),
    );
    const stopReason = signal?.aborted ? 'aborted' : (reply?.stopReason ?? 'error');
    const ok = stopReason === 'stop';
    if (!ok) {
      note(
        stopReason === 'aborted'
          ? 'oms: interrupted'
          : stopReason === 'length'
            ? 'oms: the reply was cut off at the output limit (--output-tokens raises it)'
            : `oms: ${clean(reply?.errorMessage || 'the model request did not finish')}`,
      );
    }
    if (values.has('--json')) {
      const { used } = chat.budget.snapshot();
      out(
        JSON.stringify({
          ok,
          text,
          stopReason,
          sessionId: chat.session.sessionManager.getSessionId(),
          model: `${model.provider}/${model.id}`,
          // Totals for the whole conversation, earlier runs included.
          tokens: used.tokens,
          spendMicroUsd: used.spendMicroUsd,
        }),
      );
    } else if (text && (ok || stopReason === 'length')) out(text);
    return ok ? 0 : stopReason === 'aborted' ? 130 : 1;
  } finally {
    signal?.removeEventListener('abort', stop);
    unsubscribe?.();
    await chat.close();
  }
}
