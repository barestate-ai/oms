import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OmsSession } from '@oms/engine';
import { SolanaPanel, detectPrograms, formatIdl, parseAnchorToml, typeText } from '../src/tui/solana-panel.ts';

const ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const OTHER = '11111111111111111111111111111111';

test('Anchor.toml program tables are read by cluster, ignoring comments and other tables', () => {
  const toml = `
[features]
seeds = false
[programs.localnet]
vault = "${ID}" # the vault
"escrow" = "${OTHER}"
[programs.devnet]
vault = "${OTHER}"
[provider]
cluster = "localnet"
`;
  assert.deepEqual(parseAnchorToml(toml), [
    { cluster: 'localnet', name: 'vault', id: ID },
    { cluster: 'localnet', name: 'escrow', id: OTHER },
    { cluster: 'devnet', name: 'vault', id: OTHER },
  ]);
  assert.deepEqual(parseAnchorToml('[programs.localnet]\nvault = "short"'), []);
});

test('programs come from Anchor.toml with localnet first, matched to the IDLs a build left behind', () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-solana-'));
  try {
    writeFileSync(
      join(root, 'Anchor.toml'),
      `[programs.devnet]\nvault = "${OTHER}"\n[programs.localnet]\nvault = "${ID}"\n`,
    );
    mkdirSync(join(root, 'target/idl'), { recursive: true });
    writeFileSync(
      join(root, 'target/idl/vault.json'),
      JSON.stringify({ address: ID, metadata: { name: 'vault' }, instructions: [] }),
    );
    writeFileSync(join(root, 'target/idl/stray.json'), JSON.stringify({ name: 'stray', instructions: [] }));
    const found = detectPrograms(root);
    assert.equal(found.anchor, true);
    assert.deepEqual(
      found.programs.map((program) => [program.name, program.id, !!program.idl]),
      [
        ['vault', ID, true],
        ['stray', undefined, true],
      ],
    );
    assert.deepEqual(detectPrograms(join(root, 'nowhere')), { anchor: false, programs: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('IDL text covers the 0.30 shape and the legacy one, defensively', () => {
  const modern = {
    address: ID,
    metadata: { name: 'vault' },
    instructions: [
      {
        name: 'deposit',
        accounts: [
          { name: 'vault', writable: true, pda: { seeds: [] } },
          { name: 'user', writable: true, signer: true },
          { name: 'system_program' },
        ],
        args: [{ name: 'amount', type: 'u64' }],
      },
    ],
    accounts: [{ name: 'Vault', discriminator: [1] }],
    types: [
      {
        name: 'Vault',
        type: {
          kind: 'struct',
          fields: [
            { name: 'owner', type: 'pubkey' },
            { name: 'tags', type: { vec: 'u8' } },
          ],
        },
      },
    ],
    errors: [{ code: 6000, name: 'Zero', msg: 'Amount must be positive' }],
  };
  const text = formatIdl(modern, 'target/idl/vault.json');
  assert.match(text, new RegExp(`^vault · ${ID} · target/idl/vault.json`));
  assert.match(text, /deposit\(amount: u64\)/);
  assert.match(text, /accounts: vault \(mut, pda\) · user \(mut, signer\) · system_program/);
  assert.match(text, /Vault \{ owner: pubkey, tags: Vec<u8> \}/);
  assert.match(text, /6000 0x1770 Zero — Amount must be positive/);
  const legacy = {
    name: 'old',
    instructions: [
      {
        name: 'init',
        accounts: [
          { name: 'authority', isMut: false, isSigner: true },
          { name: 'group', accounts: [{ name: 'inner', isMut: true }] },
        ],
        args: [],
      },
    ],
    accounts: [{ name: 'State', type: { kind: 'struct', fields: [{ name: 'bump', type: 'u8' }] } }],
  };
  const old = formatIdl(legacy);
  assert.match(old, /init\(\)/);
  assert.match(old, /authority \(signer\) · inner \(mut\)/);
  assert.match(old, /State \{ bump: u8 \}/);
  assert.doesNotThrow(() => formatIdl({} as never));
  assert.equal(typeText({ array: ['u8', 32] }), '[u8; 32]');
  assert.equal(typeText({ option: { defined: { name: 'Config' } } }), 'Option<Config>');
  assert.equal(typeText({ nonsense: true }), 'unknown');
});

function panel(root: string, chain: unknown) {
  const ran: string[] = [];
  const prefilled: string[] = [];
  const reports: string[] = [];
  let renders = 0;
  const harness = { kind: 'chat', root, chain } as unknown as OmsSession;
  const solana = new SolanaPanel({
    harness,
    render: () => renders++,
    run: (command) => ran.push(command),
    prefill: (command) => prefilled.push(command),
    openReport: (id, text) => reports.push(`${id}:${text.split('\n')[0]}`),
    notice() {},
    visible: () => true,
  });
  return { solana, ran, prefilled, reports, renders: () => renders };
}

test('the section lists programs and actions that drive the existing commands; it is absent for other projects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-solana-'));
  try {
    const plain = panel(root, undefined);
    assert.equal(plain.solana.section(), undefined);
    writeFileSync(join(root, 'Anchor.toml'), `[programs.localnet]\nvault = "${ID}"\n`);
    mkdirSync(join(root, 'target/idl'), { recursive: true });
    writeFileSync(
      join(root, 'target/idl/vault.json'),
      JSON.stringify({ metadata: { name: 'vault' }, address: ID, instructions: [] }),
    );
    const calls: string[] = [];
    const chain = {
      rpcUrl: () => 'http://127.0.0.1:8899',
      health: async () => ({ ok: true }),
      call: async (method: string) => {
        calls.push(method);
        return 18234;
      },
    };
    const { solana, ran, prefilled, reports } = panel(root, chain);
    await solana.poll();
    assert.deepEqual(solana.statusChip(), { text: 'localnet slot 18,234', role: 'success' });
    const section = solana.section()!;
    assert.equal(section.title, 'solana');
    const byId = new Map(section.items.map((item) => [item.id, item]));
    assert.equal(byId.get('chain')!.detail, 'slot 18,234');
    assert.equal(byId.get('program:vault')!.detail, 'Toke…Q5DA');
    byId.get('build')!.onActivate!();
    byId.get('test')!.onActivate!();
    byId.get('chain')!.onActivate!();
    byId.get('deploy')!.onActivate!();
    byId.get('airdrop')!.onActivate!();
    byId.get('idl:vault')!.onActivate!();
    assert.deepEqual(ran, ['/run anchor build', '/test', '/chain']);
    assert.deepEqual(prefilled, ['/run anchor deploy --provider.cluster "$SURFNET_RPC_URL"', '/airdrop ']);
    assert.deepEqual(reports, [`idl-vault:vault · ${ID} · target/idl/vault.json`]);
    assert.deepEqual(calls, ['getSlot']);
    solana.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the chain is read only from loopback; a stopped or foreign chain shows as down or not at all, and polls never overlap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-solana-'));
  try {
    writeFileSync(join(root, 'Anchor.toml'), `[programs.localnet]\nvault = "${ID}"\n`);
    let health = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let url: string | undefined = undefined;
    const chain = {
      rpcUrl: () => url,
      health: async () => {
        health++;
        await gate;
        return { ok: true };
      },
      call: async () => 5,
    };
    const { solana } = panel(root, chain);
    await solana.poll();
    assert.equal(solana.statusChip()?.role, 'warning');
    assert.match(solana.statusChip()!.text, /not running/);
    url = 'https://api.mainnet-beta.solana.com';
    await solana.poll();
    assert.equal(solana.statusChip(), undefined, 'a non-loopback address is never contacted');
    assert.equal(health, 0);
    url = 'http://127.0.0.1:8899';
    const first = solana.poll();
    const second = solana.poll();
    release();
    await Promise.all([first, second]);
    assert.equal(health, 1);
    solana.dispose();
    const none = panel(root, undefined);
    assert.equal(none.solana.statusChip(), undefined);
    assert.equal(
      none.solana.section()!.items.some((item) => item.id === 'chain'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
