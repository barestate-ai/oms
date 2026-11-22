import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Server } from 'node:net';
import { Duplex } from 'node:stream';
import { Agent } from '@earendil-works/pi-agent-core';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, normalizeContext, Type } from '@earendil-works/pi-ai';
import { createBudgetLedger } from '@oms/core';
import { createDispatchAllocator } from '@oms/core/dispatch';
import { createMeteredStream } from '../src/runtime/usage.ts';
import {
  ClaudeCodeSession,
  claudeCodeEnvironment,
  createClaudeCodeProvider,
  createClaudeCodeStream,
  inspectClaudeCode,
} from '../src/runtime/claude-code.ts';
const context = (content = 'FIRST_SECRET') =>
  normalizeContext({
    systemPrompt: 'Trusted OMS',
    tools: [{ name: 'read', description: 'Read', parameters: Type.Object({ path: Type.String() }) }],
    messages: [{ role: 'user', content, timestamp: 1 }],
  });
const rows = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
async function fixture(mode: string, run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'oms-native-test-'));
  const originalPath = process.env.PATH;
  writeFileSync(
    join(directory, 'claude'),
    `#!${process.execPath}
import{appendFileSync,existsSync,readFileSync,writeFileSync}from'node:fs';
import{spawn}from'node:child_process';import{createInterface}from'node:readline';
const mode=${JSON.stringify(mode)},root=${JSON.stringify(directory)},args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:mode==='api-auth'?'api_key':'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
const id=get(args.includes('--resume')?'--resume':'--session-id');appendFileSync(root+'/launch',JSON.stringify({args,pid:process.pid})+'\\n');
const file=root+'/'+id+'.json';if(args.includes('--resume')&&!existsSync(file))process.exit(1);
const history=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[],decl=JSON.parse(get('--mcp-config')).mcpServers.oms;
let bridge,response,seq=0;if(decl&&mode!=='empty-after-tool'){bridge=spawn(decl.command,decl.args,{stdio:['pipe','pipe','ignore']});createInterface({input:bridge.stdout}).on('line',line=>{const x=JSON.parse(line);if(x.id===response?.id){const done=response;response=undefined;done.resolve(x.result);}});}
const mcp=()=>new Promise(resolve=>{if(mode==='empty-after-tool'){const timer=setInterval(()=>{if(existsSync(root+'/delivered')){clearInterval(timer);resolve(JSON.parse(readFileSync(root+'/delivered','utf8')));}},5);return;}response={id:++seq,resolve};bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:seq,method:'tools/call',params:{name:'read',arguments:{path:'src/main.ts'}}})+'\\n');});
if(mode==='stubborn')process.on('SIGTERM',()=>{});
const emit=x=>process.stdout.write(JSON.stringify({session_id:id,...x})+'\\n');
const tools=decl?JSON.parse(readFileSync(decl.args[1],'utf8')).map(t=>'mcp__oms__'+t.name):[];
const promptInput=()=>mode.includes('big-prompt')&&String(history.at(-1)).includes('compacted by OMS')?20:mode.includes('big-prompt')?170000:mode.includes('mid-prompt')?130000:20;
const usage={input_tokens:20,output_tokens:10,cache_read_input_tokens:30,cache_creation_input_tokens:40,cache_creation:{ephemeral_1h_input_tokens:40}};let n=0;
const emptySuccess=()=>mode.startsWith('empty-success-')&&history.length===1;
function assistant(block,stop='end_turn'){
 const mid='msg_'+ ++n,u=emptySuccess()?{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}:{...usage,input_tokens:promptInput(),output_tokens:mode==='overflow'?128001:10};
 const start={type:'stream_event',event:{type:'message_start',message:{id:mid,model:'claude-haiku-5-5',usage:u}}};emit(start);if(mode==='duplicate-start')emit(start);
 if(mode==='empty-success-no-blocks-then-good'&&history.length===1){emit({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:stop},usage:u}});emit({type:'stream_event',event:{type:'message_stop'}});return;}
 emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:block.type==='text'?{type:'text',text:''}:block}});
 if(block.type==='text')emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:block.text}}});
 emit({type:'assistant',message:{id:mid,model:'claude-haiku-5-5',content:[block],usage:u}});
 emit({type:'stream_event',event:{type:'content_block_stop',index:0}});
 emit({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:stop},usage:u}});
 emit({type:'stream_event',event:{type:'message_stop'}});
}
function receipt(mult){const u={input_tokens:promptInput()*mult,output_tokens:10*mult,cache_read_input_tokens:30*mult,cache_creation_input_tokens:40*mult,cache_creation:{ephemeral_1h_input_tokens:40*mult}};
 if(emptySuccess()){for(const key of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'])u[key]=0;u.cache_creation.ephemeral_1h_input_tokens=0;}
 if(mode==='larger')u.input_tokens++;if(mode==='smaller')u.input_tokens--;
 const r=mode==='synthetic-overflow'||mode==='synthetic-once'&&!String(history.at(-1)).includes('compacted by OMS')?'Prompt is too long':mode==='quotes-phrase'?'Explaining when the Prompt is too long error appears':undefined;
 const x={type:'result',subtype:'success',is_error:false,usage:u,result:r,modelUsage:{'claude-haiku-5-5':{provider:'firstParty',contextWindow:mode.includes('small-window')?160000:1000000,maxOutputTokens:mode==='small-output'?16000:128000},...(mode==='fallback'?{'other':{}}:{})}};emit(x);if(mode==='duplicate-receipt')emit(x);
}
const input=createInterface({input:process.stdin});input.on('line',async line=>{
 const x=JSON.parse(line);if(x.type==='control_request'){emit({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}});return;}history.push(x.message.content);writeFileSync(file,JSON.stringify(history));appendFileSync(root+'/input',JSON.stringify(x)+'\\n');
 emit({type:'system',subtype:'init',tools:mode==='builtin'?['Bash']:tools,mcp_servers:[{name:'oms',status:'connected'}]});if(mode==='hang'||mode==='stubborn')return;
 if(mode==='exit-empty'){process.stdout.write('',()=>process.exit(1));return;}
 if(emptySuccess()){assistant({type:'text',text:''});receipt(1);return;}
 const authError={'auth-401':'API Error: 401','auth-403':'API Error: 403','auth-403-forbidden':'API Error: 403 Forbidden','auth-unauthorized':'Unauthorized','auth-forbidden':'Forbidden'}[mode];
 const compacted=typeof x.message.content==='string'&&x.message.content.includes('compacted by OMS');
 if(mode==='prompt-too-long-always'||mode==='prompt-too-long'&&!compacted){
  emit({type:'result',subtype:'error_during_execution',is_error:true,result:'',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0},modelUsage:{},errors:['Prompt is too long']});return;
 }
 if(authError||mode==='empty'||mode==='empty-then-good'&&history.length===1||mode==='empty-second-then-good'&&history.length===2||mode==='auth-failure'||mode==='usage-limit'){
  emit({type:'result',subtype:'error_during_execution',is_error:true,result:'',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0},modelUsage:{},errors:authError?[authError]:mode==='auth-failure'?['authentication failed after stream error']:mode==='usage-limit'?["You've hit your limit after a server error"]:[]});return;
 }
 if(mode==='empty-after-tool'){
  if(history.length===1){assistant({type:'tool_use',id:'call_'+id,name:'mcp__oms__read',input:{path:'src/main.ts'}},'tool_use');const result=await mcp();appendFileSync(root+'/results',JSON.stringify(result)+'\\n');emit({type:'result',subtype:'error_during_execution',is_error:true,usage,errors:[]});}
  else{assistant({type:'text',text:'reply after tool'});receipt(1);}return;
 }
 if(mode==='active-turn'||mode==='active-then-idle'){
  emit({type:'stream_event',event:{type:'message_start',message:{id:'msg_idle',model:'claude-haiku-5-5',usage}}});
  emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
  for(let i=0;i<4;i++){await new Promise(resolve=>setTimeout(resolve,150));emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'working'}}});}
  if(mode==='active-then-idle')return;
  emit({type:'stream_event',event:{type:'content_block_stop',index:0}});
  emit({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'end_turn'},usage}});
  emit({type:'stream_event',event:{type:'message_stop'}});receipt(1);return;
 }
 if(JSON.stringify(x.message.content).includes('probe')&&!compacted){assistant({type:'tool_use',id:'call_'+id,name:'mcp__oms__read',input:{path:'src/main.ts'}},'tool_use');const result=await mcp();appendFileSync(root+'/results',JSON.stringify(result)+'\\n');if(mode==='multi'){assistant({type:'tool_use',id:'call_'+id+'_2',name:'mcp__oms__read',input:{path:'src/main.ts'}},'tool_use');const second=await mcp();appendFileSync(root+'/results',JSON.stringify(second)+'\\n');assistant({type:'text',text:JSON.stringify(second)});receipt(3);}else{assistant({type:'text',text:JSON.stringify(result)});receipt(2);}}
 else{assistant({type:'text',text:mode==='quotes-phrase'?'Explaining when the Prompt is too long error appears':JSON.stringify(x.message.content).includes('recall')?JSON.stringify(history[0]):'reply'});receipt(1);}
});input.on('close',()=>{bridge?.kill();process.exit(0);});
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${directory}:${originalPath}`;
  try {
    await run(directory);
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}
// Tool-free native turns never use IPC; stub only the unused listener, keeping CLI launch and streaming real.
async function toolFreeFixture(t: TestContext, mode: string, run: (directory: string) => Promise<void>) {
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    queueMicrotask(args.at(-1) as () => void);
    return this;
  });
  await fixture(mode, run);
}
const toolFreeContext = () =>
  normalizeContext({
    systemPrompt: 'Trusted OMS',
    tools: [],
    messages: [{ role: 'user', content: 'FIRST_SECRET', timestamp: 1 }],
  });
