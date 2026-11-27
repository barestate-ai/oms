import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Result {
  batch_id: string;
  task_id: string;
  config: string;
  rep: number;
  score: number | null;
  passed: number | null;
  total: number | null;
  eligible?: boolean;
  attempt?: number;
  usd: number;
  oms_usd: number | null;
  input: number;
  cached: number;
  output: number;
  wall_ms: number;
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const scored = (row: Result): row is Result & { score: number } => row.eligible !== false && row.score !== null;
export function summarize(rows: Result[]) {
  return [...new Set(rows.map((r) => r.config))].sort().map((config) => {
    const all = rows.filter((r) => r.config === config),
      group = all.filter(scored),
      times = group.map((r) => r.wall_ms).sort((a, b) => a - b);
    const solved = group.filter((r) => r.score === 1).length,
      usd = all.reduce((sum, r) => sum + r.usd, 0);
    return {
      config,
      runs: group.length,
      mean_score: mean(group.map((r) => r.score)),
      solved,
      total_usd: usd,
      usd_per_solved: solved ? usd / solved : null,
      median_wall_ms: (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2,
      mean_tokens: mean(group.map((r) => r.input + r.output)),
      mean_input: mean(group.map((r) => r.input)),
      mean_cached: mean(group.map((r) => r.cached)),
      mean_output: mean(group.map((r) => r.output)),
    };
  });
}
export function pairedTest(rows: Result[], a: string, b: string) {
  const eligible = rows.filter(scored);
  if (a === b) throw new Error('Choose distinct configurations');
  const tasks = [...new Set(rows.filter((r) => r.config === a || r.config === b).map((r) => r.task_id))].sort();
  const pairs = tasks.flatMap((task) => {
    const x = eligible.filter((r) => r.task_id === task && r.config === a),
      y = eligible.filter((r) => r.task_id === task && r.config === b);
    return x.length && y.length ? [mean(x.map((r) => r.score)) - mean(y.map((r) => r.score))] : [];
  });
  const differences = pairs.filter((d) => d !== 0);
  if (!pairs.length) throw new Error('No paired tasks');
  if (differences.length > 24) throw new Error('Exact enumeration supports at most 24 nonzero task differences');
  const observed = Math.abs(differences.reduce((sum, d) => sum + d, 0));
  let extreme = 0;
  function visit(index: number, sum: number) {
    if (index === differences.length) {
      if (Math.abs(sum) >= observed - 1e-12) extreme++;
      return;
    }
    visit(index + 1, sum + differences[index]!);
    visit(index + 1, sum - differences[index]!);
  }
  visit(0, 0);
  return {
    a,
    b,
    paired_tasks: pairs.length,
    nonzero_tasks: differences.length,
    mean_difference: mean(pairs),
    p_value: extreme / 2 ** differences.length,
  };
}
export function readResults(path: string): Result[] {
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return [];
  const rows = content.split('\n').map((line) => JSON.parse(line) as Result),
    identities = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.batch_id,
      row.task_id,
      row.config,
      row.rep,
      row.eligible === false ? `infra:${row.attempt}` : 'scored',
    ]);
    if (identities.has(key)) throw new Error('Duplicate run');
    identities.add(key);
    if (
      !row.batch_id ||
      !row.task_id ||
      !row.config ||
      ![row.usd, row.input, row.cached, row.output, row.wall_ms].every((n) => Number.isFinite(n) && n >= 0) ||
      (row.oms_usd !== null && (!Number.isFinite(row.oms_usd) || row.oms_usd < 0)) ||
      (row.eligible === false
        ? row.score !== null || !Number.isSafeInteger(row.attempt) || row.attempt! < 0
        : row.score === null || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) ||
      row.cached > row.input
    )
      throw new Error('Invalid run record');
  }
  if (new Set(rows.map((r) => r.batch_id)).size > 1) throw new Error('Report one batch at a time');
  return rows;
}
export function table(rows: Result[]): string {
  return [
    '| Config | Runs | Mean score | Solved | USD | USD/solved | Median s | Mean tokens |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...summarize(rows).map(
      (r) =>
        `| ${r.config} | ${r.runs} | ${Number.isFinite(r.mean_score) ? r.mean_score.toFixed(4) : '—'} | ${r.solved} | ${r.total_usd.toFixed(6)} | ${r.usd_per_solved === null ? '—' : r.usd_per_solved.toFixed(6)} | ${Number.isFinite(r.median_wall_ms) ? (r.median_wall_ms / 1000).toFixed(2) : '—'} | ${Number.isFinite(r.mean_tokens) ? r.mean_tokens.toFixed(0) : '—'} |`,
    ),
  ].join('\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [file, a, b, ...extra] = process.argv.slice(2);
    if (!file || extra.length || Boolean(a) !== Boolean(b))
      throw new Error('Usage: node report.ts batch.jsonl [config-a config-b]');
    const rows = readResults(file);
    console.log(table(rows));
    if (a && b) console.log(JSON.stringify(pairedTest(rows, a, b)));
  } catch {
    console.error('Unable to report batch: check arguments and records.');
    process.exitCode = 1;
  }
}
