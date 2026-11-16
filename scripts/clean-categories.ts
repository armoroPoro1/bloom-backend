async function main() {
  const loginRes = await fetch('http://127.0.0.1:4000/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@bloom.example.test', password: 'BloomDemoPass1234!' }),
  });
  const loginJson = (await loginRes.json()) as any;
  const token = loginJson.data?.accessToken;
  if (!token) {
    console.error('Login failed:', loginJson);
    return;
  }

  const listRes = await fetch('http://127.0.0.1:4000/api/v1/categories');
  const listJson = (await listRes.json()) as any;
  const categories = listJson.data || [];

  for (const cat of categories) {
    if (cat.name.startsWith('ชาและเครื่องดื่มเพื่อสุขภาพ')) {
      const del = await fetch('http://127.0.0.1:4000/api/v1/admin/categories/' + cat.id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
      console.log(`Deleted category ${cat.name} (${cat.id}): status ${del.status}`);
    }
  }
}

main().catch(console.error);
