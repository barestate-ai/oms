import { engine } from './journal.ts';
export function run(x) {
  return engine(x, false);
}
