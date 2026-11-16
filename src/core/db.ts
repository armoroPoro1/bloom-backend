import { Pool, types } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Config, Database, Sql, Row } from './contracts.js';
function integer(value: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Database integer exceeds JavaScript safe range');
  return n;
}
types.setTypeParser(20, integer);
types.setTypeParser(1082, (value) => value);
function normalize<T>(value: T): T {
  if (typeof value === 'bigint') return integer(String(value)) as T;
  if (Array.isArray(value)) return value.map(normalize) as T;
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) as T;
  return value;
}
function sqlAdapter(client: any, pglite = false): Sql {
  return {
    async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return normalize(result.rows) as T[];
    },
    async one<T extends Row = Row>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return normalize(result.rows[0]) as T | undefined;
    },
    async exec(sql: string) {
      if (pglite) await client.exec(sql);
      else await client.query(sql);
    },
  };
}
export async function createDatabase(config: Config): Promise<Database> {
  if (config.databaseDriver === 'pglite') {
    if (config.nodeEnv === 'production')
      throw new Error('PGlite is for local development and tests only');
    if (config.pgliteDir !== 'memory://')
      await mkdir(resolve(config.pgliteDir), { recursive: true, mode: 0o700 });
    const engine = await PGlite.create(config.pgliteDir);
    let tail: Promise<void> = Promise.resolve();
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
      const result = tail.then(fn, fn);
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    const raw = sqlAdapter(engine, true);
    return {
      driver: 'pglite',
      query: (s, p) => exclusive(() => raw.query(s, p)),
      one: (s, p) => exclusive(() => raw.one(s, p)),
      exec: (s) => exclusive(() => raw.exec(s)),
      transaction: (fn) => exclusive(() => engine.transaction((tx) => fn(sqlAdapter(tx, true)))),
      close: () => exclusive(() => engine.close()),
    };
  }
  if (config.databaseSchema && !/^[a-z][a-z0-9_]{0,62}$/.test(config.databaseSchema))
    throw new Error('Invalid database schema');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ...(config.databaseSchema ? { options: '-c search_path=' + config.databaseSchema } : {}),
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
  const raw = sqlAdapter(pool);
  return {
    ...raw,
    driver: 'postgres',
    async transaction<T>(fn: (tx: Sql) => Promise<T>) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          const result = await fn(sqlAdapter(c));
          await c.query('COMMIT');
          return result;
        } catch (error: any) {
          await c.query('ROLLBACK').catch(() => {});
          if (!['40001', '40P01'].includes(error.code) || attempt === 2) throw error;
        } finally {
          c.release();
        }
      }
      throw new Error('Transaction retry limit');
    },
    close: () => pool.end(),
  };
}
async function readMigrations(directory: string) {
  const names = (await readdir(directory)).filter((n) => /^\d+_[a-z0-9_]+\.sql$/.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}
export async function databaseReady(db: Database, directory = resolve('migrations')) {
  const expected = await readMigrations(directory);
  const applied = await db.query('SELECT name,checksum FROM schema_migrations');
  const checksums = new Map(applied.map((row) => [row.name, row.checksum]));
  return expected.length > 0 && expected.every((row) => checksums.get(row.name) === row.checksum);
}
export async function migrate(db: Database, directory = resolve('migrations')) {
  const migrations = await readMigrations(directory);
  await db.transaction(async (tx) => {
    if (db.driver === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(2026111401)');
    await tx.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const { name, sql, checksum } of migrations) {
      const prior = await tx.one('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (prior) {
        if (prior.checksum !== checksum) throw new Error('Applied migration changed: ' + name);
        continue;
      }
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
        name,
        checksum,
      ]);
    }
  });
  return migrations.map((migration) => migration.name);
}
