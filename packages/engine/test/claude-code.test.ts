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
import { InMemoryCredentialStore, isRetryableAssistantError, normalizeContext, Type } from '@earendil-works/pi-ai';
import { createBudgetLedger } from '@oms/core';
import { createDispatchAllocator } from '@oms/core/dispatch';
import { createChatFixture } from '../test-support/chat-fixture.ts';
import { createChatSession } from '../src/runtime/chat-session.ts';
import { createContextTrimmer } from '../src/runtime/context-trim.ts';
import { createMeteredStream } from '../src/runtime/usage.ts';
import {
  ClaudeCodeSession,
  claudeCodeEnvironment,
  createClaudeCodeProvider,
  createClaudeCodeStream,
  getClaudeCodeStatus,
  inspectClaudeCode,
  runClaudeCode,
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
const authChecks = (directory: string) =>
  existsSync(join(directory, 'auth-count')) ? rows(join(directory, 'auth-count')).length : 0;
async function fixture(mode: string, run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'oms-native-test-'));
  const originalPath = process.env.PATH;
  writeFileSync(
    join(directory, 'claude'),
    `#!${process.execPath}
import{appendFileSync,existsSync,readFileSync,writeFileSync}from'node:fs';
import{spawn}from'node:child_process';import{createInterface}from'node:readline';
const mode=${JSON.stringify(mode)},root=${JSON.stringify(directory)},args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
if(args[0]==='auth'){if(mode==='hang-auth'){process.on('SIGTERM',()=>{appendFileSync(root+'/auth-killed',JSON.stringify({uptime:process.uptime()})+'\\n');process.exit(0);});}appendFileSync(root+'/auth-count','{}\\n');if(mode.includes('auth-fails-once-after-input')&&existsSync(root+'/input')&&!existsSync(root+'/auth-failed')){writeFileSync(root+'/auth-failed','1');process.exit(1);}if(mode==='hang-auth'){setInterval(()=>{},1000);await new Promise(()=>{});}else{console.log(JSON.stringify({loggedIn:true,authMethod:mode==='api-auth'?'api_key':'claude.ai',apiProvider:'firstParty'}));process.exit(0);}}
const id=get(args.includes('--resume')?'--resume':'--session-id');appendFileSync(root+'/launch',JSON.stringify({args,pid:process.pid})+'\\n');
const file=root+'/'+id+'.json';if(args.includes('--resume')&&!existsSync(file))process.exit(1);
const history=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[],decl=JSON.parse(get('--mcp-config')).mcpServers.oms;
let bridge,response,seq=0;if(decl&&mode!=='empty-after-tool'){bridge=spawn(decl.command,decl.args,{stdio:['pipe','pipe','ignore']});createInterface({input:bridge.stdout}).on('line',line=>{const x=JSON.parse(line);if(x.id===response?.id){const done=response;response=undefined;done.resolve(x.result);}});}
const toolArgs=mode.includes('big-args')?{path:'src/'+'p'.repeat(600)+'.ts'}:{path:'src/main.ts'};
const mcp=()=>new Promise(resolve=>{if(mode==='empty-after-tool'){const timer=setInterval(()=>{if(existsSync(root+'/delivered')){clearInterval(timer);resolve(JSON.parse(readFileSync(root+'/delivered','utf8')));}},5);return;}response={id:++seq,resolve};bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:seq,method:'tools/call',params:{name:'read',arguments:toolArgs}})+'\\n');});
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
 const r=mode==='synthetic-overflow'||mode==='synthetic-once'&&!String(history.at(-1)).includes('compacted by OMS')?'Prompt is too long':mode==='synthetic-period'?'Prompt is too long.':mode==='quotes-phrase'?'Explaining when the Prompt is too long error appears':undefined;
 const x={type:'result',subtype:'success',is_error:false,usage:u,result:r,modelUsage:{'claude-haiku-5-5':{provider:'firstParty',contextWindow:mode.includes('small-window')?160000:1000000,maxOutputTokens:mode==='small-output'?16000:128000},...(mode==='fallback'?{'other':{}}:{})}};emit(x);if(mode==='duplicate-receipt')emit(x);
}
const input=createInterface({input:process.stdin});input.on('line',async line=>{
 const x=JSON.parse(line);if(x.type==='control_request'){emit({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}});return;}const throttled=mode==='rate-limit-then-good'&&!existsSync(root+'/throttled');if(throttled)writeFileSync(root+'/throttled','');else history.push(x.message.content);writeFileSync(file,JSON.stringify(history));writeFileSync(root+'/history',JSON.stringify(history));appendFileSync(root+'/input',JSON.stringify(x)+'\\n');
 emit({type:'system',subtype:'init',tools:mode==='builtin'?['Bash']:tools,mcp_servers:[{name:'oms',status:'connected'}]});if(mode==='hang'||mode==='stubborn')return;
 if(mode==='exit-empty'){process.stdout.write('',()=>process.exit(1));return;}
 if(emptySuccess()){assistant({type:'text',text:''});receipt(1);return;}
 const authError={'auth-401':'API Error: 401','auth-403':'API Error: 403','auth-403-forbidden':'API Error: 403 Forbidden','auth-unauthorized':'Unauthorized','auth-forbidden':'Forbidden'}[mode];
 const compacted=typeof x.message.content==='string'&&x.message.content.includes('compacted by OMS');
 if(mode==='prompt-too-long-always'||mode==='prompt-too-long-always-with-usage'||mode==='prompt-too-long-usage-then-silent'||mode==='prompt-too-long-silent-then-usage'||mode.split(' ').includes('prompt-too-long')&&!compacted){
  const launches=readFileSync(root+'/launch','utf8').trim().split('\\n').length,u={input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};
  if(mode==='prompt-too-long-always-with-usage'||mode==='prompt-too-long-usage-then-silent'&&launches===1||mode==='prompt-too-long-silent-then-usage'&&launches>1){u.input_tokens=20*launches;u.output_tokens=10*launches;u.cache_read_input_tokens=30*launches;u.cache_creation_input_tokens=40*launches;}
  if(mode==='prompt-too-long-usage-then-silent'&&launches>1||mode==='prompt-too-long-silent-then-usage'&&launches===1)emit({type:'stream_event',event:{type:'message_start',message:{id:'msg_'+ ++n,model:'claude-haiku-5-5',usage}}});
  emit({type:'result',subtype:'error_during_execution',is_error:true,result:'',usage:u,modelUsage:{},errors:['Prompt is too long']});return;
 }
 const refusalError={'limit-429':'API Error: 429','rate-limit-then-good':throttled?'API Error: 429':undefined,'insufficient-quota':'insufficient_quota: quota exceeded','account-network':'network stream to account service disconnected'}[mode];
 if(authError||refusalError||mode==='empty'||mode==='empty-then-good'&&history.length===1||mode==='empty-second-then-good'&&history.length===2||mode==='auth-failure'||mode==='usage-limit'||mode==='usage-limit-reset'||mode==='usage-limit-reset-multiline'){
  emit({type:'result',subtype:'error_during_execution',is_error:true,result:'',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0},modelUsage:{},errors:authError?[authError]:refusalError?[refusalError]:mode==='auth-failure'?['authentication failed after stream error']:mode==='usage-limit'?["You've hit your limit after a server error"]:mode==='usage-limit-reset'?["You've hit your usage limit. Your limit resets at 3:00 PM (UTC)"]:mode==='usage-limit-reset-multiline'?["You've hit your usage limit. Your limit resets at 3pm PT\\nDo not keep sending."]:[]});return;
 }
 if(mode==='refuse-then-good'&&!existsSync(root+'/refused')){writeFileSync(root+'/refused','');emit({type:'result',subtype:'error_during_execution',is_error:true,result:'',usage,modelUsage:{},errors:['Request was refused']});return;}
 if(mode==='refuse-unsent'&&!existsSync(root+'/refused')){writeFileSync(root+'/refused','');emit({type:'result',subtype:'error_max_turns',is_error:true,result:'',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0},modelUsage:{},errors:['Request was refused']});return;}
 if(mode==='usage-then-zero-error'){assistant({type:'text',text:'partial'});emit({type:'result',subtype:'error_during_execution',is_error:true,result:'',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0},modelUsage:{},errors:['execution failed']});return;}
 if(mode==='empty-after-tool'||mode==='auth-after-tool'){
  if(history.length===1){assistant({type:'tool_use',id:'call_'+id,name:'mcp__oms__read',input:toolArgs},'tool_use');const result=await mcp();appendFileSync(root+'/results',JSON.stringify(result)+'\\n');emit({type:'result',subtype:'error_during_execution',is_error:true,usage,errors:mode==='auth-after-tool'?['API Error: 401']:[]});}
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
 if(JSON.stringify(x.message.content).includes('probe')&&!compacted){assistant({type:'tool_use',id:'call_'+id,name:'mcp__oms__read',input:toolArgs},'tool_use');const result=await mcp();appendFileSync(root+'/results',JSON.stringify(result)+'\\n');if(mode==='multi'){assistant({type:'tool_use',id:'call_'+id+'_2',name:'mcp__oms__read',input:{path:'src/main.ts'}},'tool_use');const second=await mcp();appendFileSync(root+'/results',JSON.stringify(second)+'\\n');assistant({type:'text',text:JSON.stringify(second)});receipt(3);}else{assistant({type:'text',text:JSON.stringify(result)});receipt(2);}}
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

function meteredNative(native: ClaudeCodeSession, tokens = 6_000_000, wallClockMs = 60_000, interactive = false) {
  const ledger = createBudgetLedger({
    caps: { tokens, spendMicroUsd: 1_000_000, wallClockMs },
    clock: Date.now,
    persist: () => {},
    ...(interactive ? { executionMode: 'interactive' as const } : {}),
  });
  if (interactive) assert.equal(ledger.beginOperation('native-chat').ok, true);
  const stream = createMeteredStream({
    streamFunction: createClaudeCodeStream(native),
    ledger,
    allocate: createDispatchAllocator(),
    maxOutputTokens: 1024,
    logicalTurnId: () => 'native-retry-turn',
    executionMode: interactive ? 'interactive' : undefined,
  });
  return { ledger, stream };
}

test('Claude Code registers catalog limits; the subscription window only bounds compaction', async (t) =>
  toolFreeFixture(t, 'fine', async () => {
    const { model, runtime } = await modelAndSession();
    assert.equal(model.contextWindow, runtime.getModel('anthropic', 'claude-haiku-5-5')!.contextWindow);
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
      // Every overflow receipt reported zero usage: each attempt settles at what it observed.
      assert.equal(ledger.snapshot().accounting, 'known', 'settled at the receipt usage, never usage-unknown');
      assert.equal(ledger.snapshot().used.tokens, 0);
      assert.match(response.errorMessage!, /usage the provider reported was counted/);
    } finally {
      await native.close();
    }
  }));

test('a resend after a usage-carrying overflow banks each session’s provable usage', async (t) =>
  toolFreeFixture(t, 'prompt-too-long-always-with-usage', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(response.rawStopReason, 'claude-code-context-overflow');
      assert.equal(rows(join(directory, 'launch')).length, 3, 'one initial attempt plus two compaction retries');
      assert.equal(ledger.reservations().length, 1);
      assert.equal(ledger.snapshot().accounting, 'known');
      // Each fresh session's receipt reports only its own attempt: 100, 200 and 300 are banked
      // across the resends instead of the last publish replacing the superseded attempts' spend.
      assert.equal(ledger.snapshot().used.tokens, 600);
      assert.match(response.errorMessage!, /usage the provider reported was counted/);
    } finally {
      await native.close();
    }
  }));

test('a resend after an unprovable attempt keeps the bound even when later receipts report usage', async (t) =>
  toolFreeFixture(t, 'prompt-too-long-silent-then-usage', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(response.rawStopReason, 'claude-code-context-overflow');
      assert.equal(rows(join(directory, 'launch')).length, 3);
      // The first attempt streamed usage its receipt could not prove; the later sessions' provable
      // deltas still cannot account for it, so the dispatch settles at the reservation bound.
      assert.equal(ledger.snapshot().accounting, 'known');
      assert.equal(ledger.snapshot().used.tokens, 1_128_000);
      assert.match(response.errorMessage!, /charged at its reserved maximum/);
    } finally {
      await native.close();
    }
  }));

test('a resend after a partial-usage attempt keeps the bound when later receipts cannot prove usage', async (t) =>
  toolFreeFixture(t, 'prompt-too-long-usage-then-silent', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(response.rawStopReason, 'claude-code-context-overflow');
      assert.equal(rows(join(directory, 'launch')).length, 3);
      // The first attempt published real usage; the reset drops its marker, so the attempts whose
      // receipts disprove their own usage fail closed at the bound instead of settling at a stale 0.
      assert.equal(ledger.snapshot().accounting, 'known');
      assert.equal(ledger.snapshot().used.tokens, 1_128_000);
      assert.match(response.errorMessage!, /charged at its reserved maximum/);
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

test('a synthetic Prompt is too long reply with trailing punctuation is still an overflow', async (t) =>
  toolFreeFixture(t, 'synthetic-period', async (directory) => {
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

test('a pending result larger than the usable budget reaches the native socket intact', async () =>
  fixture('fine', async (directory) => {
    const { model, native } = await modelAndSession();
    const { stream } = meteredNative(native);
    // The context hook's production wiring: the trimmer sees the transcript first, and the results
    // the native batch is still owed are exempt from stubs.
    const trim = createContextTrimmer(
      () => model.contextWindow,
      () => 0,
      () => native.pendingCallIds(),
    );
    const real = `REAL_${'r'.repeat(4_000)}`;
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
              return { content: [{ type: 'text', text: real }], details: undefined };
            },
          },
        ],
      },
      streamFn: (m, c, o) => stream(m, { ...c, messages: trim(c.messages) }, o),
    });
    try {
      // A transcript already past the usable budget: the pending result is the newest tool
      // result, and untrimmable messages keep the total over the cap even after every stub.
      await agent.prompt(`probe ${'x'.repeat(3_200_000)}`);
      const results = rows(join(directory, 'results'));
      assert.equal(results.length, 1, 'the result is delivered once; the model is not asked to re-issue');
      assert.equal(results[0].content[0].text, real, 'the socket gets the real result, not a re-issue stub');
      const responses = agent.state.messages.filter((message) => message.role === 'assistant');
      assert.equal(responses.at(-1)!.stopReason, 'stop');
    } finally {
      await native.close();
    }
  }));

test('compaction during a tool batch clips the real pending result, not a stub', async () =>
  fixture('big-prompt', async (directory) => {
    const { model, native } = await modelAndSession();
    const { stream } = meteredNative(native);
    const trim = createContextTrimmer(
      () => model.contextWindow,
      () => 0,
      () => native.pendingCallIds(),
    );
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
              return { content: [{ type: 'text', text: `REAL${'r'.repeat(3_200_000)}` }], details: undefined };
            },
          },
        ],
      },
      streamFn: (m, c, o) => stream(m, { ...c, messages: trim(c.messages) }, o),
    });
    try {
      await agent.prompt('probe');
      const summary = rows(join(directory, 'input'))[1]!.message.content;
      assert.match(summary, /PENDING TOOL RESULTS[\s\S]*REALr+… \[\d+ chars cut\]/);
      assert.doesNotMatch(summary, /removed to fit the context limit/);
    } finally {
      await native.close();
    }
  }));

test('a cut pending result with complete arguments still offers exact replay', async () =>
  fixture('big-prompt', async (directory) => {
    const { model, native } = await modelAndSession();
    const { stream } = meteredNative(native);
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
              return { content: [{ type: 'text', text: `REAL${'r'.repeat(20_000)}` }], details: undefined };
            },
          },
        ],
      },
      streamFn: stream,
    });
    try {
      await agent.prompt('probe');
      const summary = rows(join(directory, 'input'))[1]!.message.content;
      assert.match(
        summary,
        /PENDING TOOL RESULTS[\s\S]*read\(\{"path":"src\/main\.ts"\}\) \[call_[^\]]+\]:\n[\s\S]*chars cut\]/,
      );
      assert.doesNotMatch(summary, /\[incomplete\]/, 'a fully preserved call is not marked incomplete');
      assert.match(summary, /re-issue that exact call/);
    } finally {
      await native.close();
    }
  }));

test('a cut pending result with cut arguments is marked incomplete instead of replayed', async () =>
  fixture('big-prompt big-args', async (directory) => {
    const { model, native } = await modelAndSession();
    const { stream } = meteredNative(native);
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
              return { content: [{ type: 'text', text: `REAL${'r'.repeat(20_000)}` }], details: undefined };
            },
          },
        ],
      },
      streamFn: stream,
    });
    try {
      await agent.prompt('probe');
      const summary = rows(join(directory, 'input'))[1]!.message.content;
      assert.match(summary, /PENDING TOOL RESULTS[\s\S]*\[call_[^\]]+\] \[incomplete\]:/);
      assert.match(
        summary,
        /read\(\{"path":"src\/p+… \[\d+ chars cut\]\)/,
        'the call header shows the arguments were clipped',
      );
      assert.match(
        summary,
        /\[incomplete\]:\nREALr+… \[\d+ chars cut\]/,
        'the result body shows the tool output was clipped',
      );
      assert.match(summary, /narrower call/, 'recovery guidance points at a narrower call');
      assert.doesNotMatch(summary, /re-issue that exact call/);
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
      const summary = rows(join(directory, 'input'))[1]!.message.content;
      assert.match(summary, /compacted by OMS/);
      assert.doesNotMatch(summary, /task_status/, 'a session without the tool gets no invented guidance');
    } finally {
      await native.close();
    }
  }));

test('the summary keeps task_status guidance only when the session declares that tool', async (t) =>
  toolFreeFixture(t, 'big-prompt', async (directory) => {
    const { native, model } = await modelAndSession();
    const transcript = normalizeContext({
      systemPrompt: 'Trusted OMS',
      tools: [{ name: 'task_status', description: 'Report item states', parameters: Type.Object({}) }],
      messages: [{ role: 'user', content: 'FIRST_SECRET', timestamp: 1 }],
    });
    try {
      const first = await native.stream(model, transcript).result();
      assert.equal(first.stopReason, 'stop', first.errorMessage);
      transcript.messages.push(first, { role: 'user', content: 'go on', timestamp: 2 });
      const second = await native.stream(model, transcript).result();
      assert.equal(second.stopReason, 'stop', second.errorMessage);
      const summary = rows(join(directory, 'input'))[1]!.message.content;
      assert.match(summary, /compacted by OMS/);
      assert.match(summary, /re-check task_status/);
    } finally {
      await native.close();
    }
  }));

test('a failed start after compaction never lets the summary replace the next user prompt', async (t) =>
  toolFreeFixture(t, 'big-prompt auth-fails-once-after-input', async (directory) => {
    const { native, model } = await modelAndSession();
    const transcript = toolFreeContext();
    try {
      const first = await native.stream(model, transcript).result();
      assert.equal(first.stopReason, 'stop', first.errorMessage);
      transcript.messages.push(first, { role: 'user', content: 'go on', timestamp: 2 });
      // The ~170k observed prompt compacts before this turn; the post-compaction start
      // then dies in the native auth check, so the summary is never sent.
      const failed = await native.stream(model, transcript).result();
      assert.equal(failed.stopReason, 'error');
      transcript.messages.push({ role: 'user', content: 'SECOND_PROMPT', timestamp: 3 });
      const recovered = await native.stream(model, transcript).result();
      assert.equal(recovered.stopReason, 'stop', recovered.errorMessage);
      const input = rows(join(directory, 'input'));
      assert.equal(input.length, 2);
      assert.equal(input[1]!.message.content, 'SECOND_PROMPT', 'the stale summary must not replace the new prompt');
    } finally {
      await native.close();
    }
  }));

test('a sign-in probe that fails after the prompt was sent keeps the charge', async (t) =>
  toolFreeFixture(t, 'prompt-too-long auth-fails-once-after-input', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      // First send overflows; the compacted retry's login re-check then fails, so the
      // prompt already dispatched must stay charged instead of releasing as unsent.
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.match(response.errorMessage!, /no longer valid/);
      assert.match(response.errorMessage!, /maximum cost/);
      assert.equal(rows(join(directory, 'input')).length, 1, 'the compacted retry never reached the transport');
      assert.equal(ledger.reservations().length, 1);
      assert.equal(ledger.snapshot().accounting, 'unknown', 'a dispatched turn is not released as unsent');
      assert.equal(ledger.snapshot().used.tokens, 1_128_000, 'usage stays charged at the bound');
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
        assert.ok(
          ledger.receipts().some((receipt) => receipt.outcome === 'known' && receipt.tokens === 0),
          'the failed attempt settles at the usage its provider reported',
        );
        assert.ok(ledger.snapshot().used.tokens < 1_128_000);
      } finally {
        await native.close();
      }
    }));

test('three empty native failures stop after reporting zero usage each', async (t) =>
  toolFreeFixture(t, 'empty', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(rows(join(directory, 'input')).length, 3);
      assert.equal(ledger.reservations().length, 3);
      // Every attempt's receipt established zero usage: each settles observed, not at its bound.
      assert.equal(ledger.snapshot().accounting, 'known');
      assert.equal(ledger.snapshot().used.tokens, 0);
      assert.match(response.errorMessage!, /usage was counted/);
    } finally {
      await native.close();
    }
  }));

for (const mode of [
  'auth-failure',
  'usage-limit',
  'usage-limit-reset',
  'usage-limit-reset-multiline',
  'insufficient-quota',
  'auth-401',
  'auth-403',
  'auth-403-forbidden',
  'auth-unauthorized',
  'auth-forbidden',
])
  test(`${mode} never retries native inference and names its real outcome`, async (t) =>
    toolFreeFixture(t, mode, async (directory) => {
      const { native, model } = await modelAndSession();
      const { ledger, stream } = meteredNative(native);
      try {
        const response = await (await stream(model, toolFreeContext())).result();
        assert.equal(response.stopReason, 'error');
        assert.equal(rows(join(directory, 'input')).length, 1);
        assert.equal(ledger.reservations().length, 1);
        // The refusal receipt reports zero usage: the attempt settles observed at 0.
        assert.equal(ledger.snapshot().accounting, 'known');
        assert.equal(ledger.snapshot().used.tokens, 0);
        if (['usage-limit', 'usage-limit-reset', 'usage-limit-reset-multiline', 'insufficient-quota'].includes(mode))
          assert.match(response.errorMessage!, /Claude Code's usage limit was reached/);
        else assert.match(response.errorMessage!, /Claude subscription sign-in is no longer valid/);
        if (mode === 'usage-limit-reset') assert.match(response.errorMessage!, /It resets at 3:00 PM \(UTC\)\./);
        if (mode === 'usage-limit-reset-multiline') {
          assert.match(response.errorMessage!, /It resets at 3pm PT\./);
          assert.ok(!/Do not keep sending/.test(response.errorMessage!), 'the escaped next line is not reset text');
        }
        assert.ok(!/broke off|API key/i.test(response.errorMessage!));
      } finally {
        await native.close();
      }
    }));

test('a bare 429 is temporary throttling, not plan exhaustion or an empty response', async (t) =>
  toolFreeFixture(t, 'limit-429', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(rows(join(directory, 'input')).length, 1, 'no in-band retry of a throttled turn');
      assert.equal(ledger.reservations().length, 1);
      assert.match(response.errorMessage!, /rate limiting requests/);
      assert.ok(isRetryableAssistantError(response), 'Pi retries the throttled turn after backoff');
      assert.ok(!/usage limit|broke off/i.test(response.errorMessage!));
      // The throttled receipt reported zero usage: the attempt settles observed at 0.
      assert.equal(ledger.snapshot().accounting, 'known');
      assert.equal(ledger.snapshot().used.tokens, 0);
    } finally {
      await native.close();
    }
  }));

test('a throttled turn resends into the same native session once the limit clears', async (t) =>
  toolFreeFixture(t, 'rate-limit-then-good', async (directory) => {
    const { native, model } = await modelAndSession();
    // ~1.6 bounds: the resend is only admitted because the 429 attempt settled at its
    // reported usage; a full-bound charge would leave too little for a second hold.
    const { ledger, stream } = meteredNative(native, 1_800_000);
    const transcript = toolFreeContext();
    try {
      const first = await (await stream(model, transcript)).result();
      assert.equal(first.stopReason, 'error');
      const second = await (await stream(model, transcript)).result();
      assert.equal(second.stopReason, 'stop', second.errorMessage);
      assert.equal(ledger.snapshot().accounting, 'known');
      const input = rows(join(directory, 'input'));
      assert.equal(input.length, 2);
      assert.deepEqual(input.at(-1).message, input.at(-2).message, 'the throttled input is retried unchanged');
      const history = JSON.parse(readFileSync(join(directory, 'history'), 'utf8'));
      assert.deepEqual(
        history,
        [input.at(-1).message.content],
        'the refused send is not retained; the prompt is in history once',
      );
      const launches = rows(join(directory, 'launch'));
      assert.equal(launches.length, 2);
      assert.equal(launches[1].args[launches[1].args.indexOf('--resume') + 1], native.status().sessionId);
    } finally {
      await native.close();
    }
  }));

test('a transient receipt whose text only mentions an account stays a generic failure, then its resend proves nothing was dispatched', async (t) =>
  toolFreeFixture(t, 'account-network', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native, 6_000_000, 60_000, true);
    const transcript = toolFreeContext();
    try {
      const response = await (await stream(model, transcript)).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(rows(join(directory, 'input')).length, 1);
      // The failed receipt reported zero usage: the attempt settles observed at 0, not uncertain.
      assert.equal(ledger.snapshot().accounting, 'known');
      assert.match(response.errorMessage!, /usage was counted/);
      assert.ok(!/sign-in|usage limit/i.test(response.errorMessage!));
      transcript.messages.push({ role: 'user', content: 'again', timestamp: 2 });
      const resend = await (await stream(model, transcript)).result();
      assert.equal(resend.stopReason, 'error');
      assert.match(resend.errorMessage!, /did not start a native request: Native protocol failed verification/);
      assert.match(resend.errorMessage!, /\/clear/);
      assert.match(resend.errorMessage!, /No provider request was sent/);
      assert.equal(ledger.receipts().at(-1)!.outcome, 'not_dispatched');
      assert.equal(ledger.snapshot().used.tokens, 0, 'the resend released its reservation');
      assert.equal(rows(join(directory, 'input')).length, 1, 'the resend never reached the native chat');
    } finally {
      await native.close();
    }
  }));

test('an unconfigured Claude sign-in names re-authentication and releases the reservation', async (t) =>
  toolFreeFixture(t, 'api-auth', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error');
      assert.equal(
        response.errorMessage,
        'Claude Code needs its Claude subscription sign-in before it can answer. Run claude auth login in a terminal, then check the connection in /connect and send your message again. No provider request was sent.',
      );
      assert.equal(existsSync(join(directory, 'launch')), false, 'no native model process may start');
      assert.equal(ledger.snapshot().used.tokens, 0);
      assert.equal(ledger.snapshot().accounting, 'known');
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
    // A hang has no receipt to settle at observed usage, so the cap variant uses it to keep the bound.
    toolFreeFixture(t, limit === 'tokens' ? 'hang' : 'empty', async (directory) => {
      const { native, model } = await modelAndSession();
      const { ledger, stream } = meteredNative(
        native,
        limit === 'tokens' ? 1_128_000 : 6_000_000,
        limit === 'time' ? 1_000 : 60_000,
      );
      const controller = new AbortController();
      try {
        const response = await (
          await stream(model, toolFreeContext(), {
            signal: controller.signal,
            ...(limit === 'tokens' ? { timeoutMs: 150 } : {}),
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
            'Request cancelled during retry backoff; the failed attempt was counted at its settled usage.',
          );
          assert.equal(ledger.snapshot().accounting, 'known');
          assert.deepEqual(ledger.snapshot().pendingDispatchIds, []);
          // The empty attempt's receipt reported zero usage.
          assert.equal(ledger.snapshot().used.tokens, 0);
        }
      } finally {
        await native.close();
      }
    }));

test('an empty native retry is admitted under the default session token cap', async (t) =>
  toolFreeFixture(t, 'empty-then-good', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native, 2_000_000);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'stop', response.errorMessage);
      assert.equal(rows(join(directory, 'input')).length, 2);
      assert.equal(ledger.reservations().length, 2);
      assert.equal(ledger.snapshot().accounting, 'known');
    } finally {
      await native.close();
    }
  }));

for (const mode of ['refuse-then-good', 'refuse-unsent'])
  test(`${mode} settles the refusal at its reported usage so bounded admission resumes`, async (t) =>
    toolFreeFixture(t, mode, async (directory) => {
      const { native, model } = await modelAndSession();
      const { ledger, stream } = meteredNative(native, 2_000_000);
      try {
        const transcript = toolFreeContext();
        const refused = await (await stream(model, transcript)).result();
        assert.equal(refused.stopReason, 'error');
        // The refusal receipt establishes usage: observed tokens, never an unknown charge.
        assert.equal(ledger.snapshot().accounting, 'known');
        assert.equal(ledger.snapshot().used.tokens, mode === 'refuse-then-good' ? 100 : 0);
        // Native refusal recovery still requires the documented /clear; the budget no longer does.
        await native.reset();
        transcript.messages.push(refused, { role: 'user', content: 'again', timestamp: 2 });
        const response = await (await stream(model, transcript)).result();
        assert.equal(response.stopReason, 'stop', response.errorMessage);
      } finally {
        await native.close();
      }
    }));

test('an error receipt contradicting streamed usage stays fail-closed', async (t) =>
  toolFreeFixture(t, 'usage-then-zero-error', async () => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native, 2_000_000);
    try {
      const response = await (await stream(model, toolFreeContext())).result();
      assert.equal(response.stopReason, 'error', response.errorMessage);
      // The stream reported real usage but the receipt claims none: contradictory, so
      // the reservation is retained as unknown usage rather than settled at zero.
      assert.equal(ledger.snapshot().accounting, 'unknown');
      assert.ok(ledger.snapshot().used.tokens >= 1_128_000);
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

test('a refusal during tool continuation names its cause, keeps the unsafe batch guard, and the next send proves nothing dispatched', async (t) => {
  await fixture('auth-after-tool', async (directory) => {
    const { native, model } = await modelAndSession();
    const { ledger, stream } = meteredNative(native, 6_000_000, 60_000, true);
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
      streamFn: (selectedModel, transcript, options) => stream(selectedModel, transcript, options),
    });
    const lastAssistant = () => agent.state.messages.filter((message) => message.role === 'assistant').at(-1)!;
    try {
      await agent.prompt('probe');
      const first = lastAssistant();
      assert.equal(first.stopReason, 'error');
      assert.match(first.errorMessage!, /Claude subscription sign-in is no longer valid/);
      assert.match(first.errorMessage!, /interrupted native tool batch was not replayed/);
      assert.match(first.errorMessage!, /\/clear/);
      assert.equal(executed, 1);
      await agent.prompt('again');
      const second = lastAssistant();
      assert.equal(second.stopReason, 'error');
      assert.match(second.errorMessage!, /did not start a native request: Interrupted native tool batch/);
      assert.match(second.errorMessage!, /\/clear/);
      assert.match(second.errorMessage!, /No provider request was sent/);
      assert.equal(ledger.reservations().length, 3, 'user turn, tool continuation, refused resend');
      assert.equal(ledger.receipts().at(-1)!.outcome, 'not_dispatched');
      assert.equal(rows(join(directory, 'launch')).length, 1, 'the refused batch is never replayed');
      assert.equal(rows(join(directory, 'input')).length, 1);
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
      caps: { tokens: 1_128_000, spendMicroUsd: 1000000, wallClockMs: 60000 },
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

test('a native CLI deadline is reported as a timeout, not a cancellation', async () =>
  fixture('hang-auth', async () => {
    await assert.rejects(runClaudeCode(['auth', 'status'], { cwd: tmpdir(), timeoutMs: 50 }), /timed out/);
  }));
test('a cancelled native CLI request is still reported as a cancellation', async () =>
  fixture('hang-auth', async () => {
    const control = new AbortController();
    const request = runClaudeCode(['auth', 'status'], { cwd: tmpdir(), signal: control.signal });
    control.abort();
    await assert.rejects(request, /cancelled/);
  }));
test('creating the provider defers claude auth status to first use and caches it across restarts', async (t) =>
  toolFreeFixture(t, 'api-auth', async () => {
    assert.equal((await inspectClaudeCode()).configured, false, 'seed an unconfigured ambient status');
    await fixture('ok', async (directory) => {
      const { model, native } = await modelAndSession();
      try {
        assert.equal(authChecks(directory), 0, 'provider creation spawns no CLI');
        const response = await native.stream(model, toolFreeContext()).result();
        assert.equal(response.stopReason, 'stop', response.errorMessage);
        assert.equal(authChecks(directory), 1, 'first use checks auth exactly once');
        await native.reconnect();
        assert.equal(authChecks(directory), 1, 'a restart reuses the configured check');
      } finally {
        await native.close();
      }
    });
  }));
test('a first native use without a Claude Code login reports the sign-in step', async (t) =>
  toolFreeFixture(t, 'api-auth', async (directory) => {
    assert.equal((await inspectClaudeCode()).configured, false, 'seed an unconfigured ambient status');
    const { model, native } = await modelAndSession();
    try {
      const response = await native.stream(model, toolFreeContext()).result();
      assert.equal(response.stopReason, 'error');
      assert.match(response.errorMessage!, /claude auth login/);
      assert.equal(authChecks(directory), 2, 'the seed and the first-use check each spawned the CLI once');
    } finally {
      await native.close();
    }
  }));
test('a session launched on a native model verifies the ambient login on its first prompt', async () =>
  fixture('ok', async (directory) => {
    const f = await createChatFixture();
    try {
      const chat = await createChatSession({
        ...f.options,
        model: undefined,
        modelSelection: { provider: 'claude-code', id: 'haiku' },
        caps: { tokens: 10_000_000, spendMicroUsd: 1_000_000, wallClockMs: 120_000 },
      });
      try {
        await chat.session.prompt('say hi');
        assert.match(JSON.stringify(chat.session.messages), /"reply"/);
        assert.equal(authChecks(directory), 1, 'the first-use gate and session start share one check');
      } finally {
        await chat.close();
      }
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  }));
test('a turn that expires during the login check never submits the prompt', async () =>
  fixture('hang-auth', async (directory) => {
    const f = await createChatFixture();
    try {
      const chat = await createChatSession({
        ...f.options,
        model: undefined,
        modelSelection: { provider: 'claude-code', id: 'haiku' },
        caps: { tokens: 10_000_000, spendMicroUsd: 1_000_000, wallClockMs: 2_000 },
      });
      try {
        await assert.rejects(chat.session.prompt('say hi'), /wall-clock/);
        assert.equal(authChecks(directory), 1, 'the login check was launched before the deadline');
        const [killed] = rows(join(directory, 'auth-killed'));
        assert.ok(killed.uptime < 10, 'the deadline signalled the in-flight check before its own timeout');
        assert.equal(existsSync(join(directory, 'launch')), false, 'the prompt is never submitted');
      } finally {
        await chat.close();
      }
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  }));
test('a new session re-verifies a cached subscription before trusting it', async (t) =>
  toolFreeFixture(t, 'ok', async () => {
    assert.equal((await inspectClaudeCode()).configured, true, 'seed a verified subscription login');
    await fixture('api-auth', async (directory) => {
      const { model, native } = await modelAndSession();
      try {
        const response = await native.stream(model, toolFreeContext()).result();
        assert.equal(response.stopReason, 'error');
        assert.match(response.errorMessage!, /claude auth login/);
        assert.equal(authChecks(directory), 1, 'the fresh session re-checked ambient auth once');
      } finally {
        await native.close();
      }
    });
  }));
test('a Claude Code login check that times out says so', async () =>
  fixture('hang-auth', async () => {
    const result = await inspectClaudeCode(undefined, 50);
    assert.equal(result.configured, false);
    assert.match(result.detail, /timed out/);
  }));
test('a cancelled Claude Code login check leaves the earlier status alone', async () =>
  fixture('ok', async () => {
    const before = getClaudeCodeStatus();
    const controller = new AbortController();
    controller.abort();
    const result = await inspectClaudeCode(controller.signal);
    assert.deepEqual(result, before, 'a cancelled probe must not record a checked failure');
  }));
