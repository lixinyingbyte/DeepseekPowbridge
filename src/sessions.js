import { tag } from './log.js';
import { httpRequest } from './http.js';
/**
会话管理。

key = model + '|' + user。用 user 维度隔离，避免并发两个请求串台。

parent_message_id 语义：必须用 SSE 实时下发的 response_message_id，

不能用模板里学到的旧值；指向「已经有孩子的节点」会让上游把消息

当成修改版本。

增量发送相关状态：

history: key -> { count, hash, sessionId }，记录上一次成功请求的

messages 指纹。下一轮比对前缀是否一致，一致就只发新增部分。

显式重置（reset）时把 history 一起清掉，保证下一次从全量开始。
*/
export class Sessions {
constructor(cfg, pow, creds) {
this.cfg = cfg;
this.pow = pow;
this.creds = creds;
this.session = new Map();
this.parent = new Map();
this.history = new Map();
}

static keyOf(model, user) {
return (model || 'deepseek-chat') + '|' + (user || 'default');
}
async get(model, user) {
const key = Sessions.keyOf(model, user);
const id = this.session.get(key);
if (id) return id;
const fresh = await this.create();
if (fresh) {
this.session.set(key, fresh);
this.parent.delete(key);
this.history.delete(key);
tag('SESS', key + ' -> 新会话 ' + fresh);
}
return fresh;
}
parentOf(model, user) {
const p = this.parent.get(Sessions.keyOf(model, user));
return p == null ? null : p;
}
setParent(model, responseMessageId, user) {
if (!(responseMessageId > 0)) return;
const key = Sessions.keyOf(model, user);
this.parent.set(key, responseMessageId);
tag('SESS', key + ' parent -> ' + responseMessageId);
}
historyOf(model, user) {
return this.history.get(Sessions.keyOf(model, user)) || null;
}
setHistory(model, user, h) {
this.history.set(Sessions.keyOf(model, user), h);
}
/**
开新会话：丢掉 sessionId、parent、history，下一次请求会重新建会话

并发送完整 prompt。
*/
reset(model, user) {
const key = Sessions.keyOf(model, user);
this.session.delete(key);
this.parent.delete(key);
this.history.delete(key);
tag('SESS', key + ' 会话已重置（下次全量发送）');
}

/** 列出当前所有会话 key 及其中 live 状态，便于 /v1/sessions 观测。 */
list() {
const keys = new Set();
for (const k of this.session.keys()) keys.add(k);
for (const k of this.parent.keys()) keys.add(k);
for (const k of this.history.keys()) keys.add(k);
const out = [];
for (const k of keys) {
const h = this.history.get(k) || null;
out.push({
key: k,
sessionId: this.session.get(k) || null,
parent: this.parent.get(k) == null ? null : this.parent.get(k),
historyCount: h ? h.count : 0,
historyChars: h ? h.chars : 0,
updatedAt: h ? h.updatedAt : null,
});
}
return out;
}
async create() {
const tk = this.creds.token();
if (!this.creds.ok()) {
tag('SESS', '建会话失败：没有凭据');
return null;
}
try {
const resp = await httpRequest(this.cfg.baseUrl + '/api/v0/chat_session/create', {
method: 'POST',
headers: this.pow.headers(tk, 'application/json'),
body: JSON.stringify({ character_id: null, chat_session_id: null }),
timeoutMs: 20000,
});
const text = await resp.text();
if (!resp.ok) {
tag('SESS', 'create_session HTTP ' + resp.status + ': ' + text.slice(0, 200));
return null;
}
const id = findSessionId(JSON.parse(text));
if (id) return id;
tag('SESS', '建会话返回结构未知: ' + text.slice(0, 300));
} catch (e) {
tag('SESS', '建会话失败: ' + e.message);
}
return null;
}
}
function findSessionId(o) {
if (!o || typeof o !== 'object') return null;
const cs = o.chat_session;
if (cs && typeof cs === 'object' && cs.id) return String(cs.id);
for (const k of Object.keys(o)) {
const v = o[k];
if (v && typeof v === 'object') {
const r = findSessionId(v);
if (r) return r;
}
}
return null;
}