async function modelAndSession(
  statePath?: string,
  onSpawn?: (pid: number, cwd: string) => void,
  options: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } = {},
) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const native = await createClaudeCodeProvider(runtime, { statePath, onSpawn, ...options });
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel('claude-code', 'haiku');
  assert.ok(model);
  return { model, native, runtime };
}

function meteredNative(native: ClaudeCodeSession, tokens = 6_000_000, wallClockMs = 60_000) {
  const ledger = createBudgetLedger({
    caps: { tokens, spendMicroUsd: 1_000_000, wallClockMs },
    clock: Date.now,
    persist: () => {},
  });
  const stream = createMeteredStream({
    streamFunction: createClaudeCodeStream(native),
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 1024,
    logicalTurnId: () => 'native-retry-turn',
  });
  return { ledger, stream };
}

test('Claude Code ships the subscription context window, not the API 1M beta', async (t) =>
  toolFreeFixture(t, 'fine', async () => {
    const { model } = await modelAndSession();
    assert.equal(model.contextWindow, 200_000);
  }));

test('native prompt-too-long compacts into a fresh session and resends with task state', async (t) =>
  toolFreeFixture(t, 'prompt-too-long', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'stop', response.errorMessage);
      const launches = rows(join(directory, 'launch'));
      assert.equal(launches.length, 2, 'the overflow retry launches a fresh native session');
      const argsOf = (launch: { args: string[] }) => launch.args.join(' ');
      assert.match(argsOf(launches[0]!), /--session-id/);
      assert.match(argsOf(launches[1]!), /--session-id/);
      assert.doesNotMatch(argsOf(launches[1]!), /--resume/, 'compaction starts a new session, not a resume');
      assert.notEqual(launches[0]!.args.at(-1), launches[1]!.args.at(-1), 'the compacted session gets a new id');
      const input = rows(join(directory, 'input'));
      assert.equal(input.length, 2);
      const summary = input[1]!.message.content;
      assert.match(summary, /compacted by OMS/);
      assert.match(summary, /## TASK[\s\S]*FIRST_SECRET/, 'the summary keeps the task');
      assert.match(summary, /## NEXT STEP/, 'the summary keeps the next step');
      assert.equal(ledger.reservations().length, 1, 'the retry stays inside one reservation');
      assert.equal(ledger.snapshot().accounting, 'known');
    } finally {
      await native.close();
    }
  }));

