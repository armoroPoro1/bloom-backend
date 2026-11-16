import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { createDatabase, migrate } from '../src/core/db.js';
import { hashPassword } from '../src/core/security.js';
import type { Database, Row } from '../src/core/contracts.js';

/** Stable development fixture IDs. They are not legacy frontend p1/u1/s1 IDs. */
export const seedId = (group: number, item: number) =>
  `b1000000-${group.toString(16).padStart(4, '0')}-4000-8000-${item.toString(16).padStart(12, '0')}`;
const users = [
  { id: seedId(1, 1), name: 'Bloom Buyer — Demo', email: 'buyer@bloom.example.test', role: 'user' },
  {
    id: seedId(1, 2),
    name: 'Bloom Seller — Demo',
    email: 'seller@bloom.example.test',
    role: 'seller',
  },
  {
    id: seedId(1, 3),
    name: 'Rose Seller — Demo',
    email: 'rose@bloom.example.test',
    role: 'seller',
  },
  {
    id: seedId(1, 4),
    name: 'Move Seller — Demo',
    email: 'move@bloom.example.test',
    role: 'seller',
  },
  {
    id: seedId(1, 5),
    name: 'Bowl Seller — Demo',
    email: 'bowl@bloom.example.test',
    role: 'seller',
  },
  {
    id: seedId(1, 6),
    name: 'Luna Applicant — Demo',
    email: 'pending@bloom.example.test',
    role: 'user',
  },
  {
    id: seedId(1, 7),
    name: 'Bloom Admin — Demo',
    email: 'admin@bloom.example.test',
    role: 'admin',
  },
];
const categories = [
  { id: seedId(2, 1), name: 'วิตามิน & อาหารเสริม', icon: 'pill' },
  { id: seedId(2, 2), name: 'สกินแคร์ & ความงาม', icon: 'sparkles' },
  { id: seedId(2, 3), name: 'อุปกรณ์ออกกำลังกาย', icon: 'dumbbell' },
  { id: seedId(2, 4), name: 'อาหารเพื่อสุขภาพ', icon: 'salad' },
  { id: seedId(2, 5), name: 'ไลฟ์สไตล์สุขภาพ', icon: 'heart' },
];
const shops = [
  {
    id: seedId(3, 1),
    owner: users[1],
    name: 'Bloom Official',
    description: 'สิ่งดี ๆ สำหรับการดูแลตัวเองในทุกวัน — ร้านตัวอย่าง',
    status: 'approved',
  },
  {
    id: seedId(3, 2),
    owner: users[2],
    name: 'Rose & Ritual',
    description: 'Everyday skin rituals — ร้านตัวอย่างโทนโรส',
    status: 'approved',
  },
  {
    id: seedId(3, 3),
    owner: users[3],
    name: 'Move Studio',
    description: 'เคลื่อนไหวในจังหวะของคุณ — ร้านอุปกรณ์ตัวอย่าง',
    status: 'approved',
  },
  {
    id: seedId(3, 4),
    owner: users[4],
    name: 'The Good Bowl',
    description: 'เมนูและธัญพืชสำหรับทดลองระบบร้านค้า',
    status: 'approved',
  },
  {
    id: seedId(3, 5),
    owner: users[5],
    name: 'Luna Wellness',
    description: 'ใบสมัครร้านตัวอย่างที่รอแอดมินอนุมัติ',
    status: 'pending',
  },
];
const products = [
  {
    id: seedId(4, 1),
    name: 'Bloom Vitamin C Complex',
    englishName: 'วิตามินซี • 30 แคปซูล',
    category: 1,
    shop: 1,
    price: 39000,
    original: 49000,
    image: 0,
    stock: 24,
    badge: 'BEST SELLER',
  },
  {
    id: seedId(4, 2),
    name: 'Rose Hydrating Serum',
    englishName: 'เซรั่มบำรุงผิว • 30 มล.',
    category: 2,
    shop: 2,
    price: 69000,
    original: 89000,
    image: 1,
    stock: 18,
    badge: '-22%',
  },
  {
    id: seedId(4, 3),
    name: 'Everyday Yoga Mat',
    englishName: 'เสื่อโยคะสีลาเวนเดอร์ • 6 มม.',
    category: 3,
    shop: 3,
    price: 89000,
    original: 109000,
    image: 2,
    stock: 16,
    badge: 'NEW',
  },
  {
    id: seedId(4, 4),
    name: 'Plant Protein — Vanilla',
    englishName: 'โปรตีนจากพืช • 500 กรัม',
    category: 1,
    shop: 1,
    price: 119000,
    original: 139000,
    image: 3,
    stock: 12,
    badge: '',
  },
  {
    id: seedId(4, 5),
    name: 'Rainbow Nourish Bowl',
    englishName: 'ธัญพืชและผักหลากสี • 1 ชุด',
    category: 4,
    shop: 4,
    price: 18900,
    original: 21900,
    image: 4,
    stock: 20,
    badge: 'FRESH PICK',
  },
  {
    id: seedId(4, 6),
    name: 'Bloom Daily Bottle',
    englishName: 'กระบอกน้ำสีโรส • 750 มล.',
    category: 5,
    shop: 1,
    price: 49000,
    original: 59000,
    image: 5,
    stock: 28,
    badge: '',
  },
  {
    id: seedId(4, 7),
    name: 'Daily Glow Essentials',
    englishName: 'ชุดดูแลผิวประจำวัน • 2 ชิ้น',
    category: 2,
    shop: 2,
    price: 99000,
    original: 129000,
    image: 1,
    stock: 9,
    badge: 'SET',
  },
  {
    id: seedId(4, 8),
    name: 'Morning Greens Bowl',
    englishName: 'มื้อเช้าสไตล์คลีน • 1 ชุด',
    category: 4,
    shop: 4,
    price: 15900,
    original: 18900,
    image: 4,
    stock: 15,
    badge: '',
  },
  {
    id: seedId(4, 9),
    name: 'Soft Flow Starter Set',
    englishName: 'ชุดเสื่อโยคะและบล็อก • 1 ชุด',
    category: 3,
    shop: 3,
    price: 129000,
    original: 159000,
    image: 2,
    stock: 8,
    badge: '',
  },
  {
    id: seedId(4, 10),
    name: 'Bloom Vitamin Daily Set',
    englishName: 'วิตามินแบบแพ็กคู่ • 2 กระปุก',
    category: 1,
    shop: 1,
    price: 69000,
    original: 98000,
    image: 0,
    stock: 10,
    badge: 'VALUE SET',
  },
  {
    id: seedId(4, 11),
    name: 'Plant Protein — Original',
    englishName: 'โปรตีนจากพืช • 500 กรัม',
    category: 1,
    shop: 1,
    price: 109000,
    original: 129000,
    image: 3,
    stock: 14,
    badge: '',
  },
  {
    id: seedId(4, 12),
    name: 'Everyday Hydration Bottle',
    englishName: 'กระบอกน้ำพกพา • 500 มล.',
    category: 5,
    shop: 1,
    price: 39000,
    original: 49000,
    image: 5,
    stock: 19,
    badge: '',
  },
];
const foods = [
  { id: seedId(7, 1), name: 'ข้าวและผักตัวอย่าง', detail: '1 จานตัวอย่าง', kcal: 250, group: 'อาหารหลัก' },
  { id: seedId(7, 2), name: 'สลัดธัญพืชตัวอย่าง', detail: '1 ชามตัวอย่าง', kcal: 320, group: 'อาหารหลัก' },
  { id: seedId(7, 3), name: 'โยเกิร์ตตัวอย่าง', detail: '1 ถ้วยตัวอย่าง', kcal: 150, group: 'ของว่าง' },
  { id: seedId(7, 4), name: 'ผลไม้ตัวอย่าง', detail: '1 ส่วนตัวอย่าง', kcal: 100, group: 'ของว่าง' },
  {
    id: seedId(7, 5),
    name: 'เมนูร่างที่ปิดใช้งาน',
    detail: '1 ส่วนตัวอย่าง',
    kcal: 200,
    group: 'อาหารหลัก',
    active: false,
  },
];

