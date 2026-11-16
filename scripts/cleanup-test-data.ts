import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/core/db.js';

async function main() {
  const db = await createDatabase(loadConfig());
  try {
    const res = await db.query("DELETE FROM categories WHERE name LIKE 'ชาและเครื่องดื่มเพื่อสุขภาพ%'");
    console.log('Cleaned test categories successfully');
  } finally {
    await db.close();
  }
}

main().catch(console.error);