test('native prompt-too-long exhaustion ends as named context-overflow with known accounting', async (t) =>
  toolFreeFixture(t, 'prompt-too-long-always', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(response.rawStopReason, 'claude-code-context-overflow');
      assert.match(response.errorMessage!, /context window/i);
      assert.doesNotMatch(response.errorMessage!, /broke off/);
      assert.equal(rows(join(directory, 'launch')).length, 3, 'one initial attempt plus two compaction retries');
      assert.equal(ledger.reservations().length, 1);
      assert.equal(ledger.snapshot().accounting, 'known', 'settled at the bound, never usage-unknown');
      assert.equal(ledger.snapshot().used.tokens, 328_000);
    } finally {
      await native.close();
    }
  }));

test('observed prompt near the subscription window compacts proactively', async (t) =>
  toolFreeFixture(t, 'big-prompt', async (directory) => {
    const { native, model } = await modelAndSession();
    const { stream } = meteredNative(native);
    try {
      const context = toolFreeContext();
      const first = await (await stream(model, context)).result();
      assert.equal(first.stopReason, 'stop', first.errorMessage);
      context.messages.push(first);
      // The fake reports a ~170k prompt, past 80% of the 200k subscription window.
      context.messages.push({ role: 'user', content: 'now finish SECOND_SECRET', timestamp: 2 });
      const second = await (await stream(model, context)).result();
      assert.equal(second.stopReason, 'stop', second.errorMessage);
      const launches = rows(join(directory, 'launch'));
      assert.equal(launches.length, 2, 'the second turn runs in a compacted session');
      assert.doesNotMatch(launches[1]!.args.join(' '), /--resume/);
      const input = rows(join(directory, 'input'));
      assert.equal(input.length, 2);
      assert.match(input[1]!.message.content, /compacted by OMS/);
      assert.match(input[1]!.message.content, /SECOND_SECRET/, 'the pending request rides the summary');
      assert.match(input[1]!.message.content, /## TASK[\s\S]*FIRST_SECRET/);
    } finally {
      await native.close();
    }
  }));

test('a successful reply quoting Prompt is too long is not an overflow', async (t) =>
  toolFreeFixture(t, 'quotes-phrase', async (directory) => {
    const { native, model } = await modelAndSession();
    const { stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'stop', response.errorMessage);
      assert.equal(rows(join(directory, 'launch')).length, 1, 'no compaction for a normal answer');
    } finally {
      await native.close();
    }
  }));

test('a synthetic Prompt is too long reply recovers through one compaction', async (t) =>
  toolFreeFixture(t, 'synthetic-once', async (directory) => {
    const { native, model } = await modelAndSession();
    const { stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'stop', response.errorMessage);
      assert.equal(rows(join(directory, 'launch')).length, 2);
      assert.match(rows(join(directory, 'input'))[1]!.message.content, /compacted by OMS/);
    } finally {
      await native.close();
    }
  }));

test('synthetic Prompt is too long replies exhaust as context-overflow', async (t) =>
  toolFreeFixture(t, 'synthetic-overflow', async (directory) => {
    const { native, model } = await modelAndSession();
    const { stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(response.rawStopReason, 'claude-code-context-overflow');
      assert.equal(rows(join(directory, 'launch')).length, 3);
    } finally {
      await native.close();
    }
  }));

test('the compacted request keeps a long user instruction intact', async (t) =>
  toolFreeFixture(t, 'prompt-too-long', async (directory) => {
    const { native, model } = await modelAndSession();
    const { stream } = meteredNative(native);
    try {
      const long = `fix it ${'x'.repeat(6_000)} TAIL_INSTRUCTION`;
      const response = await (
        await stream(
          model,
          normalizeContext({
            systemPrompt: 'Trusted OMS',
            tools: [],
            messages: [{ role: 'user', content: long, timestamp: 1 }],
          }),
        )
      ).result();
      assert.equal(response.stopReason, 'stop', response.errorMessage);
      const summary = rows(join(directory, 'input'))[1]!.message.content;
      assert.match(summary, /TAIL_INSTRUCTION/, 'the latest request is not cut at the excerpt bound');
    } finally {
      await native.close();
    }
  }));

