import 'dotenv/config';
import { z } from 'zod';
import { isIP } from 'node:net';
import type { Config } from './core/contracts.js';
const bool = (fallback: string) =>
  z
    .enum(['true', 'false'])
    .default(fallback as 'true' | 'false')
    .transform((v) => v === 'true');
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(4000),
      DATABASE_DRIVER: z.enum(['postgres', 'pglite']).default('pglite'),
      DATABASE_URL: z.string().default(''),
      PGLITE_DIR: z.string().default('./var/database'),
      UPLOAD_DIR: z.string().default('./var/uploads'),
      CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
      TRUST_PROXY_CIDRS: z.string().default(''),
      PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
      FRONTEND_URL: z.string().url().default('http://localhost:5173'),
      ALLOW_DEV_PAYMENTS: bool('false'),
      PAYMENT_RESERVATION_MINUTES: z.coerce.number().int().min(5).max(10080).default(1440),
      BACKGROUND_JOBS: bool('true'),
      MAIL_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(10),
      MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
      SMTP_URL: z.string().default(''),
      MAIL_FROM: z.string().default('Bloom <noreply@example.test>'),
      MAIL_DIR: z.string().default('./var/mail'),
      ACCESS_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
      REFRESH_DAYS: z.coerce.number().int().min(1).max(90).default(30),
      DOCS_ENABLED: bool('true'),
      LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
    })
    .parse(env);
  if (e.NODE_ENV === 'production') {
    if (e.DATABASE_DRIVER !== 'postgres' || !e.DATABASE_URL)
      throw new Error('Production requires PostgreSQL DATABASE_URL');
    if (e.ALLOW_DEV_PAYMENTS)
      throw new Error('Development payments must be disabled in production');
    if (!e.PUBLIC_BASE_URL.startsWith('https://') || !e.FRONTEND_URL.startsWith('https://'))
      throw new Error('Production public and frontend URLs must use HTTPS');
    if (!e.SMTP_URL) throw new Error('Production requires SMTP_URL for account recovery');
  }
  if (e.DATABASE_DRIVER === 'postgres' && !e.DATABASE_URL)
    throw new Error('DATABASE_URL is required with postgres');
  for (const [name, value] of [
    ['PUBLIC_BASE_URL', e.PUBLIC_BASE_URL],
    ['FRONTEND_URL', e.FRONTEND_URL],
  ]) {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(name + ' must use HTTP(S) without credentials, query or fragment');
  }
  if (e.SMTP_URL) {
    let smtp: URL;
    try {
      smtp = new URL(e.SMTP_URL);
    } catch {
      throw new Error('SMTP_URL must be a valid smtp:// or smtps:// URL');
    }
    if (
      !['smtp:', 'smtps:'].includes(smtp.protocol) ||
      !smtp.hostname ||
      (smtp.pathname && smtp.pathname !== '/') ||
      smtp.search ||
      smtp.hash
    )
      throw new Error('SMTP_URL must use smtp:// or smtps:// without a path, query or fragment');
  }
  const origins = e.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const trustedProxyCidrs = [
    ...new Set(
      e.TRUST_PROXY_CIDRS.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  for (const entry of trustedProxyCidrs) {
    const parts = entry.split('/');
    const family = isIP(parts[0]);
    if (
      !family ||
      parts.length > 2 ||
      (parts.length === 2 &&
        (!/^\d+$/.test(parts[1]) ||
          Number(parts[1]) < 1 ||
          Number(parts[1]) > (family === 4 ? 32 : 128)))
    )
      throw new Error(
        'TRUST_PROXY_CIDRS must contain explicit IP addresses or bounded CIDRs, not a wildcard, hostname or hop count',
      );
  }
  for (const origin of origins) {
    if (origin === '*') continue;
    const u = new URL(origin);
    if (u.origin !== origin || !['http:', 'https:'].includes(u.protocol))
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins');
    if (e.NODE_ENV === 'production' && u.protocol !== 'https:')
      throw new Error('Production CORS origins must use HTTPS');
  }
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseDriver: e.DATABASE_DRIVER,
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    uploadDir: e.UPLOAD_DIR,
    allowedOrigins: origins,
    trustedProxyCidrs,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ''),
    frontendUrl: e.FRONTEND_URL.replace(/\/$/, ''),
    allowDevPayments: e.ALLOW_DEV_PAYMENTS,
    paymentReservationMinutes: e.PAYMENT_RESERVATION_MINUTES,
    backgroundJobs: e.BACKGROUND_JOBS,
    mailIntervalSeconds: e.MAIL_INTERVAL_SECONDS,
    maintenanceIntervalSeconds: e.MAINTENANCE_INTERVAL_SECONDS,
    smtpUrl: e.SMTP_URL,
    mailFrom: e.MAIL_FROM,
    mailDir: e.MAIL_DIR,
    accessMinutes: e.ACCESS_MINUTES,
    refreshDays: e.REFRESH_DAYS,
    docsEnabled: e.DOCS_ENABLED,
    logLevel: e.LOG_LEVEL,
  };
}
