import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrate } from '../src/core/db.js';
import { buildApp } from '../src/app.js';
import type { Database, Config } from '../src/core/contracts.js';
import type { FastifyInstance } from 'fastify';
export async function createTestDatabase(
  options: {
    overrides?: Partial<Config>;
    migrationDirectory?: string;
    skipMigrations?: boolean;
  } = {},
) {
  const temp = await mkdtemp(join(tmpdir(), 'bloom-api-test-'));
  let db: Database | undefined;
  let control: Pool | undefined;
  let schema: string | undefined;
  let closing: Promise<void> | undefined;
  async function cleanup() {
    try {
      await db?.close();
    } finally {
      try {
        if (control && schema)
          await control.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      } finally {
        try {
          await control?.end();
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
    }
  }
  function close() {
    return (closing ??= cleanup());
  }
  try {
    const config: Config = {
      ...loadConfig({
        NODE_ENV: 'test',
        DATABASE_DRIVER: 'pglite',
        PGLITE_DIR: 'memory://',
        UPLOAD_DIR: join(temp, 'uploads'),
        MAIL_DIR: join(temp, 'mail'),
        LOG_LEVEL: 'silent',
      }),
      ...options.overrides,
    };
    if (process.env.TEST_DATABASE_URL) {
      control = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
      schema = 'bloom_test_' + randomUUID().replaceAll('-', '');
      await control.query('CREATE SCHEMA "' + schema + '"');
      config.databaseDriver = 'postgres';
      config.databaseUrl = process.env.TEST_DATABASE_URL;
      config.databaseSchema = schema;
    }
    db = await createDatabase(config);
    if (!options.skipMigrations) await migrate(db, options.migrationDirectory);
    return { db, config, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function createTestApp(overrides: Partial<Config> = {}) {
  const fixture = await createTestDatabase({ overrides });
  try {
    const app = await buildApp(fixture);
    return {
      ...fixture,
      app,
      async close() {
        try {
          await app.close();
        } finally {
          await fixture.close();
        }
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
export const testPassword = 'Bloom-Test-Password-42';
export async function registerUser(app: FastifyInstance, overrides: Record<string, unknown> = {}) {
  const input = {
    name: 'Test User',
    email: 'user-' + randomUUID() + '@example.test',
    password: testPassword,
    ...overrides,
  };
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: input });
  if (r.statusCode !== 201) throw new Error('Register failed: ' + r.body);
  const result = r.json().data;
  return {
    token: result.accessToken,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: result.user,
    password: input.password,
  };
}
export async function adminUser(app: FastifyInstance, db: Database) {
  const u = await registerUser(app, { name: 'Administrator' });
  await db.query("UPDATE users SET role='admin' WHERE id=$1", [u.user.id]);
  u.user.role = 'admin';
  return u;
}
export const bearer = (token: string) => ({ authorization: 'Bearer ' + token });
