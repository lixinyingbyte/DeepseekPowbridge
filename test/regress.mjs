// 回归测试：DeepSeek Harness 接入相关行为
//   1) prompt.js 不向 DeepSeek 上游注入任何自造结构
//   2) DSX_CALL 与 DSML 两种工具标记都不会被当成正文流式输出
//   3) 未声明的工具调用不会透传给客户端
//   4) 上游出错时必须有 finish_reason
//   5) DSML 标记跨 chunk 拆分时仍能正确识别
// 全部离线，用假的 upstream 驱动 createServer。
//
// 注意：DSML 标签里的全角竖线和换行一律用 String.fromCharCode 在运行时
// 构造，避免源码中出现易被工具链改写的转义序列。
import http from 'node:http';
import { createServer } from '../src/server.js';
import { buildPrompt, CALL_START, CALL_END } from '../src/prompt.js';
const LF = String.fromCharCode(10);
const P2 = String.fromCharCode(0xFF5C, 0xFF5C);
const O = '<' + P2 + 'DSML' + P2;
const C = '</' + P2 + 'DSML' + P2;
function dsmlCalls(inner) {
return O + ' calls>' + inner + C + ' calls>';
}
function dsmlInvoke(name, body) {
return O + ' invoke name="' + name + '">' + body + C + ' invoke>';
}
function dsmlParam(name, value, isString) {
const attr = isString ? ' string="true"' : '';
return O + ' parameter name="' + name + '"' + attr + '>' + value + C + ' parameter>';
}
const checks = [];
function check(name, cond, extra) {
checks.push({ name, ok: !!cond, extra });
}
function startServer(upstreamBehavior, overrides) {
const ctx = {
cfg: (overrides && overrides.cfg) || {},
creds: { ok: () => true, token: () => ({ bearer: 'x', deviceId: 'y' }) },
sessions: (function () {
  const store = new Map();
  const key = (m, u) => (m || 'deepseek-chat') + '|' + (u || 'default');
  return {
    get: async () => 'sess-1',
    parentOf: () => null,
    setParent: () => {},
    historyOf: (m, u) => store.get(key(m, u)) || null,
    setHistory: (m, u, h) => { store.set(key(m, u), h); },
    reset: (m, u) => { store.delete(key(m, u)); },
    list: () => [],
  };
})(),
upstream: {
async chat(opts) {
const sink = opts.sink || {};
try {
await upstreamBehavior(sink, opts);
} catch (e) {
if (sink.onError) sink.onError(e);
}
},
},
};
const server = createServer(ctx);
return new Promise((resolve) => {
server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
}
function post(port, body) {
return new Promise((resolve, reject) => {
const data = Buffer.from(JSON.stringify(body));
const r = http.request({
host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
}, (res) => {
const chunks = [];
res.on('data', (c) => chunks.push(c));
res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
});
r.on('error', reject);
r.write(data);
r.end();
});
}
function frames(text) {
const out = [];
for (const block of text.split(LF + LF)) {
const line = block.split(LF).find((l) => l.startsWith('data:'));
if (!line) continue;
const payload = line.slice(5).trim();
if (!payload || payload === '[DONE]') continue;
try { out.push(JSON.parse(payload)); } catch (_) {}
}
return out;
}
function contentOf(fs) {
return fs.map((f) => (f.choices && f.choices[0].delta.content) || '').join('');
}
function finalReason(fs) {
for (let i = fs.length - 1; i >= 0; i--) {
const c = fs[i].choices && fs[i].choices[0];
if (c && c.finish_reason) return c.finish_reason;
}
return null;
}
function toolNamesOf(fs) {
return fs.flatMap((f) => {
const d = f.choices && f.choices[0].delta;
return d && Array.isArray(d.tool_calls) ? d.tool_calls.map((t) => t.function.name) : [];
});
}
function toolArgsOf(fs) {
return fs.flatMap((f) => {
const d = f.choices && f.choices[0].delta;
return d && Array.isArray(d.tool_calls) ? d.tool_calls.map((t) => t.function.arguments) : [];
});
}
const TOOLS_READ = [{
type: 'function',
function: { name: 'read', parameters: { properties: { file_path: {} }, required: ['file_path'] } },
}];
// ---------- 纯函数测试：prompt 不注入自造结构 ----------
{
const p = buildPrompt({
tools: TOOLS_READ,
messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }],
});
check('P1  不注入【可用工具】', !p.includes('【可用工具】'));
check('P2  不注入【调用格式】', !p.includes('【调用格式】'));
check('P3  不注入【角色】', !p.includes('【角色】'));
check('P4  不注入【最近对话】', !p.includes('【最近对话】'));
check('P5  不注入 MCP 段', !p.includes('【其它可用工具'));
check('P6  不注入 DSX_CALL 协议', !p.includes('DSX_CALL'));
check('P7  不硬编码 Bash/uname', !/uname|\bBash\b/.test(p));
check('P8  不列举工具名 read', !p.includes('read'));
check('P9  保留 system 正文', p.includes('你是助手'));
check('P10 保留 user 正文', p.includes('hi'));
}
{
const p = buildPrompt({
messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'image_url', image_url: { url: 'x' } }] }],
});
check('P11 数组 content 提取 text 片段', p.includes('你好'));
}
{
const p = buildPrompt({ messages: [{ role: 'user', content: 'hi' }] });
check('P12 单条消息时 prompt 就是纯文本', p === 'hi', JSON.stringify(p));
}
{
const p = buildPrompt({
messages: [
{ role: 'user', content: '第一句' },
{ role: 'assistant', content: '回答' },
{ role: 'user', content: '第二句' },
],
});
check('P13 多轮按顺序拼接', p === '第一句' + LF + LF + '回答' + LF + LF + '第二句', JSON.stringify(p));
}
{
const p = buildPrompt({});
check('P14 空请求不抛错且为空串', p === '');
}
// ---------- 服务层测试 ----------
async function run() {
// A：未声明工具被丢弃
{
const { server, port } = await startServer(async (sink) => {
sink.onText(CALL_START + LF + '{"calls":[{"id":"t1","tool":"Bash","command":"uname -a"}]}' + LF + CALL_END);
sink.onDone('stop');
    }, { cfg: { tools: { filterUndeclared: true } } });
const r = await post(port, {
model: 'deepseek-chat', stream: true, tools: TOOLS_READ,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
check('A1 未声明工具 Bash 被丢弃', toolNamesOf(fs).length === 0);
check('A2 控制块不出现在正文', !contentOf(fs).includes('DSX_CALL'));
check('A3 仍有 finish_reason', finalReason(fs) !== null, r.text.slice(0, 200));
server.close();
}
// B：声明过的 DSX 工具调用可解析
{
const { server, port } = await startServer(async (sink) => {
sink.onText('先看一下文件。' + LF);
sink.onText(CALL_START + LF + '{"calls":[{"id":"t1","tool":"read","path":"a.txt"}]}' + LF + CALL_END);
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-chat', stream: true, tools: TOOLS_READ,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
const names = toolNamesOf(fs);
const args = toolArgsOf(fs);
check('B1 产生 tool_calls 帧', names.length > 0, r.text.slice(0, 300));
check('B2 工具名为 read', names.includes('read'));
check('B3 参数正确', args.some((a) => a && a.includes('a.txt')), args.join('|'));
check('B4 finish_reason=tool_calls', finalReason(fs) === 'tool_calls', String(finalReason(fs)));
check('B5 正文不含控制块', !contentOf(fs).includes('DSX_CALL'));
check('B6 正文保留前置说明', contentOf(fs).includes('先看一下文件'));
const tcFrame = fs.find((f) => {
const d = f.choices && f.choices[0].delta;
return d && Array.isArray(d.tool_calls) && d.tool_calls.length > 0;
});
check('B7 tool_call delta 带 index', tcFrame.choices[0].delta.tool_calls[0].index === 0);
server.close();
}
// C：上游出错必须有 finish_reason
{
const { server, port } = await startServer(async (sink) => {
sink.onError(new Error('上游连接在收到任何正文前断开'));
});
const r = await post(port, {
model: 'deepseek-chat', stream: true,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
check('C1 出错时仍有 finish_reason', finalReason(fs) !== null, r.text.slice(0, 300));
check('C2 出错时带 error 对象', /"error"/.test(r.text));
check('C3 出错时以 [DONE] 收尾', r.text.trimEnd().endsWith('[DONE]'));
server.close();
}
// D：DSX 标记跨 chunk
{
const { server, port } = await startServer(async (sink) => {
sink.onText('好的，处理中。[[DSX');
sink.onText('_CALL]]' + LF + '{"calls":[{"id":"t1","tool":"read","path":"b.txt"}]}' + LF + CALL_END);
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-chat', stream: true, tools: TOOLS_READ,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
check('D1 跨 chunk 的控制块仍被识别', toolNamesOf(fs).includes('read'), r.text.slice(0, 400));
check('D2 正文不含残缺标记', !contentOf(fs).includes('DSX'), contentOf(fs));
check('D3 正文保留前置文本', contentOf(fs).includes('好的，处理中'));
server.close();
}
// E：非流式过滤未声明工具
{
const { server, port } = await startServer(async (sink) => {
sink.onText(CALL_START + '{"calls":[{"id":"t1","tool":"Bash","command":"ls"}]}' + CALL_END);
sink.onDone('stop');
    }, { cfg: { tools: { filterUndeclared: true } } });
const r = await post(port, {
model: 'deepseek-chat', stream: false, tools: TOOLS_READ,
messages: [{ role: 'user', content: 'hi' }],
});
const j = JSON.parse(r.text);
const choice = j.choices[0];
check('E1 非流式不返回 tool_calls', !choice.message.tool_calls);
check('E2 非流式正文不含控制块', !String(choice.message.content || '').includes('DSX_CALL'));
server.close();
}
// F：普通文本完整输出
{
const { server, port } = await startServer(async (sink) => {
sink.onText('你好，');
sink.onText('这是普通回复。');
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-chat', stream: true,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
check('F1 普通文本完整输出', contentOf(fs) === '你好，这是普通回复。', JSON.stringify(contentOf(fs)));
check('F2 finish_reason=stop', finalReason(fs) === 'stop', String(finalReason(fs)));
server.close();
}
// G：DSML 全格式解析
{
const dsml = dsmlCalls(
LF + dsmlInvoke('read', LF + dsmlParam('file_path', '/tmp/a.txt', true) + LF) + LF
);
const { server, port } = await startServer(async (sink) => {
sink.onText('我来读取文件。' + LF);
sink.onText(dsml);
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-chat', stream: true, tools: TOOLS_READ,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
const names = toolNamesOf(fs);
const args = toolArgsOf(fs);
const content = contentOf(fs);
check('G1 DSML 解析成 tool_calls', names.includes('read'), JSON.stringify(names));
check('G2 DSML 参数正确', args.some((a) => a && a.includes('/tmp/a.txt')), args.join('|'));
check('G3 DSML 标签不出现在正文', !content.includes('DSML') && !content.includes('calls>'), content);
check('G4 正文保留前置文本', content.includes('我来读取文件'));
check('G5 finish_reason=tool_calls', finalReason(fs) === 'tool_calls', String(finalReason(fs)));
server.close();
}
// H：DSML 标记跨 chunk
{
const head1 = O.slice(0, 3);
const head2 = 'DS';
const head3 = 'ML' + P2 + ' calls>' + dsmlInvoke('read', dsmlParam('p', 'x', true));
const { server, port } = await startServer(async (sink) => {
sink.onText('处理中。' + head1);
sink.onText(head2 + head3);
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-chat', stream: true, tools: TOOLS_READ,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
check('H1 跨 chunk DSML 仍被识别', toolNamesOf(fs).includes('read'), r.text.slice(0, 400));
check('H2 正文不泄漏半截标记', !contentOf(fs).includes('DSML'), contentOf(fs));
check('H3 正文保留前置文本', contentOf(fs).includes('处理中'));
server.close();
}
// I：只有 DSML 无前置文本
{
const only = dsmlCalls(dsmlInvoke('read', dsmlParam('p', 'y', true)));
const { server, port } = await startServer(async (sink) => {
sink.onText(only);
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-chat', stream: true, tools: TOOLS_READ,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
check('I1 无前置文本仍有 tool_calls', toolNamesOf(fs).includes('read'), r.text.slice(0, 300));
check('I2 正文为空', contentOf(fs) === '', JSON.stringify(contentOf(fs)));
check('I3 finish_reason=tool_calls', finalReason(fs) === 'tool_calls');
server.close();
}
// J：非流式 DSML
{
const only = dsmlCalls(dsmlInvoke('read', dsmlParam('p', 'z', true)));
const { server, port } = await startServer(async (sink) => {
sink.onText(only);
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-chat', stream: false, tools: TOOLS_READ,
messages: [{ role: 'user', content: 'hi' }],
});
const j = JSON.parse(r.text);
const choice = j.choices[0];
check('J1 非流式返回 tool_calls', Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0, r.text.slice(0, 300));
check('J2 非流式工具名 read', !!choice.message.tool_calls && choice.message.tool_calls[0].function.name === 'read');
check('J3 非流式 finish_reason=tool_calls', choice.finish_reason === 'tool_calls');
server.close();
}
// K：DSML 里 string="true" 保持字符串，无该属性时还原类型
{
const only = dsmlCalls(
dsmlInvoke('read',
dsmlParam('file_path', '123', true) +
dsmlParam('offset', '10', false) +
dsmlParam('limit', 'true', false))
);
const { server, port } = await startServer(async (sink) => {
sink.onText(only);
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-chat', stream: false,
tools: [{ type: 'function', function: { name: 'read', parameters: { properties: { file_path: {}, offset: {}, limit: {} } } } }],
messages: [{ role: 'user', content: 'hi' }],
});
const j = JSON.parse(r.text);
const tc = j.choices[0].message.tool_calls && j.choices[0].message.tool_calls[0];
let parsed = null;
try { parsed = JSON.parse(tc.function.arguments); } catch (_) {}
check('K1 string="true" 保持字符串', parsed && parsed.file_path === '123', JSON.stringify(parsed));
check('K2 无 string 属性时数字还原', parsed && parsed.offset === 10, JSON.stringify(parsed));
check('K3 无 string 属性时布尔还原', parsed && parsed.limit === true, JSON.stringify(parsed));
server.close();
}
// L：思考模式 —— model 名 / body 开关 / reasoning_effort 三种触发
{
const { server, port } = await startServer(async (sink, opts) => {
sink.onThink('先想一想');
sink.onThink('然后得出答案');
sink.onText('答案在这里');
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-reasoner', stream: false,
messages: [{ role: 'user', content: 'hi' }],
});
const j = JSON.parse(r.text);
const m = j.choices[0].message;
check('L1 非流式返回 reasoning_content', typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0, JSON.stringify(m));
check('L2 思考内容与正文分离', m.content === '答案在这里', JSON.stringify(m.content));
check('L3 x_dsx.thinking=true', j.x_dsx && j.x_dsx.thinking === true, JSON.stringify(j.x_dsx));
server.close();
}
// L4：body.thinking 显式开启（模型名不带 reasoner）
{
let sawThinking = null;
const { server, port } = await startServer(async (sink, opts) => {
sawThinking = !!opts.thinking;
sink.onThink('思考中');
sink.onText('好');
sink.onDone('stop');
});
await post(port, {
model: 'deepseek-chat', stream: false, thinking: true,
messages: [{ role: 'user', content: 'hi' }],
});
check('L4 body.thinking 透传到上游', sawThinking === true, String(sawThinking));
server.close();
}
// L5：reasoning_effort=high 也应开启思考
{
let sawThinking = null;
const { server, port } = await startServer(async (sink, opts) => {
sawThinking = !!opts.thinking;
sink.onText('ok');
sink.onDone('stop');
});
await post(port, {
model: 'deepseek-chat', stream: false, reasoning_effort: 'high',
messages: [{ role: 'user', content: 'hi' }],
});
check('L5 reasoning_effort=high 开启思考', sawThinking === true, String(sawThinking));
server.close();
}
// L6：reasoning_effort=none 不开启
{
let sawThinking = null;
const { server, port } = await startServer(async (sink, opts) => {
sawThinking = !!opts.thinking;
sink.onText('ok');
sink.onDone('stop');
});
await post(port, {
model: 'deepseek-chat', stream: false, reasoning_effort: 'none',
messages: [{ role: 'user', content: 'hi' }],
});
check('L6 reasoning_effort=none 不开思考', sawThinking === false, String(sawThinking));
server.close();
}
// L7：流式思考内容走 reasoning_content 字段
{
const { server, port } = await startServer(async (sink) => {
sink.onThink('想一想');
sink.onText('答案');
sink.onDone('stop');
});
const r = await post(port, {
model: 'deepseek-reasoner', stream: true,
messages: [{ role: 'user', content: 'hi' }],
});
const fs = frames(r.text);
const think = fs.map((f) => (f.choices && f.choices[0].delta.reasoning_content) || '').join('');
check('L7 流式 reasoning_content 有内容', think === '想一想', JSON.stringify(think));
check('L8 流式正文不含思考', contentOf(fs) === '答案', JSON.stringify(contentOf(fs)));
server.close();
}
// M：增量 —— 历史前缀一致时只发新增消息
{
const sent = [];
const { server, port } = await startServer(async (sink, opts) => {
sent.push(opts.prompt);
sink.onText('ok');
sink.onDone('stop');
});
const base = [{ role: 'user', content: '第一问' }];
const r1 = await post(port, {
model: 'deepseek-chat', stream: false, messages: base,
});
const j1 = JSON.parse(r1.text);
const full1 = j1.x_dsx;
const conv2 = base.concat([
{ role: 'assistant', content: '第一答' },
{ role: 'user', content: '第二问' },
]);
const r2 = await post(port, {
model: 'deepseek-chat', stream: false, messages: conv2,
});
const j2 = JSON.parse(r2.text);
const full2 = j2.x_dsx;
check('M1 首次请求是 full', full1.delta_mode === 'full', JSON.stringify(full1));
check('M2 第二次是 delta', full2.delta_mode === 'delta', JSON.stringify(full2));
check('M3 delta 只发新增消息', full2.sent_messages === 1, String(full2.sent_messages));
check('M4 delta 节省字数大于 0', full2.full_chars > full2.sent_chars, full2.full_chars + '/' + full2.sent_chars);
check('M5 第二次 prompt 只有第二问', sent[1] === '第二问', JSON.stringify(sent[1]));
check('M6 首次 prompt 只有第一问', sent[0] === '第一问', JSON.stringify(sent[0]));
server.close();
}
// M7：历史被改写（前缀不一致）时退回 full
{
const sent = [];
const { server, port } = await startServer(async (sink, opts) => {
sent.push(opts.prompt);
sink.onText('ok');
sink.onDone('stop');
});
await post(port, {
model: 'deepseek-chat', stream: false,
messages: [{ role: 'user', content: '原始问题' }],
});
const r2 = await post(port, {
model: 'deepseek-chat', stream: false,
messages: [{ role: 'user', content: '改过的问题' }],
});
const j2 = JSON.parse(r2.text);
check('M7 前缀不一致退回 full', j2.x_dsx.delta_mode === 'full', JSON.stringify(j2.x_dsx));
check('M8 全量重发', sent[1] === '改过的问题', JSON.stringify(sent[1]));
server.close();
}
// M9：new_session 强制重置后回到 full
{
const { server, port } = await startServer(async (sink) => {
sink.onText('ok');
sink.onDone('stop');
});
const conv = [{ role: 'user', content: 'A' }];
await post(port, { model: 'deepseek-chat', stream: false, messages: conv });
const r2 = await post(port, {
model: 'deepseek-chat', stream: false, new_session: true,
messages: conv.concat([
{ role: 'assistant', content: 'ok' },
{ role: 'user', content: 'B' },
]),
});
const j2 = JSON.parse(r2.text);
check('M9 new_session 后回到 full', j2.x_dsx.delta_mode === 'full', JSON.stringify(j2.x_dsx));
server.close();
}
let pass = 0;
for (const c of checks) {
if (c.ok) pass++;
console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '  ' + (c.extra || '')));
}
console.log(LF + pass + '/' + checks.length + ' 通过');
process.exit(pass === checks.length ? 0 : 1);
}
run().catch((e) => {
console.error('测试异常:', e);
process.exit(1);
});