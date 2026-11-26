export class SqlStore {
  readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS blend_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS blend_days (day TEXT PRIMARY KEY, spent INTEGER NOT NULL, held INTEGER NOT NULL)',
    );
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS blend_reservations (id TEXT PRIMARY KEY, day TEXT NOT NULL, amount INTEGER NOT NULL, charged INTEGER, retained INTEGER)',
    );
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS blend_requests (id TEXT PRIMARY KEY, at INTEGER NOT NULL, until INTEGER NOT NULL, active INTEGER NOT NULL)',
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.storage.sql
      .exec<{ value: string }>('SELECT value FROM blend_state WHERE key = ?', key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(key: string, value: unknown) {
    this.storage.sql.exec(
      'INSERT INTO blend_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(value),
    );
  }
  acquire(
    id: string,
    now: number,
    timeout: number,
    perMinute: number,
    concurrent: number,
  ): 'rate' | 'concurrent' | undefined {
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      sql.exec('DELETE FROM blend_requests WHERE at <= ? AND (active = 0 OR until <= ?)', now - 60000, now);
      const count = (query: string, ...args: number[]) => sql.exec<{ n: number }>(query, ...args).toArray()[0]!.n;
      if (count('SELECT COUNT(*) AS n FROM blend_requests WHERE at > ?', now - 60000) >= perMinute) return 'rate';
      if (count('SELECT COUNT(*) AS n FROM blend_requests WHERE active = 1 AND until > ?', now) >= concurrent)
        return 'concurrent';
      sql.exec('INSERT INTO blend_requests (id,at,until,active) VALUES (?,?,?,1)', id, now, now + timeout + 30000);
      return undefined;
    });
  }
  release(id: string) {
    this.storage.sql.exec('UPDATE blend_requests SET active = 0 WHERE id = ?', id);
  }
  reserve(id: string, amount: number, limit: number, now: number): boolean {
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql,
        day = new Date(now).toISOString().slice(0, 10);
      const old = sql.exec<{ amount: number }>('SELECT amount FROM blend_reservations WHERE id = ?', id).toArray()[0];
      if (old) {
        if (old.amount !== amount) throw Error('Reservation conflict');
        return true;
      }
      const cutoff = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
      sql.exec('DELETE FROM blend_reservations WHERE day < ?', cutoff);
      sql.exec('DELETE FROM blend_days WHERE day < ?', cutoff);
      sql.exec('INSERT OR IGNORE INTO blend_days (day,spent,held) VALUES (?,0,0)', day);
      const balance = sql
        .exec<{ spent: number; held: number }>('SELECT spent,held FROM blend_days WHERE day = ?', day)
        .toArray()[0]!;
      if (balance.spent + balance.held + amount > limit) return false;
      sql.exec('INSERT INTO blend_reservations (id,day,amount) VALUES (?,?,?)', id, day, amount);
      sql.exec('UPDATE blend_days SET held = held + ? WHERE day = ?', amount, day);
      return true;
    });
  }
  settle(id: string, charged: number, retain: boolean) {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const lease = sql
        .exec<{ day: string; amount: number; charged: number | null; retained: number | null }>(
          'SELECT day,amount,charged,retained FROM blend_reservations WHERE id = ?',
          id,
        )
        .toArray()[0];
      if (!lease) throw Error('Unknown reservation');
      const retained = retain ? Math.max(0, lease.amount - charged) : 0;
      if (lease.charged !== null) {
        if (lease.charged !== charged || lease.retained !== retained) throw Error('Settlement conflict');
        return;
      }
      sql.exec(
        'UPDATE blend_days SET spent = spent + ?, held = held - ? WHERE day = ?',
        charged,
        lease.amount - retained,
        lease.day,
      );
      sql.exec('UPDATE blend_reservations SET charged = ?, retained = ? WHERE id = ?', charged, retained, id);
    });
  }
}

export function limit(value: string | undefined, fallback: number, integer = false): number {
  const n = value === undefined ? fallback : Number(value);
  if (value?.trim() === '' || !Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n)))
    throw Error('Invalid limit configuration');
  return n;
}
export const micro = (usd: number) => {
  const n = Math.ceil(usd * 1e6);
  if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid cost');
  return n;
};
export const dailyCap = (value: string | undefined, fallback: number) => {
  const n = Math.floor(limit(value, fallback) * 1e6);
  if (!Number.isSafeInteger(n)) throw Error('Invalid daily limit');
  return n;
};
