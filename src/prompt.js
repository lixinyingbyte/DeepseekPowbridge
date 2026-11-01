/**
OpenAI 请求 -> 上游 prompt 字符串。

上游 /api/v0/chat/completion 只接受一个 prompt 字段，靠

chat_session_id + parent_message_id 在服务端维护上下文。

因此这里有两个入口：

buildPrompt(req)              —— 用 req.messages 全量拼接（默认、兜底）

buildPromptFromMessages(msgs) —— 用调用方给定的消息列表拼接

server.js 走增量模式时，会先把本次请求和上一次做比对，只把新增的

user / tool 消息传给 buildPromptFromMessages，从而避免把整段历史

每轮重发一遍。

拼接本身不做任何包装：不注入 role 标签、不注入工具清单、不注入

调用格式示例。这里保持纯净，只负责「把文本按顺序连起来」。
*/

// 旧版 Android 模块用过的 DSX_CALL 控制块。保留常量只为防御性解析：
// 万一历史会话或上游仍吐出这种格式，server.js 能把它吞掉而不是当正文。
const CALL_START = '[[DSX_CALL]]';
const CALL_END = '[[/DSX_CALL]]';
// DeepSeek 网页版 / App 原生的工具调用标记（DSML = DeepSeek Markup Language）。
// 全角竖线 U+FF5C 用来包裹内部标签，形如：
//   <||DSML|| calls>
//   <||DSML|| invoke name="read"> ... </||DSML|| invoke>
//   </||DSML|| calls>
const P = String.fromCharCode(0xFF5C);
const DSML_PIPE2 = P + P;
const DSML_OPEN = '<' + DSML_PIPE2 + 'DSML' + DSML_PIPE2;
const DSML_CLOSE = '</' + DSML_PIPE2 + 'DSML' + DSML_PIPE2;
const DSML_CALLS_CLOSE = DSML_CLOSE + ' calls>';
// 所有已知的工具调用起始/结束标记对。
// server.js 用它做流式抑制：一旦出现 start 就停止输出正文，
// 直到出现 end 或流结束。
const TOOL_MARKERS = [
{ start: CALL_START, end: CALL_END },
{ start: DSML_OPEN, end: DSML_CALLS_CLOSE },
];
const NL2 = String.fromCharCode(10, 10);
/** 把 OpenAI content（string 或 [{type,text}] 数组）统一转成纯文本。 */
function textOf(content) {
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
/** 把一组消息按顺序拼成 prompt 字符串。不做任何包装。 */
export function buildPromptFromMessages(msgs) {
const list = Array.isArray(msgs) ? msgs : [];
const parts = [];
for (const m of list) {
if (!m) continue;
const t = textOf(m.content);
if (!t) continue;
parts.push(t);
}
return parts.join(NL2);
}
/** 默认入口：用 req.messages 全量拼接。 */
export function buildPrompt(req) {
return buildPromptFromMessages(req && req.messages);
}
export {
CALL_START, CALL_END,
DSML_OPEN, DSML_CLOSE, DSML_CALLS_CLOSE, DSML_PIPE2,
TOOL_MARKERS,
textOf,
};