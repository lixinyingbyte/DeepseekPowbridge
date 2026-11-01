import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tag } from './log.js';
import { Creds } from './creds.js';
import { Pow } from './pow.js';
import { Sessions } from './sessions.js';
import { Upstream } from './upstream.js';
import { createServer, Stats } from './server.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
function loadConfig() {
// 优先级：--config 参数 > 环境变量 DSX_CONFIG > config.json > config.example.json
const args = process.argv.slice(2);
const i = args.indexOf('--config');
let file = i >= 0 ? args[i + 1] : process.env.DSX_CONFIG;
if (!file) {
const real = path.join(ROOT, 'config.json');
file = fs.existsSync(real) ? real : path.join(ROOT, 'config.example.json');
}
if (!fs.existsSync(file)) {
throw new Error('配置文件不存在: ' + file);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
tag('BOOT', '已加载配置 ' + file);
return cfg;
}
async function main() {
const selfTest = process.argv.includes('--self-test');
const cfg = loadConfig();
const ds = cfg.deepseek || {};
const powCfg = Object.assign({
baseUrl: ds.baseUrl || 'https://chat.deepseek.com',
clientVersion: ds.clientVersion || '2.7.1',
bundleId: ds.bundleId || 'com.deepseek.chat',
locale: ds.locale || 'zh_CN',
timezoneOffset: ds.timezoneOffset || 28800,
deviceModel: (cfg.device && cfg.device.model) || 'PC',
}, cfg.pow || {});
const creds = new Creds(cfg);
const pow = new Pow(powCfg);
const sessions = new Sessions(powCfg, pow, creds);
const upstream = new Upstream(powCfg, pow, creds, sessions);
const dCfg = cfg.delta || {};
const tCfg = cfg.tools || {};
const deltaOn = dCfg.enabled !== false;
const minDelta = dCfg.minDeltaChars == null ? 1 : dCfg.minDeltaChars;
if (selfTest) {
tag('SELF', '配置加载 OK');
tag('SELF', '凭据完整: ' + creds.ok());
if (!creds.ok()) {
tag('SELF', '提示：在 config.json 的 creds.bearer / creds.deviceId 填入抓包值');
}
tag('SELF', 'PoW 模式: ' + (powCfg.mode || 'heuristic'));
tag('SELF', '上游: ' + powCfg.baseUrl);
tag('SELF', '增量发送: ' + (deltaOn ? '开启（阈值 ' + minDelta + ' 字）' : '关闭'));
tag('SELF', '工具过滤: ' + (tCfg.filterUndeclared ? '严格（丢弃未声明）' : '放行（原样透传）'));
return;
}
const stats = new Stats();
const ctx = { cfg, creds, sessions, upstream, stats };
const server = createServer(ctx);
const host = cfg.host || '127.0.0.1';
// DSX_TEST_PORT 只给冒烟测试用，避免和真实实例抢端口
const port = Number(process.env.DSX_TEST_PORT || cfg.port || 17380);
// 端口冲突时自动往后试 10 个，避免「重启一次就要手动杀进程」
const maxTries = 10;
let actualPort = port;
for (let i = 0; i < maxTries; i++) {
const tryPort = port + i;
try {
await new Promise((resolve, reject) => {
const onErr = (e) => {
server.removeListener('listening', onOk);
reject(e);
};
const onOk = () => {
server.removeListener('error', onErr);
resolve();
};
server.once('error', onErr);
server.once('listening', onOk);
server.listen(tryPort, host);
});
actualPort = tryPort;
if (i > 0) tag('BOOT', '端口 ' + port + ' 被占用，改用 ' + actualPort);
break;
} catch (e) {
if (e.code !== 'EADDRINUSE') throw e;
if (i === maxTries - 1) {
throw new Error('端口 ' + port + '-' + (port + maxTries - 1) + ' 全部被占用');
}
}
}
tag('BOOT', 'API 已启动 http://' + host + ':' + actualPort + '/v1');
tag('BOOT', '管理面板 http://' + host + ':' + actualPort + '/');
tag('BOOT', '增量发送: ' + (deltaOn ? '开启（阈值 ' + minDelta + ' 字）' : '关闭'));
tag('BOOT', '工具过滤: ' + (tCfg.filterUndeclared ? '严格（丢弃未声明）' : '放行（原样透传）'));
tag('BOOT', 'DeepSeek 客户端只需把 OpenAI base_url 指向它即可');
const shutdown = () => {
tag('BOOT', '正在关闭…');
server.close(() => process.exit(0));
setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
}
main().catch((e) => {
tag('BOOT', '启动失败: ' + (e && e.stack ? e.stack : e));
process.exit(1);
});