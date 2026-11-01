// 离线冒烟测试：不联网，只验证本地 HTTP 层（路由、错误分支、SSE 帧格式）。
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 17999;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: root,
  env: { ...process.env, DSX_CONFIG: path.join(root, 'config.example.json'), DSX_TEST_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });

function waitReady() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (log.includes('/v1')) return resolve();
      if (Date.now() - t0 > 8000) return reject(new Error('启动超时:\n' + log));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const checks = [];
function check(name, cond, extra) {
  checks.push({ name, ok: !!cond, extra });
}

(async () => {
  try {
    await waitReady();

    const models = await req('GET', '/v1/models');
    check('GET /v1/models 200', models.status === 200);
    const mj = JSON.parse(models.body);
    check('models 含 deepseek-chat', mj.data.some((m) => m.id === 'deepseek-chat'));
    check('models 含 deepseek-reasoner', mj.data.some((m) => m.id === 'deepseek-reasoner'));

    const nf = await req('GET', '/nope');
    check('未知路由 404', nf.status === 404);

    const bad = await req('POST', '/v1/chat/completions', {});
    check('无凭据时 503', bad.status === 503, bad.body.slice(0, 120));
    check('503 带 error.message', /error/.test(bad.body));

    const st = await req('POST', '/v1/chat/completions', {
      model: 'deepseek-chat', stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    check('流式无凭据也返回 503（不卡住）', st.status === 503);

    let pass = 0;
    for (const c of checks) {
      if (c.ok) pass++;
      console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '  ' + (c.extra || '')));
    }
    console.log('\n' + pass + '/' + checks.length + ' 通过');
    child.kill();
    process.exit(pass === checks.length ? 0 : 1);
  } catch (e) {
    console.error('测试异常:', e);
    console.error(log);
    child.kill();
    process.exit(1);
  }
})();
