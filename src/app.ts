import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { ZodError } from 'zod';
import type { Config, Database, Context, Router } from './core/contracts.js';
import { ApiError, fail, data } from './core/http.js';
import { databaseReady } from './core/db.js';
import { registerAuth, authenticate } from './modules/auth.js';
import { registerUploads } from './modules/uploads.js';
import { registerNotifications } from './modules/notifications.js';
import { registerCatalog } from './modules/catalog.js';
import { registerCommerce } from './modules/commerce.js';
import { registerWellness } from './modules/wellness.js';
export async function buildApp(options: { db: Database; config: Config }) {
  const { db, config } = options;
  const ctx: Context = { db, config };
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers.set-cookie',
              'password',
              'currentPassword',
              'newPassword',
              'accessToken',
              'refreshToken',
              'token',
            ],
          },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.trustedProxyCidrs.length ? config.trustedProxyCidrs : false,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
        multipleOfPrecision: 8,
      },
    },
  });
  app.decorateRequest('actor', null);
  await app.register(helmet);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: ['Content-Disposition', 'Retry-After', 'X-Request-Id'],
  });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) =>
      new ApiError(context.statusCode, 'RATE_LIMITED', 'Too many requests; try again later'),
  });
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });
  await app.register(swagger, {
    transform: ({ schema, url }) => ({
      schema:
        url === '/api/v1/uploads'
          ? {
              ...schema,
              consumes: ['multipart/form-data'],
              body: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
                additionalProperties: false,
              },
            }
          : schema,
      url,
    }),
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Bloom Health & Wellness API',
        version: '1.2.0',
        description:
          'Standalone Node.js/TypeScript backend. Frontend integration is intentionally not included. Monetary values use integer satang (fields ending Cents). Bearer access and rotating refresh tokens. Manual bank-transfer proof review is implemented; development payments are opt-in and prohibited in production.',
      },
      servers: [{ url: config.publicBaseUrl }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Opaque access token returned by login/register/refresh',
          },
        },
      },
    },
  });
  if (config.docsEnabled) await app.register(swaggerUI, { routePrefix: '/docs', staticCSP: true });
  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        requestId: request.id,
      });
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        requestId: request.id,
      });
    if (error.validation)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.validation.map((i: any) => ({
            path: i.instancePath,
            message: i.message,
          })),
        },
        requestId: request.id,
      });
    const sqlErrors: Record<string, [number, string, string]> = {
      '23505': [409, 'CONFLICT', 'A record with this unique value already exists'],
      '23503': [
        409,
        'REFERENCE_CONFLICT',
        'This record is missing or is referenced by other records',
      ],
      '23514': [400, 'INVALID_VALUE', 'A value violates the data constraints'],
      '22P02': [400, 'INVALID_VALUE', 'Invalid input format'],
      '22003': [400, 'INVALID_VALUE', 'Number outside permitted range'],
      '40001': [409, 'CONCURRENT_UPDATE', 'Concurrent update; retry the request'],
      '40P01': [409, 'CONCURRENT_UPDATE', 'Concurrent update; retry the request'],
    };
    if (sqlErrors[error.code]) {
      const [status, code, message] = sqlErrors[error.code];
      return reply.code(status).send({ error: { code, message }, requestId: request.id });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
      return reply.code(error.statusCode).send({
        error: {
          code: error.statusCode === 413 ? 'FILE_TOO_LARGE' : 'BAD_REQUEST',
          message: error.statusCode === 413 ? 'Request exceeds permitted size' : 'Invalid request',
        },
        requestId: request.id,
      });
    request.log.error(
      { code: error.code ?? 'INTERNAL_ERROR', requestId: request.id },
      'Request failed',
    );
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' },
      requestId: request.id,
    });
  });
  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' }, requestId: req.id }),
  );
  const route: Router = (method, path, options, handler) => {
    const auth = options.auth !== false;
    const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    const params =
      options.params ??
      (names.length
        ? {
            type: 'object',
            properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])),
            required: names,
            additionalProperties: false,
          }
        : undefined);
    app.route({
      method,
      url: path,
      schema: {
        tags: [options.tag],
        summary: options.summary,
        ...(auth ? { security: [{ bearerAuth: [] }] } : {}),
        ...(options.body ? { body: options.body } : {}),
        ...(options.query ? { querystring: options.query } : {}),
        ...(options.response ? { response: options.response } : {}),
        ...(params ? { params } : {}),
        ...(path === '/api/v1/checkout' && method === 'POST'
          ? {
              headers: {
                type: 'object',
                properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 128 } },
                required: ['idempotency-key'],
              },
            }
          : {}),
      },
      preValidation: async (req) => {
        const properties = (options.query as any)?.properties;
        if (properties) {
          const query = req.query as Record<string, unknown>;
          for (const [key, schema] of Object.entries(properties)) {
            const kind = (schema as any).type;
            const value = query[key];
            if (
              (kind === 'integer' || kind === 'number') &&
              typeof value === 'string' &&
              value.trim() !== '' &&
              Number.isFinite(Number(value))
            )
              query[key] = Number(value);
          }
        }
      },
      config: options.rateLimit
        ? { rateLimit: { max: options.rateLimit, timeWindow: '1 minute' } }
        : undefined,
      onRequest: async (_req, reply) => {
        if (auth || path.startsWith('/api/v1/auth/'))
          reply.header('Cache-Control', 'private, no-store');
      },
      preHandler: async (req) => {
        req.actor = await authenticate(req, ctx, auth);
        if (options.roles && !options.roles.includes(req.actor!.role))
          fail(403, 'FORBIDDEN', 'This role cannot perform this action');
      },
      handler,
    });
  };
  route('GET', '/health', { auth: false, tag: 'System', summary: 'Process liveness' }, () =>
    data({ status: 'ok' }),
  );
  route(
    'GET',
    '/ready',
    { auth: false, tag: 'System', summary: 'Database connectivity and migration readiness' },
    async () => {
      let ready = false;
      try {
        ready = await databaseReady(db);
      } catch {
        // A disconnected database or absent migration table is not ready.
      }
      if (!ready) fail(503, 'NOT_READY', 'Database is unavailable or migrations are not ready');
      return data({ status: 'ready' });
    },
  );
  await registerAuth(app, ctx, route);
  await registerCatalog(app, ctx, route);
  await registerCommerce(app, ctx, route);
  await registerWellness(app, ctx, route);
  await registerUploads(app, ctx, route);
  await registerNotifications(app, ctx, route);
  await app.ready();
  return app;
}
