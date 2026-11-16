import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/core/db.js';
import { hashPassword } from '../src/core/security.js';
const input = z
  .object({
    ADMIN_EMAIL: z
      .string()
      .trim()
      .email()
      .transform((v) => v.toLowerCase()),
    ADMIN_PASSWORD: z.string().min(12).max(128),
    ADMIN_NAME: z.string().trim().min(1).default('Bloom Administrator'),
  })
  .parse(process.env);
const db = await createDatabase(loadConfig());
try {
  const hash = await hashPassword(input.ADMIN_PASSWORD);
  const user = await db.one(
    "INSERT INTO users(name,email,password_hash,role,email_verified) VALUES($1,$2,$3,'admin',true) RETURNING id,email",
    [input.ADMIN_NAME, input.ADMIN_EMAIL, hash],
  );
  console.log('Administrator created:', user!.id, user!.email);
} finally {
  await db.close();
}
