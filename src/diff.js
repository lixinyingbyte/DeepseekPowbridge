import crypto from 'node:crypto';
const NL = String.fromCharCode(10);
/** OpenAI content（string 或 [{type,text}]）统一转纯文本。 */
export function textOf(content) {
if (typeof content === 'string') return content;
if (Array.isArray(content)) {
let s = '';
for (const p of content) {
if (typeof p === 'string') { s += p; continue; }
if (p && typeof p.text === 'string') s += p.text;
}
return s;
}
return '';
}
/** 消息数组的规范文本：长度前缀 + 分隔符，避免内容里出现分隔符造成歧义。 */
function canonical(msgs) {
let out = '';
for (const m of msgs || []) {
if (!m) { out += '0::0:0:'; out += NL; continue; }
const role = m.role || '';
const text = textOf(m.content);
let tc = '';
if (Array.isArray(m.tool_calls)) {
try { tc = JSON.stringify(m.tool_calls); } catch (_) { tc = ''; }
}
out += role.length + ':' + role + '|';
out += text.length + ':' + text + '|';
out += tc.length + ':' + tc;
out += NL;
}
return out;
}
/** 整个消息数组的指纹。相同内容必得相同值，任意一条改动都会变。 */
export function hashMessages(msgs) {
return crypto.createHash('sha256').update(canonical(msgs || []), 'utf8').digest('hex');
}
/** 粗略字符数：content 文本 + tool_calls 的 JSON 长度。用于日志对比。 */
export function countChars(msgs) {
let n = 0;
for (const m of msgs || []) {
if (!m) continue;
n += textOf(m.content).length;
if (Array.isArray(m.tool_calls)) {
try { n += JSON.stringify(m.tool_calls).length; } catch (_) {}
}
}
return n;
}
/**
计算本次请求相对于上一次的增量。

上游靠 chat_session_id + parent_message_id 维护上下文，所以只要

前缀没变，就没必要把整段历史重发一遍——只发新增的 user / tool 消息即可。

assistant 消息不放进增量：那是上游自己生成的回复，客户端回传只是回声，

上游已经持有；重发只会多占 token。

任何不确定的情况（前缀对不上、没有新增、只有 assistant）都退回 full，

保证正确性优先。
*/
export function computeDelta(currMessages, history, opts) {
const o = opts || {};
const curr = Array.isArray(currMessages) ? currMessages : [];

if (o.enabled === false) {
return { mode: 'full', messages: curr, reason: 'disabled' };
}
if (!history || !history.count || !history.hash) {
return { mode: 'full', messages: curr, reason: 'no-history' };
}
if (curr.length <= history.count) {
return { mode: 'full', messages: curr, reason: 'no-new-messages' };
}
const prefix = curr.slice(0, history.count);
if (hashMessages(prefix) !== history.hash) {
return { mode: 'full', messages: curr, reason: 'history-diverged' };
}
const delta = curr.slice(history.count);
const meaningful = delta.filter((m) => m && (m.role === 'user' || m.role === 'tool'));
if (meaningful.length === 0) {
return { mode: 'full', messages: curr, reason: 'delta-only-assistant' };
}
const deltaChars = countChars(meaningful);
const minChars = o.minDeltaChars == null ? 1 : o.minDeltaChars;
if (deltaChars < minChars) {
return { mode: 'full', messages: curr, reason: 'delta-too-small' };
}
return {
mode: 'delta',
messages: meaningful,
reason: 'prefix-matched',
fullCount: curr.length,
deltaCount: meaningful.length,
fullChars: countChars(curr),
deltaChars,
};
}
/** 把一次成功请求的 messages 记成指纹，供下一次比对。 */
export function makeHistory(messages, sessionId) {
const msgs = Array.isArray(messages) ? messages : [];
return {
count: msgs.length,
hash: hashMessages(msgs),
sessionId: sessionId || null,
updatedAt: Date.now(),
};
}