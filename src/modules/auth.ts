import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Context, Sql, Actor, Module, Row } from '../core/contracts.js';
import {
  hashPassword,
  verifyPassword,
  dummyPasswordCheck,
  token,
  digest,
} from '../core/security.js';
import { audit, camel, data, fail, parse, jsonSchema } from '../core/http.js';
const password = z
  .string()
  .min(10)
  .max(128)
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 256, 'Password is too long');
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const registerSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    email,
    password,
    phone: z.string().trim().max(30).default(''),
  })
  .strict();
const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
function publicUser(u: Row) {
  return camel({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    address: u.address,
    role: u.role,
    blocked: u.blocked,
    email_verified: u.email_verified,
    avatar_id: u.avatar_id,
    created_at: u.created_at,
  });
}
export async function authenticate(
  request: FastifyRequest,
  ctx: Context,
  required = true,
): Promise<Actor | null> {
  const authorization = request.headers.authorization;
  if (!authorization) {
    if (required) fail(401, 'AUTH_REQUIRED', 'Please sign in');
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) fail(401, 'INVALID_SESSION', 'Session is invalid or expired');
  const row = await ctx.db.one(
    'SELECT u.id,u.name,u.email,u.role,u.blocked,s.id AS session_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_hash=$1 AND s.access_expires_at>now() AND s.refresh_expires_at>now()',
    [digest(match[1])],
  );
  if (!row || row.blocked) fail(401, 'INVALID_SESSION', 'Session is invalid or expired');
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    blocked: row.blocked,
    sessionId: row.session_id,
  };
}
async function issue(
  tx: Sql,
  userId: string,
  ctx: Context,
  existingId?: string,
  absoluteExpiry?: Date | string,
) {
  const accessToken = token(),
    refreshToken = token();
  const issuedAt = Date.now();
  const refreshExpires = absoluteExpiry
    ? new Date(absoluteExpiry)
    : new Date(issuedAt + ctx.config.refreshDays * 86400000);
  const accessExpires = new Date(
    Math.min(issuedAt + ctx.config.accessMinutes * 60000, refreshExpires.getTime()),
  );
  if (existingId)
    await tx.query(
      'UPDATE sessions SET access_hash=$1,refresh_hash=$2,access_expires_at=$3,refresh_expires_at=$4 WHERE id=$5',
      [digest(accessToken), digest(refreshToken), accessExpires, refreshExpires, existingId],
    );
  else
    await tx.query(
      'INSERT INTO sessions(id,user_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        userId,
        digest(accessToken),
        digest(refreshToken),
        accessExpires,
        refreshExpires,
      ],
    );
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: Math.max(0, Math.floor((accessExpires.getTime() - issuedAt) / 1000)),
  };
}
async function requireCurrentAccountSession(tx: Sql, request: FastifyRequest, user?: Row) {
  const actor = request.actor!;
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
  if (!user || user.blocked || user.id !== actor.id || !bearer)
    fail(401, 'INVALID_SESSION', 'Session is invalid or expired');
  const session = await tx.one(
    'SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND access_hash=$3 AND access_expires_at>now() AND refresh_expires_at>now()',
    [actor.sessionId, actor.id, digest(bearer[1])],
  );
  if (!session) fail(401, 'INVALID_SESSION', 'Session is invalid or expired');
}
async function enqueueToken(tx: Sql, user: Row, purpose: 'reset' | 'verify', ctx: Context) {
  const secret = token();
  await tx.query('DELETE FROM account_tokens WHERE user_id=$1 AND purpose=$2', [user.id, purpose]);
  await tx.query(
    'INSERT INTO account_tokens(id,user_id,token_hash,purpose,expires_at) VALUES($1,$2,$3,$4,$5)',
    [
      randomUUID(),
      user.id,
      digest(secret),
      purpose,
      new Date(Date.now() + (purpose === 'reset' ? 30 : 24 * 60) * 60000),
    ],
  );
  const path = purpose === 'reset' ? 'reset-password' : 'verify-email';
  const url = ctx.config.frontendUrl + '/' + path + '#token=' + encodeURIComponent(secret);
  await tx.query('INSERT INTO mail_outbox(id,recipient,subject,body) VALUES($1,$2,$3,$4)', [
    randomUUID(),
    user.email,
    purpose === 'reset' ? 'Bloom: reset your password' : 'Bloom: verify your email',
    `${purpose === 'reset' ? 'ตั้งรหัสผ่าน Bloom ใหม่' : 'ยืนยันอีเมลสำหรับบัญชี Bloom'}: ${url}\nลิงก์นี้ใช้ได้ครั้งเดียวภายใน ${purpose === 'reset' ? '30 นาที' : '24 ชั่วโมง'}\nหากคุณไม่ได้ทำรายการนี้ ไม่ต้องดำเนินการใด ๆ และอย่าส่งต่อลิงก์นี้ให้ผู้อื่น`,
  ]);
}
export const registerAuth: Module = async (app, ctx, route) => {
  route(
    'POST',
    '/api/v1/auth/register',
    {
      auth: false,
      tag: 'Auth',
      summary: 'Register a customer account',
      body: jsonSchema(registerSchema),
      rateLimit: 10,
    },
    async (req, reply) => {
      const input = parse(registerSchema, req.body);
      const passHash = await hashPassword(input.password);
      const result = await ctx.db.transaction(async (tx) => {
        if (await tx.one('SELECT id FROM users WHERE email=$1', [input.email]))
          fail(409, 'ACCOUNT_EXISTS', 'An account already uses this email');
        const user = (await tx.one(
          'INSERT INTO users(id,name,email,phone,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [randomUUID(), input.name, input.email, input.phone, passHash],
        ))!;
        await enqueueToken(tx, user, 'verify', ctx);
        await audit(
          tx,
          { id: user.id, name: user.name, email: user.email, role: user.role, blocked: false },
          'account.register',
          'user',
          user.id,
        );
        return { user: publicUser(user), ...(await issue(tx, user.id, ctx)) };
      });
      reply.code(201);
      return data(result);
    },
  );
  route(
    'POST',
    '/api/v1/auth/login',
    {
      auth: false,
      tag: 'Auth',
      summary: 'Sign in with email and password',
      body: jsonSchema(loginSchema),
      rateLimit: 12,
    },
    async (req) => {
      const input = parse(loginSchema, req.body);
      const key = digest(input.email);
      const attempts = await ctx.db.one(
        'SELECT failures,window_started FROM auth_attempts WHERE identifier_hash=$1',
        [key],
      );
      if (
        attempts &&
        new Date(attempts.window_started).getTime() > Date.now() - 900000 &&
        attempts.failures >= 12
      )
        fail(429, 'LOGIN_LIMIT', 'Too many attempts; try again later');
      const user = await ctx.db.one('SELECT * FROM users WHERE email=$1', [input.email]);
      const valid = user
        ? await verifyPassword(input.password, user.password_hash)
        : (await dummyPasswordCheck(input.password), false);
      if (!user || !valid || user.blocked) {
        await ctx.db.query(
          "INSERT INTO auth_attempts(identifier_hash,failures,window_started) VALUES($1,1,now()) ON CONFLICT(identifier_hash) DO UPDATE SET failures=CASE WHEN auth_attempts.window_started<now()-interval '15 minutes' THEN 1 ELSE auth_attempts.failures+1 END,window_started=CASE WHEN auth_attempts.window_started<now()-interval '15 minutes' THEN now() ELSE auth_attempts.window_started END",
          [key],
        );
        fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      }
      return data(
        await ctx.db.transaction(async (tx) => {
          const fresh = await tx.one('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id]);
          if (
            !fresh ||
            fresh.blocked ||
            fresh.email !== input.email ||
            fresh.password_hash !== user.password_hash
          )
            fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
          await tx.query('DELETE FROM auth_attempts WHERE identifier_hash=$1', [key]);
          await tx.query('DELETE FROM sessions WHERE user_id=$1 AND refresh_expires_at<now()', [
            user.id,
          ]);
          return { user: publicUser(fresh), ...(await issue(tx, user.id, ctx)) };
        }),
      );
    },
  );
  const refreshSchema = z.object({ refreshToken: tokenSchema.shape.token }).strict();
  route(
    'POST',
    '/api/v1/auth/refresh',
    {
      auth: false,
      tag: 'Auth',
      summary: 'Rotate refresh token; replay revokes its session',
      body: jsonSchema(refreshSchema),
      rateLimit: 30,
    },
    async (req) => {
      const input = parse(refreshSchema, req.body);
      const h = digest(input.refreshToken);
      const result = await ctx.db.transaction(async (tx) => {
        const session = await tx.one('SELECT * FROM sessions WHERE refresh_hash=$1 FOR UPDATE', [
          h,
        ]);
        if (!session) {
          const used = await tx.one(
            'SELECT session_id FROM used_refresh_tokens WHERE hash=$1 AND expires_at>now()',
            [h],
          );
          if (used) await tx.query('DELETE FROM sessions WHERE id=$1', [used.session_id]);
          return null;
        }
        const user = await tx.one('SELECT * FROM users WHERE id=$1', [session.user_id]);
        if (!user || user.blocked || new Date(session.refresh_expires_at).getTime() <= Date.now()) {
          await tx.query('DELETE FROM sessions WHERE id=$1', [session.id]);
          return null;
        }
        await tx.query(
          'INSERT INTO used_refresh_tokens(hash,session_id,expires_at) VALUES($1,$2,$3)',
          [h, session.id, session.refresh_expires_at],
        );
        return {
          user: publicUser(user),
          ...(await issue(tx, user.id, ctx, session.id, session.refresh_expires_at)),
        };
      });
      if (!result) fail(401, 'INVALID_REFRESH', 'Refresh token is invalid or expired');
      return data(result);
    },
  );
  route(
    'POST',
    '/api/v1/auth/logout',
    { tag: 'Auth', summary: 'Revoke current session' },
    async (req) => {
      await ctx.db.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2', [
        req.actor!.sessionId,
        req.actor!.id,
      ]);
      return data({ loggedOut: true });
    },
  );
  route(
    'POST',
    '/api/v1/auth/logout-all',
    { tag: 'Auth', summary: 'Revoke all sessions for current user' },
    async (req) => {
      await ctx.db.query('DELETE FROM sessions WHERE user_id=$1', [req.actor!.id]);
      return data({ loggedOut: true });
    },
  );
  route('GET', '/api/v1/auth/me', { tag: 'Auth', summary: 'Current account' }, async (req) =>
    data(publicUser((await ctx.db.one('SELECT * FROM users WHERE id=$1', [req.actor!.id]))!)),
  );
  const profileSchema = z
    .object({
      name: z.string().trim().min(1).max(160).optional(),
      phone: z.string().trim().max(30).optional(),
      address: z.string().trim().max(2000).optional(),
      avatarId: z.string().uuid().nullable().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'No changes supplied');
  route(
    'PATCH',
    '/api/v1/me/profile',
    {
      tag: 'Accounts',
      summary: 'Update name/contact/address/avatar',
      body: jsonSchema(profileSchema),
    },
    async (req) => {
      const input = parse(profileSchema, req.body);
      return data(
        await ctx.db.transaction(async (tx) => {
          const current = await tx.one('SELECT * FROM users WHERE id=$1 FOR UPDATE', [
            req.actor!.id,
          ]);
          if (input.avatarId) {
            const image = await tx.one(
              "SELECT id FROM uploads WHERE id=$1 AND owner_id=$2 AND kind='avatar'",
              [input.avatarId, req.actor!.id],
            );
            if (!image) fail(400, 'INVALID_AVATAR', 'Select an avatar uploaded by this account');
          }
          const u = await tx.one(
            'UPDATE users SET name=$1,phone=$2,address=$3,avatar_id=$4,updated_at=now() WHERE id=$5 RETURNING *',
            [
              input.name ?? current!.name,
              input.phone ?? current!.phone,
              input.address ?? current!.address,
              input.avatarId === undefined ? current!.avatar_id : input.avatarId,
              req.actor!.id,
            ],
          );
          await audit(tx, req.actor!, 'account.profile', 'user', req.actor!.id);
          return publicUser(u!);
        }),
      );
    },
  );
  const changePassword = z
    .object({ currentPassword: z.string().min(1).max(128), newPassword: password })
    .strict();
  route(
    'POST',
    '/api/v1/me/change-password',
    {
      tag: 'Accounts',
      summary: 'Change password and revoke all sessions',
      body: jsonSchema(changePassword),
      rateLimit: 8,
    },
    async (req) => {
      const input = parse(changePassword, req.body);
      const user = (await ctx.db.one('SELECT password_hash,email FROM users WHERE id=$1', [
        req.actor!.id,
      ]))!;
      if (!(await verifyPassword(input.currentPassword, user.password_hash)))
        fail(400, 'WRONG_PASSWORD', 'Current password is incorrect');
      const next = await hashPassword(input.newPassword);
      await ctx.db.transaction(async (tx) => {
        const locked = await tx.one('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.actor!.id]);
        await requireCurrentAccountSession(tx, req, locked);
        if (locked!.password_hash !== user.password_hash || locked!.email !== user.email)
          fail(409, 'PASSWORD_CHANGED', 'Password changed; sign in again');
        await tx.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [
          next,
          req.actor!.id,
        ]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [req.actor!.id]);
        await tx.query("DELETE FROM account_tokens WHERE user_id=$1 AND purpose='reset'", [
          req.actor!.id,
        ]);
        await audit(tx, req.actor!, 'account.password_changed', 'user', req.actor!.id);
      });
      return data({ changed: true, signInRequired: true });
    },
  );
  const changeEmail = z.object({ email, currentPassword: z.string().min(1).max(128) }).strict();
  route(
    'POST',
    '/api/v1/me/change-email',
    {
      tag: 'Accounts',
      summary: 'Change email after password confirmation; verify the new email',
      body: jsonSchema(changeEmail),
      rateLimit: 5,
    },
    async (req) => {
      const input = parse(changeEmail, req.body);
      const user = (await ctx.db.one('SELECT * FROM users WHERE id=$1', [req.actor!.id]))!;
      if (!(await verifyPassword(input.currentPassword, user.password_hash)))
        fail(400, 'WRONG_PASSWORD', 'Current password is incorrect');
      await ctx.db.transaction(async (tx) => {
        const fresh = await tx.one('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id]);
        await requireCurrentAccountSession(tx, req, fresh);
        if (fresh!.password_hash !== user.password_hash || fresh!.email !== user.email)
          fail(409, 'ACCOUNT_CHANGED', 'Sign in again');
        await tx.query(
          'UPDATE users SET email=$1,email_verified=false,updated_at=now() WHERE id=$2',
          [input.email, user.id],
        );
        await tx.query('DELETE FROM account_tokens WHERE user_id=$1', [user.id]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
        await enqueueToken(tx, { ...user, email: input.email }, 'verify', ctx);
        await audit(tx, req.actor!, 'account.email_changed', 'user', user.id);
      });
      return data({ changed: true, signInRequired: true });
    },
  );
  const emailSchema = z.object({ email }).strict();
  route(
    'POST',
    '/api/v1/auth/forgot-password',
    {
      auth: false,
      tag: 'Auth',
      summary: 'Queue a password reset email without disclosing account existence',
      body: jsonSchema(emailSchema),
      rateLimit: 5,
    },
    async (req) => {
      const input = parse(emailSchema, req.body);
      await ctx.db.transaction(async (tx) => {
        const user = await tx.one(
          'SELECT * FROM users WHERE email=$1 AND blocked=false FOR UPDATE',
          [input.email],
        );
        if (user) await enqueueToken(tx, user, 'reset', ctx);
      });
      return data({ message: 'If the account is eligible, a reset email has been queued.' });
    },
  );
  const resetSchema = tokenSchema.extend({ newPassword: password }).strict();
  route(
    'POST',
    '/api/v1/auth/reset-password',
    {
      auth: false,
      tag: 'Auth',
      summary: 'Consume a single-use reset token and revoke all sessions',
      body: jsonSchema(resetSchema),
      rateLimit: 8,
    },
    async (req) => {
      const input = parse(resetSchema, req.body);
      const next = await hashPassword(input.newPassword);
      await ctx.db.transaction(async (tx) => {
        const t = await tx.one(
          "SELECT * FROM account_tokens WHERE token_hash=$1 AND purpose='reset' AND expires_at>now() FOR UPDATE",
          [digest(input.token)],
        );
        if (!t) fail(400, 'INVALID_TOKEN', 'Token is invalid or expired');
        const u = await tx.one('SELECT * FROM users WHERE id=$1 FOR UPDATE', [t.user_id]);
        if (!u || u.blocked) fail(400, 'INVALID_TOKEN', 'Token is invalid or expired');
        await tx.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [
          next,
          u.id,
        ]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
        await tx.query("DELETE FROM account_tokens WHERE user_id=$1 AND purpose='reset'", [u.id]);
        await audit(tx, u as Actor, 'account.password_reset', 'user', u.id);
      });
      return data({ changed: true, signInRequired: true });
    },
  );
  route(
    'POST',
    '/api/v1/auth/verify-email',
    {
      auth: false,
      tag: 'Auth',
      summary: 'Consume email verification token',
      body: jsonSchema(tokenSchema),
      rateLimit: 10,
    },
    async (req) => {
      const input = parse(tokenSchema, req.body);
      await ctx.db.transaction(async (tx) => {
        const t = await tx.one(
          "SELECT * FROM account_tokens WHERE token_hash=$1 AND purpose='verify' AND expires_at>now() FOR UPDATE",
          [digest(input.token)],
        );
        if (!t) fail(400, 'INVALID_TOKEN', 'Token is invalid or expired');
        await tx.query('UPDATE users SET email_verified=true,updated_at=now() WHERE id=$1', [
          t.user_id,
        ]);
        await tx.query("DELETE FROM account_tokens WHERE user_id=$1 AND purpose='verify'", [
          t.user_id,
        ]);
      });
      return data({ verified: true });
    },
  );
  route(
    'POST',
    '/api/v1/auth/resend-verification',
    { tag: 'Auth', summary: 'Queue a new verification email', rateLimit: 3 },
    async (req) => {
      await ctx.db.transaction(async (tx) => {
        const u = await tx.one('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.actor!.id]);
        if (!u!.email_verified) await enqueueToken(tx, u!, 'verify', ctx);
      });
      return data({ message: 'Verification email queued if needed.' });
    },
  );
};
