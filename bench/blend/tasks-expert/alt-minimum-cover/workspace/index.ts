import { run } from './main.ts';
export function solve(input) {
  try {
    return JSON.parse(JSON.stringify(run(input), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch {
    return { error: 'invalid' };
  }
}
