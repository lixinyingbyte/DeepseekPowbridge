// 把模型回复里的工具调用标记解析成 OpenAI tool_calls 数组。
//
// 支持两种格式：
//   1. 旧版 Android 模块自造的 [[DSX_CALL]] {json} [[/DSX_CALL]]
//   2. DeepSeek 网页版/App 原生的 DSML 标签：
//      <||DSML|| calls>
//      <||DSML|| invoke name="read">
//      <||DSML|| parameter name="file_path" string="true">...</||DSML|| parameter>
//      </||DSML|| invoke>
//      </||DSML|| calls>
//      （上面用半角 || 示意，实际是全角竖线 U+FF5C）
//
// 本文件刻意不使用正则表达式和反斜杠字面量：所有特殊字符都用
// String.fromCharCode 在运行时构造，保证在任何编辑/传输路径下不被改写。
const CALL_START = '[[DSX_CALL]]';
const CALL_END = '[[/DSX_CALL]]';
const PIPE = String.fromCharCode(0xFF5C);
const P2 = PIPE + PIPE;
const LT = '<';
const GT = '>';
const SLASH = '/';
const QUOT = '"';
const SP = ' ';
const OPEN_TAG = LT + P2 + 'DSML' + P2;   // <||DSML||
const CLOSE_TAG = LT + SLASH + P2 + 'DSML' + P2; // </||DSML||
const BS = String.fromCharCode(92);
const FEFF = String.fromCharCode(0xFEFF);
const ZWSP = String.fromCharCode(0x200B);
const ZWNJ = String.fromCharCode(0x200C);
const ZWJ = String.fromCharCode(0x200D);
const LQUO = String.fromCharCode(0x201C);
const RQUO = String.fromCharCode(0x201D);
const LAPO = String.fromCharCode(0x2018);
const RAPO = String.fromCharCode(0x2019);
const WHITESPACE = ' \t' + String.fromCharCode(10, 13);
/** 解析出模型回复里的全部工具调用。 */
export function parseToolCalls(text) {
const out = [];
if (!text) return out;
parseDsx(text, out);
if (out.length === 0) parseDsml(text, out);
return out;
}
// ---------- 格式 1：[[DSX_CALL]] ----------
function parseDsx(text, out) {
let from = 0;
let seq = out.length;
while (out.length < 20) {
const start = text.indexOf(CALL_START, from);
if (start < 0) break;
if (insideSystem(text, start)) {
from = start + CALL_START.length;
continue;
}
let end = text.indexOf(CALL_END, start);
if (end < 0) end = text.length;
const raw = text.slice(start + CALL_START.length, end);
from = end + CALL_END.length;
const open = raw.indexOf('{');
const close = raw.lastIndexOf('}');
if (open < 0 || close <= open) continue;
const json = sanitize(raw.slice(open, close + 1));
try {
const obj = JSON.parse(json);
const calls = Array.isArray(obj.calls) ? obj.calls : [obj];
for (const one of calls) {
const tc = toToolCall(one, seq);
if (tc) { out.push(tc); seq++; }
}
} catch (e) { /* 忽略坏块 */ }
}
}
function toToolCall(call, seq) {
if (!call || typeof call !== 'object') return null;
const tool = call.tool || call.name || '';
if (!tool) return null;
const args = {};
for (const k of Object.keys(call)) {
if (k === 'id' || k === 'tool' || k === 'name') continue;
args[k] = call[k];
}
return {
id: 'call_' + seq,
type: 'function',
function: { name: tool, arguments: JSON.stringify(args) },
};
}
function insideSystem(text, at) {
const open = text.lastIndexOf('<system>', at);
if (open < 0) return false;
const close = text.indexOf('</system>', open);
return close < 0 || close > at;
}
// ---------- 格式 2：DSML ----------
/**
从 at（指向 '<'）解析一个 DSML 标签。

返回 { closing, name, attrs, end }，end 为 '>' 之后的下标；不是标签返回 null。
*/
function parseTag(text, at) {
let prefix;
let closing;
if (text.startsWith(CLOSE_TAG, at)) {
prefix = CLOSE_TAG;
closing = true;
} else if (text.startsWith(OPEN_TAG, at)) {
prefix = OPEN_TAG;
closing = false;
} else {
return null;
}
const gt = text.indexOf(GT, at + prefix.length);
if (gt < 0) return null;
const inner = text.slice(at + prefix.length, gt);

// 标签名：跳过前导空白，读到第一个空白或自闭合斜杠为止
let i = 0;
while (i < inner.length && WHITESPACE.indexOf(inner[i]) >= 0) i++;
let j = i;
while (j < inner.length && WHITESPACE.indexOf(inner[j]) < 0 && inner[j] !== SLASH) j++;
const name = inner.slice(i, j).trim();
const attrs = {};
const attrText = inner.slice(j);
for (const key of ['name', 'string']) {
const v = readAttr(attrText, key);
if (v !== null) attrs[key] = v;
}
return { closing, name, attrs, end: gt + 1 };
}
function readAttr(s, key) {
const k = SP + key + '=' + QUOT;
let i = s.indexOf(k);
if (i < 0) {
const k0 = key + '=' + QUOT;
if (s.startsWith(k0) || s.startsWith(SP + k0)) i = s.startsWith(k0) ? 0 : s.indexOf(SP + k0);
if (i < 0) return null;
const start0 = i + k0.length + (s.startsWith(k0) ? 0 : 0);
const end0 = s.indexOf(QUOT, start0);
if (end0 < 0) return null;
return s.slice(start0, end0);
}
const start = i + k.length;
const end = s.indexOf(QUOT, start);
if (end < 0) return null;
return s.slice(start, end);
}
/** 从 from 开始找下一个指定名字的 DSML 开标签，返回 { tag, at }。 */
function nextOpen(text, from, wanted) {
let i = from;
while (i < text.length) {
const at = text.indexOf(OPEN_TAG, i);
if (at < 0) return null;
const tag = parseTag(text, at);
if (!tag) { i = at + OPEN_TAG.length; continue; }
if (!tag.closing && tag.name === wanted) return { tag, at };
i = tag.end;
}
return null;
}
function parseDsml(text, out) {
let seq = out.length;
let from = 0;
while (out.length < 20) {
const inv = nextOpen(text, from, 'invoke');
if (!inv) break;
const toolName = (inv.tag.attrs.name || '').trim();
if (!toolName) { from = inv.tag.end; continue; }
// 找配对的 </||DSML|| invoke>
let body = '';
let cursor = inv.tag.end;
let closed = false;
while (cursor < text.length) {
const at = text.indexOf(CLOSE_TAG, cursor);
if (at < 0) break;
const tag = parseTag(text, at);
if (!tag) { cursor = at + CLOSE_TAG.length; continue; }
if (tag.closing && tag.name === 'invoke') {
body = text.slice(inv.tag.end, at);
cursor = tag.end;
closed = true;
break;
}
cursor = tag.end;
}
from = closed ? cursor : inv.tag.end;
const args = {};
let pFrom = 0;
while (true) {
const p = nextOpen(body, pFrom, 'parameter');
if (!p) break;
const pname = (p.tag.attrs.name || '').trim();
// 找配对的 </||DSML|| parameter>
let pCursor = p.tag.end;
let pBody = '';
while (pCursor < body.length) {
const at = body.indexOf(CLOSE_TAG, pCursor);
if (at < 0) break;
const tag = parseTag(body, at);
if (!tag) { pCursor = at + CLOSE_TAG.length; continue; }
if (tag.closing && tag.name === 'parameter') {
pBody = body.slice(p.tag.end, at);
pCursor = tag.end;
break;
}
pCursor = tag.end;
}
pFrom = pCursor > p.tag.end ? pCursor : p.tag.end;
if (!pname) continue;
const isString = p.tag.attrs.string === 'true';
args[pname] = coerce(pBody, isString);
}
out.push({
id: 'call_' + seq,
type: 'function',
function: { name: toolName, arguments: JSON.stringify(args) },
});
seq++;
}
}
/** string="true" 保持字符串；否则尝试还原成 boolean / number / null。 */
function coerce(v, isString) {
const raw = v == null ? '' : String(v);
if (isString) return raw;
const t = raw.trim();
if (t === 'true') return true;
if (t === 'false') return false;
if (t === 'null') return null;
if (isInteger(t)) {
const n = Number(t);
if (Number.isSafeInteger(n)) return n;
}
if (isDecimal(t)) return Number(t);
return raw;
}
function isInteger(s) {
if (!s) return false;
let i = s[0] === '-' ? 1 : 0;
if (i >= s.length) return false;
for (; i < s.length; i++) if (s[i] < '0' || s[i] > '9') return false;
return true;
}
function isDecimal(s) {
if (!s) return false;
let i = s[0] === '-' ? 1 : 0;
let dots = 0;
let digits = 0;
for (; i < s.length; i++) {
if (s[i] === '.') { dots++; continue; }
if (s[i] < '0' || s[i] > '9') return false;
digits++;
}
return dots === 1 && digits > 0;
}
// ---------- JSON 容错 ----------
function sanitize(s) {
let out = '';
for (const c of s) {
if (c === FEFF || c === ZWSP || c === ZWNJ || c === ZWJ) continue;
if (c === LQUO || c === RQUO) { out += QUOT; continue; }
if (c === LAPO || c === RAPO) { out += String.fromCharCode(39); continue; }
out += c;
}
return stripTrailingComma(out);
}
function stripTrailingComma(s) {
let out = '';
let inStr = false;
let esc = false;
for (let i = 0; i < s.length; i++) {
const c = s[i];
if (esc) { out += c; esc = false; continue; }
if (c === BS && inStr) { out += c; esc = true; continue; }
if (c === QUOT) { inStr = !inStr; out += c; continue; }
if (!inStr && c === ',') {
let j = i + 1;
while (j < s.length && WHITESPACE.indexOf(s[j]) >= 0) j++;
if (j < s.length && (s[j] === '}' || s[j] === ']')) continue;
}
out += c;
}
return out;
}
export { CALL_START, CALL_END, P2, OPEN_TAG, CLOSE_TAG };