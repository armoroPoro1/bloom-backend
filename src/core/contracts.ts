import type { FastifyInstance, FastifyRequest } from 'fastify';
export type Row = Record<string, any>;
export interface Sql {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string): Promise<void>;
}
export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  driver: 'postgres' | 'pglite';
}
export type Role = 'user' | 'seller' | 'admin';
export type Actor = {
  id: string;
  name: string;
  email: string;
  role: Role;
  blocked: boolean;
  sessionId?: string;
};
export type Config = {
  nodeEnv: string;
  host: string;
  port: number;
  databaseDriver: 'postgres' | 'pglite';
  databaseUrl: string;
  databaseSchema?: string;
  pgliteDir: string;
  uploadDir: string;
  allowedOrigins: string[];
  trustedProxyCidrs: string[];
  publicBaseUrl: string;
  frontendUrl: string;
  allowDevPayments: boolean;
  paymentReservationMinutes: number;
  backgroundJobs: boolean;
  mailIntervalSeconds: number;
  maintenanceIntervalSeconds: number;
  smtpUrl: string;
  mailFrom: string;
  mailDir: string;
  accessMinutes: number;
  refreshDays: number;
  docsEnabled: boolean;
  logLevel: string;
};
export type Context = { db: Database; config: Config };
export type RouteOptions = {
  auth?: boolean;
  roles?: Role[];
  summary: string;
  tag: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  response?: Record<string, unknown>;
  rateLimit?: number;
};
export type Handler = (request: FastifyRequest, reply: any) => any | Promise<any>;
export type Router = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RouteOptions,
  handler: Handler,
) => void;
declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}
export type Module = (app: FastifyInstance, ctx: Context, route: Router) => Promise<void>;