test('compaction during a tool batch carries the pending result into the summary', async () =>
  fixture('big-prompt', async (directory) => {
    const { model, native } = await modelAndSession();
    const { stream } = meteredNative(native);
    let executed = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Use read',
        model,
        tools: [
          {
            name: 'read',
            label: 'Read',
            description: 'Read',
            parameters: Type.Object({ path: Type.String() }),
            async execute() {
              executed++;
              return { content: [{ type: 'text', text: 'REAL' }], details: undefined };
            },
          },
        ],
      },
      streamFn: stream,
    });
    try {
      await agent.prompt('probe');
      const input = rows(join(directory, 'input'));
      assert.equal(input.length, 2, 'the tool result rides the compaction summary, not a tool_result block');
      assert.match(input[1]!.message.content, /compacted by OMS/);
      assert.match(input[1]!.message.content, /PENDING TOOL RESULTS[\s\S]*src\/main\.ts[\s\S]*REAL/);
      assert.match(input[1]!.message.content, /## TASK[\s\S]*probe/);
      assert.equal(executed, 1, 'the carried result is enough; the tool is not re-executed');
      const responses = agent.state.messages.filter((message) => message.role === 'assistant');
      assert.equal(responses.at(-1)!.stopReason, 'stop', 'the compacted session finishes the turn');
    } finally {
      await native.close();
    }
  }));

test('a smaller native contextWindow receipt shrinks the effective window', async (t) =>
  toolFreeFixture(t, 'small-window mid-prompt', async (directory) => {
    const { native, model } = await modelAndSession();
    const { stream } = meteredNative(native);
    try {
      const context = toolFreeContext();
      const first = await (await stream(model, context)).result();
      assert.equal(first.stopReason, 'stop', first.errorMessage);
      context.messages.push(first);
      // The receipt advertised a 160k window; the ~130k observed prompt is past 80% of it,
      // so the next turn compacts even though the static bound is 200k.
      context.messages.push({ role: 'user', content: 'go on', timestamp: 2 });
      await (await stream(model, context)).result();
      assert.equal(rows(join(directory, 'launch')).length, 2);
      assert.match(rows(join(directory, 'input'))[1]!.message.content, /compacted by OMS/);
    } finally {
      await native.close();
    }
  }));

for (const mode of [
  'empty-then-good',
  'empty-second-then-good',
  'empty-success-then-good',
  'empty-success-no-blocks-then-good',
])
  test(`${mode} resumes the same native session with a separately admitted retry`, async (t) =>
    toolFreeFixture(t, mode, async (directory) => {
      const { native, model } = await modelAndSession();
      const { ledger, stream } = meteredNative(native);
      const transcript = toolFreeContext();
      try {
        if (mode === 'empty-second-then-good') {
          const first = await (await stream(model, transcript)).result();
          assert.equal(first.stopReason, 'stop', first.errorMessage);
          transcript.messages.push(first, { role: 'user', content: 'second', timestamp: 2 });
        }
        const response = await (await stream(model, transcript)).result();
        assert.equal(response.stopReason, 'stop', response.errorMessage);
        assert.equal(ledger.snapshot().accounting, 'known');
        assert.equal(ledger.reservations().length, mode === 'empty-second-then-good' ? 3 : 2);
        const launches = rows(join(directory, 'launch'));
        assert.equal(launches.length, 2);
        const sessionId = native.status().sessionId;
        assert.equal(launches[0].args[launches[0].args.indexOf('--session-id') + 1], sessionId);
        assert.equal(launches[1].args[launches[1].args.indexOf('--resume') + 1], sessionId);
        const input = rows(join(directory, 'input'));
        assert.equal(input.length, mode === 'empty-second-then-good' ? 3 : 2);
        assert.deepEqual(input.at(-1).message, input.at(-2).message, 'the original input is retried unchanged');
        assert.ok(ledger.snapshot().used.tokens >= 328_000, 'the failed attempt retains its full bound');
      } finally {
        await native.close();
      }
    }));

test('three empty native failures stop with unknown usage', async (t) =>
  toolFreeFixture(t, 'empty', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(rows(join(directory, 'input')).length, 3);
      assert.equal(ledger.reservations().length, 3);
      assert.equal(ledger.snapshot().accounting, 'unknown');
      assert.match(response.errorMessage!, /counted at its maximum cost/);
    } finally {
      await native.close();
    }
  }));

for (const mode of [
  'auth-failure',
  'usage-limit',
  'auth-401',
  'auth-403',
  'auth-403-forbidden',
  'auth-unauthorized',
  'auth-forbidden',
])
  test(`${mode} never retries native inference`, async (t) =>
    toolFreeFixture(t, mode, async (directory) => {
      const { native, model } = await modelAndSession();
      const { ledger, stream } = meteredNative(native);
      try {
        assert.equal((await (await stream(model, toolFreeContext())).result()).stopReason, 'error');
        assert.equal(rows(join(directory, 'input')).length, 1);
        assert.equal(ledger.reservations().length, 1);
        assert.equal(ledger.snapshot().accounting, 'unknown');
      } finally {
        await native.close();
      }
    }));

for (const mode of ['hang', 'exit-empty'])
  test(`${mode} retries only twice before preserving unknown usage`, async (t) =>
    toolFreeFixture(t, mode, async (directory) => {
      const { native, model } = await modelAndSession();
      const { ledger, stream } = meteredNative(native);
      try {
        const response = await (await stream(model, toolFreeContext(), { timeoutMs: 150 })).result();
        assert.equal(response.stopReason, 'error');
        assert.equal(rows(join(directory, 'input')).length, 3);
        assert.equal(ledger.reservations().length, 3);
        assert.equal(ledger.snapshot().accounting, 'unknown');
      } finally {
        await native.close();
      }
    }));

