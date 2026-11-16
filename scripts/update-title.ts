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

  const patchRes = await fetch('http://127.0.0.1:4000/api/v1/admin/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ siteTitle: 'Bloom', siteNotice: 'ยินดีต้อนรับสู่ Bloom ศูนย์รวมสุขภาพ' }),
  });
  console.log('Update settings status:', patchRes.status);
}

main().catch(console.error);
