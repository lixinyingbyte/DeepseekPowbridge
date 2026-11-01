import { tag, trim } from './log.js';
import { httpRequest } from './http.js';
/**
直连 chat.deepseek.com 的流式客户端。

协议：

POST /api/v0/chat/completion

Authorization: Bearer <登录态>

x-client-* 系列头 + x-ds-pow-response

上游 SSE 三种形状：

ready：带 response_message_id -> 存成下一轮 parent

patch：{"p":"response/fragments/<idx>/content","v":"字"} 增量

首帧：{"v":{...,"response":{"fragments":[{type,content}]}}}

思考模式（thinking_enabled=true）下，上游会下发两个 fragment：

fragments[0].type = "THINK"   思考过程

fragments[1].type = "ANSWER"  正式回答

patch 帧只给下标不给类型，所以必须先用首帧/后续帧把 idx -> type

记下来，否则思考内容会被当成正文拼进回答里。
*/

// 用 new RegExp 构造，避免源码里出现反斜杠字面量被工具链改写。
// 上游思考增量的路径标记。用拼接构造，避免源码里出现反斜杠或下划线转义。
const THINK_PATH = 'response/thinking' + String.fromCharCode(95) + 'content';

const RE_FRAG = new RegExp('fragments/([-0-9]+)/content');
export class Upstream {
constructor(cfg, pow, creds, sessions) {
this.cfg = cfg;
this.pow = pow;
this.creds = creds;
this.sessions = sessions;
}
async chat(opts) {
const o = opts || {};
const sink = o.sink || {};
const emit = (name, arg) => {
const fn = sink[name];
if (typeof fn === 'function') {
try { fn(arg); } catch (e) { tag('UP', 'sink.' + name + ' 抛错: ' + e.message); }
}
};
try {
const tk = this.creds.token();
const powHeader = await this.pow.makeHeader(tk);
const body = {
chat_session_id: o.sessionId,
parent_message_id: o.parentMessageId == null ? null : o.parentMessageId,
prompt: o.prompt,
ref_file_ids: [],
thinking_enabled: !!o.thinking,
search_enabled: false,
audio_id: null,
preempt: false,
model_type: 'default',
action: null,
};
      tag('UP', 'completion session=' + o.sessionId
        + ' parent=' + o.parentMessageId
        + ' thinking=' + (o.thinking ? 'on' : 'off')
        + ' promptLen=' + String(o.prompt || '').length);

const headers = this.pow.headers(tk, 'application/json');
headers['Accept'] = 'text/event-stream';
headers['x-ds-pow-response'] = powHeader;
const resp = await httpRequest(this.cfg.baseUrl + '/api/v0/chat/completion', {
method: 'POST',
headers,
body: JSON.stringify(body),
timeoutMs: 180000,
});
tag('UP', 'completion -> HTTP ' + resp.status);
if (!resp.ok) {
const err = await resp.text();
emit('onError', new Error('HTTP ' + resp.status + ': ' + trim(err, 400)));
return;
}
// ⚠️ 上游业务错误也是 HTTP 200，body 是 JSON 而不是 SSE。
const ct = (resp.headers.get('content-type') || '').toLowerCase();
if (ct.includes('application/json')) {
const txt = await resp.text();
let msg = trim(txt, 300);
try {
const j = JSON.parse(txt);
const code = j.code;
const m = j.msg || j.message || '';
if (code !== undefined && code !== null) {
msg = 'code=' + code + (m ? ' msg=' + m : '');
if (code === 40301) {
msg += '（PoW 响应无效：检查 oracle 返回的 answer 与 base 形态）';
} else if (code === 0) {
msg += '（上游返回 code=0 但无正文，通常是会话或风控异常，重试即可）';
}
}
} catch (_) {}
tag('UP', '上游非 SSE 响应: ' + msg);
emit('onError', new Error('上游拒绝: ' + msg));
return;
}
await this.readSse(resp.body, o.model, o.user, emit);
} catch (e) {
emit('onError', e);
}
}
async readSse(body, model, user, emit) {
const reader = body.getReader();
const decoder = new TextDecoder('utf-8');
let buf = '';
let textCount = 0;
let thinkCount = 0;
// 每个流独立的 fragment 类型表：下标 -> 'THINK' | 'ANSWER'
const fragTypes = [];
const heartbeat = setInterval(() => emit('onHeartbeat'), 15000);
if (heartbeat.unref) heartbeat.unref();
const emitFragment = (idx, v) => {
if (!v) return;
let type = fragTypes[idx];
if (type == null && idx < 0) type = fragTypes[fragTypes.length - 1];
if (type === 'THINK') {
thinkCount++;
emit('onThink', v);
} else {
textCount++;
emit('onText', v);
}
};
const handleLine = (line) => {
if (!line.startsWith('data:')) return null;
const payload = line.slice(5).trim();
if (!payload) return null;
if (payload === '[DONE]') return 'stop';
try {
const o = JSON.parse(payload);
const rid = Number(o.response_message_id || 0);
if (rid > 0) {
this.sessions.setParent(model, rid, user);
tag('UP', 'ready request=' + (o.request_message_id || 0) + ' response=' + rid);
return null;
}
const p = o.p || '';
if (p) {
// response/fragments/<idx>/content —— 按已记录的类型分流
const m = RE_FRAG.exec(p);
if (m) {
emitFragment(Number(m[1]), typeof o.v === 'string' ? o.v : '');
return null;
}
if (p.indexOf(THINK_PATH) >= 0 || p.indexOf('reasoning_content') >= 0) {
const v = typeof o.v === 'string' ? o.v : '';
if (v) { emit('onThink', v); thinkCount++; }
return null;
}
if (p.includes('content')) {
const v = typeof o.v === 'string' ? o.v : '';
if (v) { emit('onText', v); textCount++; }
} else if (p.includes('status')) {
const v = String(o.v || '');
if (v === 'FINISHED') return 'stop';
if (v === 'INCOMPLETE') return 'length';
if (v === 'FAILED') return 'error';
}
return null;
}
if (o.v && typeof o.v === 'string') {
emit('onText', o.v);
textCount++;
return null;
}
if (o.v && typeof o.v === 'object') {
this.harvestFragments(o.v, fragTypes, emit);
textCount += this.lastHarvestText;
thinkCount += this.lastHarvestThink;
}
} catch (e) { /* 坏帧忽略 */ }
return null;
};
// 上游断开时的收尾判定：
//   有正文 -> length；思考但无正文 -> length（不丢思考）；都没有 -> error
const finish = (reason, explicit) => {
if (explicit) {
tag('UP', '流结束 reason=' + reason + ' 片段=' + textCount + ' 思考=' + thinkCount);
emit('onDone', reason);
return;
}
if (textCount > 0 || thinkCount > 0) {
tag('UP', '流被截断（无结束帧）片段=' + textCount + ' 思考=' + thinkCount + '，按 length 上报');
emit('onDone', 'length');
return;
}
const msg = '上游连接在收到任何正文前断开（可能触发风控或会话异常）';
tag('UP', msg);
emit('onError', new Error(msg));
};
try {
while (true) {
const { done, value } = await reader.read();
if (done) break;
buf += decoder.decode(value, { stream: true });
let nl;
while ((nl = buf.indexOf('\n')) >= 0) {
const line = buf.slice(0, nl).replace(/\r$/, '');
buf = buf.slice(nl + 1);
const r = handleLine(line);
if (r) {
finish(r, true);
return;
}
}
}
finish('stop', false);
} catch (e) {
emit('onError', e);
} finally {
clearInterval(heartbeat);
}
}
/**
处理首帧/全量帧里的 fragments：记录每个下标的类型，

并把新出现的内容按类型 emit 出去。
*/
harvestFragments(v, fragTypes, emit) {
this.lastHarvestText = 0;
this.lastHarvestThink = 0;
const resp = v.response;
if (!resp || !Array.isArray(resp.fragments)) return;
for (let i = 0; i < resp.fragments.length; i++) {
const f = resp.fragments[i] || {};
const type = String(f.type || '').toUpperCase();
if (type) fragTypes[i] = type;
const c = f.content || '';
if (!c) continue;
if (type === 'THINK') {
this.lastHarvestThink++;
emit('onThink', c);
} else {
this.lastHarvestText++;
emit('onText', c);
}
}
}
}