for (const limit of ['cancel', 'time', 'tokens'])
  test(`${limit} stops an empty native retry before another dispatch`, async (t) =>
    toolFreeFixture(t, 'empty', async (directory) => {
      const { native, model } = await modelAndSession();
      const { ledger, stream } = meteredNative(
        native,
        limit === 'tokens' ? 328_000 : 6_000_000,
        limit === 'time' ? 1_000 : 60_000,
      );
      const controller = new AbortController();
      try {
        const response = await (
          await stream(model, toolFreeContext(), {
            signal: controller.signal,
            onPayload: () => {
              if (limit === 'cancel') setTimeout(() => controller.abort(), 150);
            },
          })
        ).result();
        assert.equal(response.stopReason, limit === 'tokens' ? 'error' : 'aborted');
        assert.equal(rows(join(directory, 'input')).length, 1);
        assert.equal(ledger.reservations().length, 1);
        if (limit === 'cancel') {
          assert.equal(
            response.errorMessage,
            'Request cancelled during retry backoff; usage was counted at its maximum cost.',
          );
          assert.equal(ledger.snapshot().accounting, 'known');
          assert.deepEqual(ledger.snapshot().pendingDispatchIds, []);
          assert.equal(ledger.snapshot().used.tokens, 328_000);
        }
      } finally {
        await native.close();
      }
    }));

test('an empty continuation resumes after the delivered tool result without replaying the tool', async (t) => {
  let server: Server;
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    server = this;
    queueMicrotask(args.at(-1) as () => void);
    return this;
  });
  await fixture('empty-after-tool', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    let executed = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Use read',
        model,
        tools: [
          {
            name: 'read',
            label: 'Read',
            description: 'Read',
            parameters: Type.Object({ path: Type.String() }),
            async execute() {
              executed++;
              return { content: [{ type: 'text', text: 'REAL' }], details: undefined };
            },
          },
        ],
      },
      streamFn: (selectedModel, transcript, options) =>
        stream(selectedModel, transcript, {
          ...options,
          onPayload: (payload, payloadModel) => {
            if (!existsSync(join(directory, 'input'))) {
              const socket = new Duplex({
                read() {},
                write(chunk, _encoding, done) {
                  writeFileSync(join(directory, 'delivered'), chunk);
                  done();
                },
              });
              server.emit('connection', socket);
              socket.push(JSON.stringify({ name: 'read', arguments: { path: 'src/main.ts' } }) + '\n');
            }
            return options?.onPayload?.(payload, payloadModel);
          },
        }),
    });
    try {
      await agent.prompt('probe');
      const responses = agent.state.messages.filter((message) => message.role === 'assistant');
      assert.equal(responses.at(-1)!.stopReason, 'stop', responses.at(-1)!.errorMessage);
      assert.equal(executed, 1);
      assert.equal(rows(join(directory, 'results')).length, 1);
      const input = rows(join(directory, 'input'));
      assert.equal(input.length, 2);
      assert.deepEqual(input[0].message.content, [{ type: 'text', text: 'probe' }]);
      assert.equal(
        input[1].message.content,
        'Your previous reply came back empty. Continue the task from where you stopped; the earlier tool results are already in this conversation.',
      );
      assert.equal(ledger.reservations().length, 3);
      assert.equal(ledger.snapshot().accounting, 'known');
      const launches = rows(join(directory, 'launch'));
      assert.equal(launches.length, 2);
      assert.equal(launches[1].args[launches[1].args.indexOf('--resume') + 1], native.status().sessionId);
    } finally {
      await native.close();
    }
  });
});

test('environment is scrubbed and API auth cannot become a subscription', async () => {
  const env = claudeCodeEnvironment({
    HOME: '/home/user',
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'never-forward',
    NODE_OPTIONS: '--require /attacker',
    CLAUDE_CODE_OAUTH_TOKEN: 'never-forward',
  });
  assert.equal(env.HOME, '/home/user');
  for (const key of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(env[key], undefined);
  await fixture('api-auth', async () => assert.equal((await inspectClaudeCode()).configured, false));
});
test('OMS_CLAUDE_CODE_HOME replaces the native home and is not itself forwarded', () => {
  const env = claudeCodeEnvironment({ HOME: '/home/user', PATH: '/usr/bin', OMS_CLAUDE_CODE_HOME: '/run/claude-home' });
  assert.equal(env.HOME, '/run/claude-home');
  assert.equal(env.OMS_CLAUDE_CODE_HOME, undefined);
});
test('native effort defaults to high in launch argv and request metadata', async (t) =>
  toolFreeFixture(t, 'ok', async (directory) => {
    const previous = process.env.OMS_CLAUDE_EFFORT;
    delete process.env.OMS_CLAUDE_EFFORT;
    const { native, model } = await modelAndSession();
    try {
      let payload: unknown;
      const response = await native
        .stream(model, toolFreeContext(), {
          onPayload: (value) => {
            payload = value;
          },
        })
        .result();
      assert.equal(response.stopReason, 'stop', response.errorMessage);
      const args = rows(join(directory, 'launch'))[0].args;
      assert.equal(args[args.indexOf('--effort') + 1], 'high');
      assert.equal((payload as { effort: string }).effort, 'high');
    } finally {
      await native.close();
      if (previous === undefined) delete process.env.OMS_CLAUDE_EFFORT;
      else process.env.OMS_CLAUDE_EFFORT = previous;
    }
  }));
for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const)
  test(`explicit native effort ${effort} reaches launch argv`, async (t) =>
    toolFreeFixture(t, 'ok', async (directory) => {
      const { native, model } = await modelAndSession(undefined, undefined, { effort });
      try {
        const response = await native.stream(model, toolFreeContext()).result();
        assert.equal(response.stopReason, 'stop', response.errorMessage);
        const args = rows(join(directory, 'launch'))[0].args;
        assert.equal(args[args.indexOf('--effort') + 1], effort);
      } finally {
        await native.close();
      }
    }));