export async function seedDevelopment(db: Database, password: string) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Demo seeding is disabled in production');
  z.string().min(12).max(128).parse(password);
  let created: Record<string, number> = {};
  const count = (entity: string, row: Row | undefined) => {
    if (row) created[entity] = (created[entity] ?? 0) + 1;
    return row;
  };
  await db.transaction(async (tx) => {
    // PostgreSQL may retry a serializable transaction; report only the committed attempt.
    created = {};
    // Seed reruns never set roles, passwords, stock or existing content back to defaults.
    for (const u of users) {
      const prior = await tx.one('SELECT id FROM users WHERE id=$1', [u.id]);
      if (prior) continue;
      const hash = await hashPassword(password);
      const inserted = await tx.one(
        'INSERT INTO users(id,name,email,password_hash,role,email_verified) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING RETURNING id',
        [u.id, u.name, u.email, hash, u.role],
      );
      if (!inserted)
        throw new Error(
          'Seed account identifier/email collision; no seed records were committed. Existing accounts were not changed.',
        );
      count('users', inserted);
    }
    for (const c of categories) {
      count(
        'categories',
        await tx.one(
          'INSERT INTO categories(id,name,icon,description) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
          [c.id, c.name, c.icon, 'หมวดหมู่ตัวอย่างสำหรับพัฒนา Bloom'],
        ),
      );
      if (!(await tx.one('SELECT id FROM categories WHERE id=$1', [c.id])))
        throw new Error(
          'Seed category name collides with an existing category; existing data was preserved.',
        );
    }
    for (const s of shops) {
      count(
        'shops',
        await tx.one(
          'INSERT INTO shops(id,owner_id,name,email,description,status,shipping_fee_cents,free_shipping_at_cents) VALUES($1,$2,$3,$4,$5,$6,4000,99900) ON CONFLICT DO NOTHING RETURNING id',
          [s.id, s.owner.id, s.name, s.owner.email, s.description, s.status],
        ),
      );
      if (!(await tx.one('SELECT id FROM shops WHERE id=$1', [s.id])))
        throw new Error(
          'Seed shop ownership collides with an existing shop; existing data was preserved.',
        );
    }
    for (const p of products) {
      const inserted = count(
        'products',
        await tx.one(
          'INSERT INTO products(id,shop_id,category_id,name,english_name,description,price_cents,original_price_cents,image_index,badge,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) ON CONFLICT DO NOTHING RETURNING id',
          [
            p.id,
            seedId(3, p.shop),
            seedId(2, p.category),
            p.name,
            p.englishName,
            'สินค้า ราคา และจำนวนสต็อกเป็นข้อมูลสมมติสำหรับทดลองระบบ Bloom ไม่ใช่รายการขายจริง',
            p.price,
            p.original,
            p.image,
            p.badge,
            p.stock,
          ],
        ),
      );
      if (inserted)
        count(
          'stockMovements',
          await tx.one(
            'INSERT INTO stock_movements(id,product_id,shop_id,change,balance,reason,actor_id) VALUES($1,$2,$3,$4,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
            [
              seedId(11, products.indexOf(p) + 1),
              p.id,
              seedId(3, p.shop),
              p.stock,
              'Initial development fixture; not a transaction',
              users[6].id,
            ],
          ),
        );
    }
    count(
      'addresses',
      await tx.one(
        'INSERT INTO addresses(id,user_id,label,name,phone,address,is_default) SELECT $1,$2,$3,$4,$5,$6,NOT EXISTS(SELECT 1 FROM addresses WHERE user_id=$2 AND is_default) ON CONFLICT DO NOTHING RETURNING id',
        [
          seedId(12, 1),
          users[0].id,
          'ที่อยู่ตัวอย่าง',
          'ลูกค้าตัวอย่าง',
          '0000000000',
          'TEST ADDRESS — development fixture only; not a delivery destination',
        ],
      ),
    );
    count(
      'promotions',
      await tx.one(
        'INSERT INTO promotions(id,code,title,percent_basis_points,active,min_spend_cents) VALUES($1,$2,$3,1000,true,0) ON CONFLICT DO NOTHING RETURNING id',
        [seedId(5, 1), 'BLOOM10', 'คูปองตัวอย่าง ลด 10%'],
      ),
    );
    count(
      'promotions',
      await tx.one(
        'INSERT INTO promotions(id,code,title,shop_id,percent_basis_points,active,min_spend_cents,max_discount_cents,usage_limit) VALUES($1,$2,$3,$4,1500,true,10000,10000,50) ON CONFLICT DO NOTHING RETURNING id',
        [seedId(5, 2), 'ROSE15', 'คูปองร้านตัวอย่าง ลด 15%', seedId(3, 2)],
      ),
    );
    const articles = [
      {
        id: seedId(6, 1),
        title: 'บันทึกสิ่งเล็ก ๆ ในทุกวัน',
        subtitle: 'เริ่มจากบันทึกกิจกรรมของตัวเอง',
        category: 'ไลฟ์สไตล์',
        tag: 'routine',
        published: true,
        paras: [
          'บทความตัวอย่างสำหรับแสดงรายการ ค้นหา และบันทึกบทความโปรดในระบบ Bloom',
          'ผู้ใช้สามารถกรอกบันทึกอาหารและกิจกรรมของตัวเองได้ ข้อมูลในระบบตัวอย่างไม่ใช่คำแนะนำด้านสุขภาพเฉพาะบุคคล',
        ],
      },
      {
        id: seedId(6, 2),
        title: 'รู้จักบันทึกมื้ออาหาร',
        subtitle: 'ตัวอย่างการจัดข้อมูลอาหาร',
        category: 'อาหาร',
        tag: 'journal',
        published: true,
        paras: [
          'หน้าอาหารแสดงรายการที่ผู้ดูแลกรอก พร้อมหน่วยบริโภคและค่าพลังงานตัวอย่าง',
          'เมื่อบันทึกลงไดอารี ระบบจะเก็บชื่อและค่าพลังงาน ณ วันบันทึกไว้ แม้รายการอาหารต้นทางจะเปลี่ยนภายหลัง',
        ],
      },
      {
        id: seedId(6, 3),
        title: 'บทความร่างสำหรับทดสอบ CMS',
        subtitle: 'ยังไม่เผยแพร่',
        category: 'ทั่วไป',
        tag: 'draft',
        published: false,
        paras: ['ผู้ดูแลสามารถแก้ไขและเผยแพร่บทความนี้ได้'],
      },
    ];
    for (const a of articles)
      count(
        'articles',
        await tx.one(
          'INSERT INTO articles(id,title,subtitle,category,tag,reading_time,paragraphs,published) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING RETURNING id',
          [
            a.id,
            a.title,
            a.subtitle,
            a.category,
            a.tag,
            '2 นาที',
            JSON.stringify(a.paras),
            a.published,
          ],
        ),
      );
    for (const f of foods)
      count(
        'foods',
        await tx.one(
          'INSERT INTO foods(id,name,detail,kcal,group_name,active) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
          [f.id, f.name, f.detail, f.kcal, f.group, f.active !== false],
        ),
      );
    const mealTemplates = [
      {
        id: seedId(8, 1),
        name: 'มื้ออาหารตัวอย่าง',
        active: true,
        entries: [
          { food: 1, meal: 'กลางวัน', portions: 1 },
          { food: 3, meal: 'ของว่าง', portions: 1 },
        ],
      },
      {
        id: seedId(8, 2),
        name: 'ชุดเมนูร่าง',
        active: false,
        entries: [{ food: 2, meal: 'เย็น', portions: 1 }],
      },
    ];
    for (const t of mealTemplates) {
      const inserted = count(
        'mealTemplates',
        await tx.one(
          'INSERT INTO meal_templates(id,name,description,active) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
          [
            t.id,
            t.name,
            'ชุดข้อมูลตัวอย่างสำหรับทดสอบการคัดลอกมื้ออาหาร ไม่ใช่แผนโภชนาการเฉพาะบุคคล',
            t.active,
          ],
        ),
      );
      // Do not repopulate entries deleted or edited by a developer after a previous seed.
      if (inserted)
        for (const [position, e] of t.entries.entries())
          count(
            'mealTemplateEntries',
            await tx.one(
              'INSERT INTO meal_template_entries(id,template_id,food_id,meal,portions,position) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
              [
                seedId(13, (t.id === seedId(8, 1) ? 10 : 20) + position),
                t.id,
                seedId(7, e.food),
                e.meal,
                e.portions,
                position,
              ],
            ),
          );
    }
    const days = Array.from({ length: 7 }, (_, day) =>
      day === 0 || day === 2 || day === 4
        ? [{ id: seedId(10, day + 1), name: 'เดิน — กิจกรรมตัวอย่าง', minutes: 20, type: 'ทั่วไป' }]
        : [],
    );
    count(
      'exerciseTemplates',
      await tx.one(
        'INSERT INTO exercise_templates(id,name,description,active,days) VALUES($1,$2,$3,true,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id',
        [
          seedId(9, 1),
          'สัปดาห์ตัวอย่าง Bloom',
          'ตารางตัวอย่างสำหรับทดลองคัดลอกและทำเครื่องหมายกิจกรรม ผู้ใช้ปรับเองได้',
          JSON.stringify(days),
        ],
      ),
    );
    count(
      'exerciseTemplates',
      await tx.one(
        'INSERT INTO exercise_templates(id,name,description,active,days) VALUES($1,$2,$3,false,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id',
        [
          seedId(9, 2),
          'ตารางร่าง',
          'ตัวอย่างตารางที่ยังไม่เปิดใช้',
          JSON.stringify(Array.from({ length: 7 }, () => [])),
        ],
      ),
    );
  });
  const accounts = await db.query(
    'SELECT id,email,role FROM users WHERE id=ANY($1::uuid[]) ORDER BY email',
    [users.map((u) => u.id)],
  );
  return { created, accounts, preservedExistingRecords: true };
}

export async function runSeed(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production') throw new Error('Demo seeding is disabled in production');
  const password = z
    .string()
    .min(12, 'SEED_DEMO_PASSWORD must contain at least 12 characters')
    .max(128)
    .parse(env.SEED_DEMO_PASSWORD);
  const config = loadConfig(env);
  if (config.nodeEnv === 'production') throw new Error('Demo seeding is disabled in production');
  const db = await createDatabase(config);
  try {
    await migrate(db);
    return await seedDevelopment(db, password);
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runSeed();
    console.log('Development seed completed. Existing records and passwords were preserved.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error: any) {
    console.error(
      error instanceof z.ZodError
        ? 'SEED_DEMO_PASSWORD must contain 12–128 characters.'
        : error.message,
    );
    process.exitCode = 1;
  }
}
