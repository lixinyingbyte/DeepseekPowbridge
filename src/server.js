import http from 'node:http';
import crypto from 'node:crypto';
import { tag, trim } from './log.js';
import { buildPromptFromMessages, TOOL_MARKERS } from './prompt.js';
import { parseToolCalls } from './toolcalls.js';
import { computeDelta, makeHistory, countChars } from './diff.js';
import { renderDashboard } from './ui.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(HERE, 'ui-client.js');
function uuid() {
return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '');
}
function readBody(req) {
return new Promise((resolve, reject) => {
const chunks = [];
req.on('data', (c) => chunks.push(c));
req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
req.on('error', reject);
});
}
function writeJson(res, code, obj) {
const data = Buffer.from(JSON.stringify(obj), 'utf8');
res.writeHead(code, {
'Content-Type': 'application/json; charset=utf-8',
'Content-Length': data.length,
'Cache-Control': 'no-store',
'Connection': 'close',
});
res.end(data);
}
function writeHtml(res, html) {
const data = Buffer.from(html, 'utf8');
res.writeHead(200, {
'Content-Type': 'text/html; charset=utf-8',
'Content-Length': data.length,
'Cache-Control': 'no-store',
});
res.end(data);
}
/** 把磁盘上的前端脚本原样返回（不拼接、不转义）。 */
function writeScript(res, file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (e) {
    tag('API', '读取脚本失败: ' + e.message);
    writeJson(res, 500, { error: { message: 'ui-client.js 读取失败: ' + e.message } });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function modelsJson() {
  const ids = ['deepseek-chat', 'deepseek-reasoner'];
  return {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', owned_by: 'deepseek' })),
  };
}
function chunkFrame(id, model, delta, finishReason) {
return 'data: ' + JSON.stringify({
id,
object: 'chat.completion.chunk',
created: Math.floor(Date.now() / 1000),
model,
choices: [{
index: 0,
delta: delta || {},
finish_reason: finishReason === undefined ? null : finishReason,
}],
}) + '\n\n';
}
function toolCallDelta(tcs) {
return {
tool_calls: tcs.map((tc, i) => ({
index: i,
id: tc.id,
type: 'function',
function: { name: tc.function.name, arguments: tc.function.arguments },
})),
};
}
/**
只保留请求里真实声明过的工具。

默认关闭（config.tools.filterUndeclared = false）：模型吐出的工具名

原样透传，避免「模型想调 run_command 却因为名字没对上而被静默丢弃」。
*/
function filterDeclared(tcs, body, cfg) {
const tcfg = (cfg && cfg.tools) || {};
if (!tcfg.filterUndeclared) return tcs;
const declared = new Set();
for (const t of body.tools || []) {
const fn = t.function || t;
if (fn && fn.name) declared.add(fn.name);
}
if (declared.size === 0) return tcs;
const kept = tcs.filter((tc) => declared.has(tc.function.name));
for (const tc of tcs) {
if (!declared.has(tc.function.name)) {
tag('API', '丢弃未声明的工具调用: ' + tc.function.name);
}
}
return kept;
}

function findFirstMarker(text) {
let marker = -1;
let start = -1;
for (let i = 0; i < TOOL_MARKERS.length; i++) {
const idx = text.indexOf(TOOL_MARKERS[i].start);
if (idx >= 0 && (start < 0 || idx < start)) { start = idx; marker = i; }
}
return { marker, start };
}
function partialMarkerLen(s) {
let keep = 0;
for (const mk of TOOL_MARKERS) {
const max = Math.min(s.length, mk.start.length - 1);
for (let n = max; n > 0; n--) {
if (mk.start.startsWith(s.slice(s.length - n)) && n > keep) keep = n;
}
}
return keep;
}
function isTruthy(v) {
if (v === true || v === 1) return true;
if (typeof v === 'string') {
const s = v.trim().toLowerCase();
return s === '1' || s === 'true' || s === 'yes' || s === 'reset';
}
return false;
}
/**
 * 是否开启深度思考。
 *   1. model 名含 reasoner / think（deepseek-reasoner、deepseek-r1 等）
 *   2. body.thinking / body.enable_thinking / body.reasoning / body.deep_think 为真
 *   3. OpenAI 的 reasoning_effort 非 none / minimal
 */
function isThinkingRequest(body, model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('reasoner') >= 0 || m.indexOf('think') >= 0 || m.indexOf('-r1') >= 0) return true;
  for (const k of ['thinking', 'enable_thinking', 'reasoning', 'deep_think']) {
    if (isTruthy(body[k])) return true;
  }
  const eff = body.reasoning_effort;
  if (typeof eff === "string") {
    const e = eff.trim().toLowerCase();
    if (e && e !== 'none' && e !== 'minimal') return true;
  }
  return false;
}

/**
 * 增量发送配置：enabled 默认 true，minDeltaChars 默认 1。
 */
function deltaCfg(cfg) {
  const d = (cfg && cfg.delta) || {};
  return {
    enabled: d.enabled !== false,
    minDeltaChars: d.minDeltaChars == null ? 1 : Number(d.minDeltaChars),
  };
}
/** 简单的进程内统计，供管理面板读取。 */
export class Stats {
constructor() {
this.startedAt = Date.now();
this.requests = 0;
this.deltaRequests = 0;
this.fullRequests = 0;
this.savedChars = 0;
this.toolCalls = 0;
this.errors = 0;
this.recent = [];
}
begin(rec) {
this.requests++;
if (rec.mode === 'delta') this.deltaRequests++;
else this.fullRequests++;
const saved = Math.max(0, (rec.fullChars || 0) - (rec.sentChars || 0));
this.savedChars += saved;
rec.savedChars = saved;
rec.t = Date.now();
rec.status = 'pending';
rec.ms = null;
rec.reason = null;
this.recent.unshift(rec);
if (this.recent.length > 50) this.recent.length = 50;
return rec;
}
finish(rec, status, reason) {
if (!rec) return;
rec.status = status;
rec.reason = reason || null;
rec.ms = Date.now() - rec.t;
}
addToolCalls(n) {
this.toolCalls += n;
}
addError() {
this.errors++;
}
}
export function createServer(ctx) {
const stats = ctx.stats || new Stats();
if (!ctx.stats) ctx.stats = stats;
const server = http.createServer(async (req, res) => {
try {
const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
const p = url.pathname;
// ---- 管理面板 ----
if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/ui')) {
writeHtml(res, renderDashboard());
return;
}
      if (req.method === 'GET' && p === '/ui-client.js') {
        writeScript(res, CLIENT_JS);
        return;
      }
if (req.method === 'GET' && p === '/api/status') {
writeJson(res, 200, statusPayload(ctx, stats));
return;
}
if (req.method === 'POST' && p === '/api/reset') {
const bodyText = await readBody(req);
let b = {};
try { b = JSON.parse(bodyText || '{}'); } catch (_) {}
ctx.sessions.reset(b.model || 'deepseek-chat', b.user || 'default');
writeJson(res, 200, { ok: true });
return;
}
if (req.method === 'POST' && p === '/api/reset-all') {
await readBody(req);
const keys = ctx.sessions.list();
for (const k of keys) {
const i = k.key.indexOf('|');
ctx.sessions.reset(i < 0 ? k.key : k.key.slice(0, i), i < 0 ? 'default' : k.key.slice(i + 1));
}
writeJson(res, 200, { ok: true, count: keys.length });
return;
}
// ---- OpenAI 兼容接口 ----
if (req.method === 'GET' && p.startsWith('/v1/models')) {
writeJson(res, 200, modelsJson());
return;
}
if (req.method === 'GET' && p.startsWith('/v1/sessions')) {
writeJson(res, 200, { object: 'list', data: ctx.sessions.list() });
return;
}
if (req.method === 'POST' && p.startsWith('/v1/sessions/reset')) {
const bodyText = await readBody(req);
let body = {};
try { body = JSON.parse(bodyText || '{}'); } catch (_) {}
ctx.sessions.reset(body.model || 'deepseek-chat', body.user || 'default');
writeJson(res, 200, { ok: true, model: body.model || 'deepseek-chat', user: body.user || 'default' });
return;
}
if (req.method === 'POST' && p.startsWith('/v1/chat/completions')) {
const bodyText = await readBody(req);
await handleChat(req, res, bodyText, ctx, stats);
return;
}
writeJson(res, 404, { error: { message: 'not found' } });
} catch (e) {
stats.addError();
tag('API', '处理失败: ' + e);
try { writeJson(res, 500, { error: { message: String(e) } }); } catch (_) {}
}
});
return server;
}
function statusPayload(ctx, stats) {
const cfg = ctx.cfg || {};
const c = {
host: cfg.host || '127.0.0.1',
port: cfg.port || 17380,
powMode: (cfg.pow && cfg.pow.mode) || 'oracle',
clientVersion: (cfg.deepseek && cfg.deepseek.clientVersion) || '-',
baseUrl: (cfg.deepseek && cfg.deepseek.baseUrl) || '-',
deltaEnabled: !(cfg.delta && cfg.delta.enabled === false),
minDeltaChars: (cfg.delta && cfg.delta.minDeltaChars) || 1,
filterUndeclared: !!(cfg.tools && cfg.tools.filterUndeclared),
};
const t = new Date(stats.startedAt);
const pad = (n) => (n < 10 ? '0' + n : '' + n);
return {
uptimeMs: Date.now() - stats.startedAt,
startedAtText: t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) +
' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()),
credsOk: !!(ctx.creds && ctx.creds.ok()),
config: c,
totals: {
requests: stats.requests,
deltaRequests: stats.deltaRequests,
fullRequests: stats.fullRequests,
savedChars: stats.savedChars,
toolCalls: stats.toolCalls,
errors: stats.errors,
},
sessions: ctx.sessions.list(),
recent: stats.recent,
};
}
async function handleChat(req, res, bodyText, ctx, stats) {
const { cfg, creds, sessions, upstream } = ctx;
let body;
try { body = JSON.parse(bodyText || '{}'); }
catch (e) { writeJson(res, 400, { error: { message: 'invalid json' } }); return; }
const stream = !!body.stream;
const model = body.model || 'deepseek-chat';
const user = body.user || req.headers['x-session-id'] || 'default';
const wantNew = isTruthy(body.new_session)
|| isTruthy(req.headers['x-new-session'])
|| isTruthy(req.headers['x-session-action']);
if (wantNew) {
sessions.reset(model, user);
tag('API', '用户请求新对话 model=' + model + ' user=' + user);
}
const messages = Array.isArray(body.messages) ? body.messages : [];
tag('API', '请求 stream=' + stream + ' model=' + model + ' user=' + user +
' tools=' + (Array.isArray(body.tools) ? body.tools.length : 0) +
' msgs=' + messages.length);
const rec = {
model, user, stream,
msgs: messages.length,
mode: 'full',
reason: '-',
sentChars: 0,
fullChars: 0,
};
if (!creds.ok()) {
stats.begin(rec);
stats.finish(rec, 'error', 'no-creds');
writeJson(res, 503, { error: { message: '没有可用登录凭据；请先在 config.json 填 bearer/deviceId' } });
return;
}
// ---- 增量比对 ----
const dc = deltaCfg(cfg);
const history = sessions.historyOf(model, user);
const delta = computeDelta(messages, history, dc);
const sendMessages = delta.mode === 'delta' ? delta.messages : messages;
const prompt = buildPromptFromMessages(sendMessages);
const fullChars = delta.fullChars != null ? delta.fullChars : countChars(messages);
const sendChars = delta.deltaChars != null ? delta.deltaChars : fullChars;
rec.mode = delta.mode;
rec.reason = delta.reason;
rec.fullChars = fullChars;
rec.sentChars = sendChars;
tag('API', '增量 mode=' + delta.mode + ' reason=' + delta.reason +
' 全量=' + fullChars + '字/' + messages.length + '条' +
' 本次=' + sendChars + '字/' + sendMessages.length + '条' +
(delta.mode === 'delta' ? ' 节省=' + Math.max(0, fullChars - sendChars) + '字' : ''));
const sessionId = await sessions.get(model, user);
if (!sessionId) {
stats.begin(rec);
stats.finish(rec, 'error', 'session-create-failed');
stats.addError();
writeJson(res, 502, { error: { message: '建上游会话失败（检查凭据是否有效）' } });
return;
}
// 思考模式：模型名带 reasoner，或请求体显式要求，或 OpenAI 的 reasoning_effort
const thinking = isThinkingRequest(body, model);
const id = uuid();
stats.begin(rec);
const commitHistory = () => {
const h = makeHistory(messages, sessionId);
h.chars = fullChars;
sessions.setHistory(model, user, h);
};
if (!stream) {
const parts = [];
const thinks = [];
let error = null;
let reason = 'stop';
await new Promise((resolve) => {
upstream.chat({
model, user, sessionId,
parentMessageId: sessions.parentOf(model, user),
prompt, thinking,
sink: {
onText: (d) => parts.push(d),
onThink: (d) => thinks.push(d),
onDone: (r) => { reason = r; resolve(); },
onError: (e) => { error = e; resolve(); },
},
});
});
if (error) {
stats.finish(rec, 'error', 'upstream');
stats.addError();
writeJson(res, 502, { error: { message: String(error) } });
return;
}
const content = parts.join('');
tag('API', '非流式完成 ' + content.length + ' 字: ' + trim(content, 200));
const tcs = filterDeclared(parseToolCalls(content), body, cfg);
const message = { role: 'assistant' };
let finishReason = reason;
if (tcs.length > 0) {
message.content = null;
message.tool_calls = tcs;
finishReason = 'tool_calls';
stats.addToolCalls(tcs.length);
} else {
message.content = stripCallBlocks(content);
}
if (thinks.length > 0) {
message.reasoning_content = thinks.join('');
tag('API', '思考内容 ' + message.reasoning_content.length + ' 字');
}
commitHistory();
stats.finish(rec, tcs.length > 0 ? 'tool' : 'ok', finishReason);
writeJson(res, 200, {
id,
object: 'chat.completion',
created: Math.floor(Date.now() / 1000),
model,
choices: [{ index: 0, message, finish_reason: finishReason }],
usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
x_dsx: {
thinking: !!thinking,
delta_mode: delta.mode,
delta_reason: delta.reason,
sent_chars: sendChars,
full_chars: fullChars,
sent_messages: sendMessages.length,
full_messages: messages.length,
},
});
return;
}
// ---- 流式 ----
res.writeHead(200, {
'Content-Type': 'text/event-stream; charset=utf-8',
'Cache-Control': 'no-cache',
'Connection': 'keep-alive',
'Transfer-Encoding': 'chunked',
'X-DSX-Delta-Mode': delta.mode,
'X-DSX-Sent-Chars': String(sendChars),
'X-DSX-Full-Chars': String(fullChars),
'X-DSX-Thinking': thinking ? '1' : '0',
});
res.write(chunkFrame(id, model, { role: 'assistant', content: '' }));
const full = [];
let pending = '';
let suppressing = false;
let closed = false;
const safeWrite = (s) => {
if (closed) return;
try { res.write(s); } catch (_) { closed = true; }
};
const feedText = (d) => {
full.push(d);
if (suppressing) return;
pending += d;
const hit = findFirstMarker(pending);
if (hit.start >= 0) {
if (hit.start > 0) safeWrite(chunkFrame(id, model, { content: pending.slice(0, hit.start) }));
pending = '';
suppressing = true;
return;
}
const keep = partialMarkerLen(pending);
const out = pending.slice(0, pending.length - keep);
if (out) {
pending = pending.slice(pending.length - keep);
safeWrite(chunkFrame(id, model, { content: out }));
}
};
const flushPending = () => {
if (pending) {
safeWrite(chunkFrame(id, model, { content: pending }));
pending = '';
}
};
await new Promise((resolve) => {
upstream.chat({
model, user, sessionId,
parentMessageId: sessions.parentOf(model, user),
prompt, thinking,
sink: {
onText: feedText,
onThink: (d) => safeWrite(chunkFrame(id, model, { reasoning_content: d })),
onHeartbeat: () => safeWrite(': ping\n\n'),
onDone: (reason) => {
flushPending();
const text = full.join('');
tag('API', '流式完成 ' + text.length + ' 字 reason=' + reason +
' 内容=' + trim(text, 200));
const tcs = filterDeclared(parseToolCalls(text), body, cfg);
let finalReason = reason;
if (tcs.length > 0) {
safeWrite(chunkFrame(id, model, toolCallDelta(tcs), 'tool_calls'));
finalReason = 'tool_calls';
stats.addToolCalls(tcs.length);
} else {
if (reason === 'error') finalReason = 'stop';
safeWrite(chunkFrame(id, model, {}, finalReason || 'stop'));
}
tag('API', 'finish_reason=' + finalReason);
safeWrite('data: [DONE]\n\n');
commitHistory();
stats.finish(rec, tcs.length > 0 ? 'tool' : 'ok', finalReason);
if (!closed) { closed = true; try { res.end(); } catch (e2) {} }
resolve();
},
onError: (e) => {
flushPending();
tag('API', '流式出错: ' + (e && e.message ? e.message : e));
safeWrite('data: ' + JSON.stringify({
error: { message: String(e && e.message ? e.message : e), type: 'upstream_error' },
}) + '\n\n');
safeWrite(chunkFrame(id, model, {}, 'stop'));
safeWrite('data: [DONE]\n\n');
stats.finish(rec, 'error', 'upstream');
stats.addError();
if (!closed) { closed = true; try { res.end(); } catch (e2) {} }
resolve();
},
},
});
});
}
function stripCallBlocks(text) {
if (!text) return text;
let out = '';
let from = 0;
while (from < text.length) {
let marker = -1;
let start = -1;
for (let i = 0; i < TOOL_MARKERS.length; i++) {
const idx = text.indexOf(TOOL_MARKERS[i].start, from);
if (idx >= 0 && (start < 0 || idx < start)) { start = idx; marker = i; }
}
if (start < 0) { out += text.slice(from); break; }
out += text.slice(from, start);
const mk = TOOL_MARKERS[marker];
const endIdx = text.indexOf(mk.end, start + mk.start.length);
if (endIdx < 0) from = text.length;
else from = endIdx + mk.end.length;
}
return out.trim();
}