test('environment effort changes the native configuration identity and restarts the CLI', async (t) =>
  toolFreeFixture(t, 'ok', async (directory) => {
    const previous = process.env.OMS_CLAUDE_EFFORT;
    process.env.OMS_CLAUDE_EFFORT = 'medium';
    const { native, model } = await modelAndSession();
    const transcript = toolFreeContext();
    try {
      const first = await native.stream(model, transcript).result();
      assert.equal(first.stopReason, 'stop', first.errorMessage);
      transcript.messages.push(first, { role: 'user', content: 'second', timestamp: 2 });
      process.env.OMS_CLAUDE_EFFORT = 'max';
      const second = await native.stream(model, transcript).result();
      assert.equal(second.stopReason, 'stop', second.errorMessage);
      transcript.messages.push(second, { role: 'user', content: 'third', timestamp: 3 });
      assert.equal((await native.stream(model, transcript).result()).stopReason, 'stop');
      const launches = rows(join(directory, 'launch'));
      assert.equal(launches.length, 2, 'effort changes restart the process; unchanged effort reuses it');
      assert.notEqual(launches[0].pid, launches[1].pid);
      for (const [i, effort] of ['medium', 'max'].entries()) {
        const args = launches[i].args;
        assert.equal(args[args.indexOf('--effort') + 1], effort);
      }
    } finally {
      await native.close();
      if (previous === undefined) delete process.env.OMS_CLAUDE_EFFORT;
      else process.env.OMS_CLAUDE_EFFORT = previous;
    }
  }));
test('invalid environment effort is rejected before starting native inference', () => {
  const previous = process.env.OMS_CLAUDE_EFFORT;
  process.env.OMS_CLAUDE_EFFORT = 'extreme';
  try {
    assert.throws(() => new ClaudeCodeSession(), /OMS_CLAUDE_EFFORT/);
  } finally {
    if (previous === undefined) delete process.env.OMS_CLAUDE_EFFORT;
    else process.env.OMS_CLAUDE_EFFORT = previous;
  }
});
test('native turn idle deadline resets on stream events throughout a long response', async (t) =>
  toolFreeFixture(t, 'active-turn', async () => {
    const { native, model } = await modelAndSession();
    try {
      const response = await native.stream(model, toolFreeContext(), { timeoutMs: 400 }).result();
      assert.equal(response.stopReason, 'stop', response.errorMessage);
      assert.equal(
        response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
        'working'.repeat(4),
      );
    } finally {
      await native.close();
    }
  }));
test('native turn still times out after stream activity stops', async (t) =>
  toolFreeFixture(t, 'active-then-idle', async () => {
    const { native, model } = await modelAndSession();
    try {
      const start = Date.now();
      const response = await native.stream(model, toolFreeContext(), { timeoutMs: 400 }).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(
        response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
        'working'.repeat(4),
      );
      assert.ok(Date.now() - start < 4000, 'silence is still bounded');
      assert.notEqual(native.status().state, 'ready');
    } finally {
      await native.close();
    }
  }));
test('native provider exposes Sonnet, Opus and Haiku through installed CLI subscription without inference', async () =>
  fixture('ok', async (directory) => {
    const { native, runtime } = await modelAndSession();
    try {
      for (const alias of ['sonnet', 'opus', 'haiku']) {
        const model = runtime.getModel('claude-code', alias);
        assert.ok(model);
        assert.equal(model.api, 'claude-code');
        assert.equal(model.baseUrl, 'claude-code://local');
        assert.match(model.name, /subscription/);
      }
      assert.equal(existsSync(join(directory, 'launch')), false);
    } finally {
      await native.close();
    }
  }));
test('two user messages use one process, new input only, and partial text deltas', async () =>
  fixture('ok', async (directory) => {
    const { model, native } = await modelAndSession();
    const transcript = context();
    try {
      const events = [];
      const stream = native.stream(model, transcript);
      for await (const event of stream) events.push(event);
      const first = await stream.result();
      assert.equal(first.stopReason, 'stop');
      assert.ok(events.some((e) => e.type === 'text_delta'));
      transcript.messages.push(first, { role: 'user', content: 'recall', timestamp: 2 });
      const second = await native.stream(model, transcript).result();
      assert.match(JSON.stringify(second.content), /FIRST_SECRET/);
      assert.equal(rows(join(directory, 'launch')).length, 1);
      assert.equal(rows(join(directory, 'input'))[1].message.content, 'recall');
      const args = rows(join(directory, 'launch'))[0].args;
      assert.ok(!args.includes('--no-session-persistence'));
      assert.ok(!args.includes('--max-turns'));
    } finally {
      await native.close();
    }
  }));
for (const deny of [false, true])
  test(`ordinary Pi execution sends real MCP ${deny ? 'denial' : 'result'} once`, async () =>
    fixture('ok', async (directory) => {
      const { model, native } = await modelAndSession();
      let executed = 0,
        guarded = 0;
      const agent = new Agent({
        initialState: {
          systemPrompt: 'Use read',
          model,
          tools: [
            {
              name: 'read',
              label: 'Read',
              description: 'Read',
              parameters: Type.Object({ path: Type.String() }),
              async execute() {
                executed++;
                return { content: [{ type: 'text', text: 'ACTUAL_NONCE' }], details: undefined };
              },
            },
          ],
        },
        streamFn: createClaudeCodeStream(native),
        beforeToolCall: async ({ args }) => {
          guarded++;
          (args as { path: string }).path = '/work/src/main.ts';
          return deny ? { block: true, reason: 'POLICY_DENIED' } : undefined;
        },
      });
      try {
        await agent.prompt('probe');
        assert.equal(guarded, 1, JSON.stringify(agent.state.messages));
        assert.equal(executed, deny ? 0 : 1);
        const result = rows(join(directory, 'results'))[0];
        assert.equal(result.isError, deny);
        assert.match(JSON.stringify(result.content), deny ? /POLICY_DENIED/ : /ACTUAL_NONCE/);
        const responses = agent.state.messages.filter((x) => x.role === 'assistant');
        assert.equal(responses.length, 2);
        assert.equal(responses[0]!.usage.totalTokens + responses[1]!.usage.totalTokens, 200);
        assert.equal(rows(join(directory, 'input')).length, 1);
      } finally {
        await native.close();
      }
    }));
test('pending tool cannot trigger native inference before continuation admission; restart blocks unsafe replay', async () =>
  fixture('ok', async (directory) => {
    const path = join(directory, 'state.json'),
      { model, native } = await modelAndSession(path);
    assert.equal((await native.stream(model, context('probe')).result()).stopReason, 'toolUse');
    await native.close();
    const resumed = new ClaudeCodeSession({ statePath: path });
    try {
      assert.match(resumed.status().detail!, /interrupted native tool/i);
      assert.match(
        resumed.status().detail!,
        /select Claude Code in \/model.*\/clear.*clear the OMS conversation view; task files and verification are retained/,
      );
      assert.doesNotMatch(resumed.status().detail!, /\/claude/);
      const response = await resumed.stream(model, context('next')).result();
      assert.equal(response.stopReason, 'error');
      assert.match(response.errorMessage!, /tools will not be replayed/);
      assert.match(response.errorMessage!, /\/clear.*clear the OMS conversation view/);
      assert.doesNotMatch(response.errorMessage!, /\/claude/);
      assert.equal(rows(join(directory, 'launch')).length, 1);
      await resumed.reset();
      assert.notEqual(resumed.status().sessionId, native.status().sessionId);
    } finally {
      await resumed.close();
    }
  }));
test('reopen resumes exact durable identity, reset isolates native history', async () =>
  fixture('ok', async (directory) => {
    const path = join(directory, 'state.json'),
      { model, native } = await modelAndSession(path),
      transcript = context();
    const first = await native.stream(model, transcript).result(),
      id = native.status().sessionId;
    await native.close();
    const resumed = new ClaudeCodeSession({ statePath: path });
    try {
      transcript.messages.push(first, { role: 'user', content: 'recall', timestamp: 2 });
      const second = await resumed.stream(model, transcript).result();
      assert.equal(second.stopReason, 'stop');
      assert.match(JSON.stringify(second.content), /FIRST_SECRET/);
      assert.equal(resumed.status().sessionId, id);
      assert.ok(rows(join(directory, 'launch'))[1].args.includes('--resume'));
      await resumed.reset();
      assert.notEqual(resumed.status().sessionId, id);
      transcript.messages.push(second, { role: 'user', content: 'fresh', timestamp: 3 });
      assert.equal((await resumed.stream(model, transcript).result()).stopReason, 'stop');
      assert.deepEqual(JSON.parse(readFileSync(join(directory, `${resumed.status().sessionId}.json`), 'utf8')), [
        'fresh',
      ]);
    } finally {
      await resumed.close();
    }
  }));
for (const mode of ['builtin', 'fallback', 'duplicate-start', 'larger', 'smaller', 'overflow'])
  test(`${mode} fails closed`, async () =>
    fixture(mode, async () => {
      const { model, native } = await modelAndSession();
      try {
        const response = await native.stream(model, context()).result();
        assert.equal(response.stopReason, 'error');
        assert.match(response.errorMessage!, /No API-key fallback/);
        assert.match(native.status().detail!, /\/clear.*clear the OMS conversation view/);
        assert.doesNotMatch(native.status().detail!, /\/claude/);
      } finally {
        await native.close();
      }
    }));
test('cancellation reaps persistent native process and MCP bridge', async () =>
  fixture('hang', async () => {
    const { model, native } = await modelAndSession();
    const controller = new AbortController(),
      start = Date.now(),
      running = native.stream(model, context(), { signal: controller.signal }).result();
    setTimeout(() => controller.abort(), 150);
    try {
      assert.equal((await running).stopReason, 'aborted');
      await native.disconnect();
      assert.ok(Date.now() - start < 3000);
      assert.notEqual(native.status().state, 'ready');
    } finally {
      await native.close();
    }
  }));

test('duplicate native receipts never double count and poison the thread before another request', async () =>
  fixture('duplicate-receipt', async () => {
    const { model, native } = await modelAndSession();
    try {
      const first = await native.stream(model, context()).result();
      assert.ok(['stop', 'error'].includes(first.stopReason));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(native.status().detail!, /verification|receipt/);
      const next = context('next');
      assert.equal((await native.stream(model, next).result()).stopReason, 'error');
    } finally {
      await native.close();
    }
  }));

for (const mode of ['larger', 'smaller'])
  test(`aggregate ${mode} than settled handoff stays unknown`, async () =>
    fixture(mode, async () => {
      const { model, native } = await modelAndSession();
      const ledger = createBudgetLedger({
        caps: { tokens: 4000000, spendMicroUsd: 1000000, wallClockMs: 60000 },
        clock: Date.now,
        persist: () => {},
      });
      const stream = createMeteredStream({
        streamFunction: createClaudeCodeStream(native),
        ledger,
        allocate: createDispatchAllocator(),
        maxOutputTokens: 1024,
        logicalTurnId: () => 'one-user-turn',
      });
      const agent = new Agent({
        initialState: {
          systemPrompt: 'Use read',
          model,
          tools: [
            {
              name: 'read',
              label: 'Read',
              description: 'Read',
              parameters: Type.Object({ path: Type.String() }),
              async execute() {
                return { content: [{ type: 'text', text: 'REAL' }], details: undefined };
              },
            },
          ],
        },
        streamFn: stream,
      });
      try {
        await agent.prompt('probe');
        assert.equal(ledger.snapshot().accounting, 'unknown');
        const responses = agent.state.messages.filter((message) => message.role === 'assistant');
        assert.equal(responses.length, 2);
        assert.equal(responses[0]!.stopReason, 'toolUse');
        assert.equal(responses[1]!.stopReason, 'error');
        assert.equal(responses[0]!.usage.totalTokens, 100);
        assert.equal(ledger.reservations().length, 2);
      } finally {
        await native.close();
      }
    }));
test('insufficient next reservation never releases a pending real tool result', async () =>
  fixture('ok', async (directory) => {
    const { model, native } = await modelAndSession();
    const ledger = createBudgetLedger({
      caps: { tokens: 328000, spendMicroUsd: 1000000, wallClockMs: 60000 },
      clock: Date.now,
      persist: () => {},
    });
    const stream = createMeteredStream({
      streamFunction: createClaudeCodeStream(native),
      ledger,
      allocate: createDispatchAllocator(),
      maxOutputTokens: 1024,
      logicalTurnId: () => 'bounded-turn',
    });
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Use read',
        model,
        tools: [
          {
            name: 'read',
            label: 'Read',
            description: 'Read',
            parameters: Type.Object({ path: Type.String() }),
            async execute() {
              return { content: [{ type: 'text', text: 'REAL' }], details: undefined };
            },
          },
        ],
      },
      streamFn: stream,
    });
    try {
      await agent.prompt('probe');
      assert.equal(ledger.snapshot().accounting, 'known');
      assert.equal(ledger.reservations().length, 1);
      assert.throws(() => readFileSync(join(directory, 'results'), 'utf8'));
      assert.equal(rows(join(directory, 'input')).length, 1);
    } finally {
      await native.close();
    }
  }));
test('native checkpoint cannot be copied into another OMS conversation', async () =>
  fixture('ok', async (directory) => {
    const path = join(directory, 'state.json'),
      { model, native } = await modelAndSession(path);
    try {
      await native.stream(model, context()).result();
      const other = join(directory, 'other.json');
      writeFileSync(other, readFileSync(path), { mode: 0o600 });
      assert.throws(() => new ClaudeCodeSession({ statePath: other }), /Invalid native session state/);
    } finally {
      await native.close();
    }
  }));

test('successive native tool batches preserve IDs and do not race previous MCP results', async () =>
  fixture('multi', async (directory) => {
    const { model, native } = await modelAndSession();
    let executed = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Use read',
        model,
        tools: [
          {
            name: 'read',
            label: 'Read',
            description: 'Read',
            parameters: Type.Object({ path: Type.String() }),
            async execute() {
              executed++;
              return { content: [{ type: 'text', text: `REAL_${executed}` }], details: undefined };
            },
          },
        ],
      },
      streamFn: createClaudeCodeStream(native),
    });
    try {
      await agent.prompt('probe');
      assert.equal(executed, 2);
      const results = rows(join(directory, 'results'));
      assert.equal(results.length, 2);
      assert.match(JSON.stringify(results[0]), /REAL_1/);
      assert.match(JSON.stringify(results[1]), /REAL_2/);
      const messages = agent.state.messages.filter((message) => message.role === 'assistant');
      assert.equal(messages.length, 3);
      assert.equal(messages[2]!.stopReason, 'stop');
      assert.equal(
        messages.reduce((sum, message) => sum + message.usage.totalTokens, 0),
        300,
      );
    } finally {
      await native.close();
    }
  }));

test('a missing native session fails exact resume without creating another identity', async () =>
  fixture('ok', async (directory) => {
    const path = join(directory, 'state.json'),
      { model, native } = await modelAndSession(path);
    await native.stream(model, context()).result();
    await native.close();
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.sessionId = randomUUID();
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
    const resumed = new ClaudeCodeSession({ statePath: path });
    try {
      const response = await resumed.stream(model, context('recall')).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(resumed.status().sessionId, state.sessionId);
      const launches = rows(join(directory, 'launch'));
      assert.equal(launches.length, 2);
      assert.ok(launches[1].args.includes('--resume'));
      assert.ok(launches[1].args.includes(state.sessionId));
    } finally {
      await resumed.close();
    }
  }));

test('cancelled SIGTERM-resistant native process is force-reaped before stream error is returned', async () =>
  fixture('stubborn', async (directory) => {
    const pids: number[] = [];
    const { model, native } = await modelAndSession(undefined, (pid) => pids.push(pid));
    const controller = new AbortController();
    let sawNative = false;
    const stream = native.stream(model, context(), { signal: controller.signal });
    const timeout = setTimeout(() => controller.abort(), 2000);
    for await (const event of stream) {
      if (event.type === 'start') {
        sawNative = true;
        const waitForBridge = () => {
          if (pids.length >= 2) controller.abort();
          else setTimeout(waitForBridge, 10).unref();
        };
        setTimeout(waitForBridge, 50).unref();
      }
    }
    clearTimeout(timeout);
    try {
      assert.ok(sawNative);
      assert.equal((await stream.result()).stopReason, 'aborted');
      assert.ok(pids.length >= 2, 'both CLI and MCP were tracked');
      for (const pid of pids) assert.throws(() => process.kill(pid, 0));
      const args = rows(join(directory, 'launch'))[0].args;
      const declarations = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.oms.args[1];
      assert.equal(existsSync(dirname(declarations)), false, 'owned IPC directory is removed before returning');
      assert.notEqual(native.status().state, 'ready');
    } finally {
      await native.close();
    }
  }));
