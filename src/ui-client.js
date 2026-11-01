'use strict';
// 管理面板前端逻辑。
//
// 这是一个真正的 .js 文件，由服务端从磁盘读出来原样返回给浏览器，
// 不需要经过任何 HTML 字符串拼接、也不需要任何转义。
//
// 为了防住历史问题（编辑链路上反斜杠会被吃掉），本文件刻意不出现
// 任何反斜杠字符：换行用 String.fromCharCode 构造，生成的 HTML
// 属性一律用单引号。
var NL = String.fromCharCode(10);
var NL2 = String.fromCharCode(10, 10);
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(t) {
if (!t) return '-';
var d = new Date(t);
return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function fmtDur(ms) {
if (ms === null || ms === undefined) return '-';
if (ms < 1000) return ms + 'ms';
var s = Math.floor(ms / 1000);
if (s < 60) return s + 's';
var m = Math.floor(s / 60);
return m + 'm' + (s % 60) + 's';
}
// 生成的 HTML 属性统一用单引号，因此这里只需转义 & < > 和单引号本身
function esc(v) {
  var s = String(v === null || v === undefined ? '' : v);
  var AMP = String.fromCharCode(38, 97, 109, 112, 59);
  var LT = String.fromCharCode(38, 108, 116, 59);
  var GT = String.fromCharCode(38, 103, 116, 59);
  var SQ = String.fromCharCode(38, 35, 51, 57, 59);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === String.fromCharCode(38)) out += AMP;
    else if (c === String.fromCharCode(60)) out += LT;
    else if (c === String.fromCharCode(62)) out += GT;
    else if (c === String.fromCharCode(39)) out += SQ;
    else out += c;
  }
  return out;
}
function pill(text, cls) {
return '<span class="pill ' + (cls || '') + '">' + esc(text) + '</span>';
}
function kv(pairs) {
var h = '';
for (var i = 0; i < pairs.length; i++) {
h += '<dt>' + esc(pairs[i][0]) + '</dt><dd>' + pairs[i][1] + '</dd>';
}
return h;
}
function getJson(path) {
return fetch(path, { cache: 'no-store' }).then(function (r) { return r.json(); });
}
function postJson(path, body) {
return fetch(path, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body || {}),
}).then(function (r) { return r.json(); });
}
function byId(id) { return document.getElementById(id); }
function setBadge(text, cls) {
var el = byId('up');
el.textContent = text;
el.className = 'pill ' + (cls || '');
}
function refresh() {
getJson('/api/status').then(render).catch(function (e) {
setBadge('状态获取失败: ' + e.message, 'err');
});
}
function render(s) {
setBadge('运行 ' + fmtDur(s.uptimeMs), s.credsOk ? 'ok' : 'err');
var c = s.config;
byId('status').innerHTML = kv([
['监听', esc(c.host + ':' + c.port)],
['凭据', s.credsOk ? pill('有效', 'ok') : pill('缺失', 'err')],
['PoW 模式', pill(c.powMode, c.powMode === 'oracle' ? 'acc' : 'warn')],
['客户端版本', esc(c.clientVersion)],
['增量发送', c.deltaEnabled ? pill('开启', 'ok') : pill('关闭', 'warn')],
['增量阈值', esc(c.minDeltaChars + ' 字')],
['工具过滤', c.filterUndeclared ? pill('严格', 'warn') : pill('放行', 'ok')],
['上游', esc(c.baseUrl)],
['启动时间', esc(s.startedAtText)],
]);
var t = s.totals;
byId('totals').innerHTML = kv([
['请求总数', esc(t.requests)],
['其中增量', esc(t.deltaRequests)],
['其中全量', esc(t.fullRequests)],
['累计节省字数', esc(t.savedChars)],
['工具调用帧', esc(t.toolCalls)],
['错误次数', esc(t.errors)],
]);
var sb = byId('sessions');
if (!s.sessions.length) {
sb.innerHTML = "<tr><td colspan='7' class='empty'>还没有会话（发一条消息就会创建）</td></tr>";
} else {
sb.innerHTML = s.sessions.map(function (x) {
return '<tr>' +
'<td>' + esc(x.key) + '</td>' +
'<td>' + esc(x.sessionId || '-') + '</td>' +
'<td>' + esc(x.parent === null || x.parent === undefined ? '-' : x.parent) + '</td>' +
'<td>' + esc(x.historyCount) + '</td>' +
'<td>' + esc(x.historyChars) + '</td>' +
'<td>' + esc(fmtTime(x.updatedAt)) + '</td>' +
"<td><button class='danger' data-key='" + esc(x.key) + "' onclick='resetOne(this)'>重置</button></td>" +
'</tr>';
}).join('');
}
var rb = byId('recent');
if (!s.recent.length) {
rb.innerHTML = "<tr><td colspan='9' class='empty'>暂无请求</td></tr>";
} else {
rb.innerHTML = s.recent.map(function (r) {
var cls = r.status === 'ok' ? 'ok'
: (r.status === 'tool' ? 'acc'
: (r.status === 'pending' ? 'warn' : 'err'));
var label = r.status === 'pending' ? '进行中' : (r.reason || r.status);
return '<tr>' +
'<td>' + esc(fmtTime(r.t)) + '</td>' +
'<td>' + esc(r.model) + '</td>' +
'<td>' + esc(r.user) + '</td>' +
'<td>' + (r.stream ? '是' : '否') + '</td>' +
'<td>' + esc(r.msgs) + '</td>' +
'<td>' + pill(r.mode, r.mode === 'delta' ? 'ok' : 'warn') + '</td>' +
'<td>' + esc(r.sentChars + ' / ' + r.fullChars) + '</td>' +
'<td>' + esc(fmtDur(r.ms)) + '</td>' +
'<td>' + pill(label, cls) + '</td>' +
'</tr>';
}).join('');
}
}
function resetOne(btn) {
var key = btn.getAttribute('data-key');
var i = key.indexOf('|');
var model = i < 0 ? key : key.slice(0, i);
var user = i < 0 ? 'default' : key.slice(i + 1);
postJson('/api/reset', { model: model, user: user }).then(refresh);
}
function resetAll() {
if (!confirm('确定重置全部会话？下次请求会重新建上游会话并全量发送。')) return;
postJson('/api/reset-all', {}).then(refresh);
}
var TOOLS = [{
type: 'function',
function: {
name: 'read_file',
description: '读取本地文件内容',
parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
},
}];
function sendTest() {
var out = byId('tOut');
var meta = byId('tMeta');
var btn = byId('tSend');
var prompt = byId('tPrompt').value;
if (!prompt.trim()) return;
var body = {
model: byId('tModel').value,
stream: byId('tStream').checked,
messages: [{ role: 'user', content: prompt }],
};
if (byId('tTools').checked) body.tools = TOOLS;
if (byId('tNew').checked) body.new_session = true;
out.textContent = '';
meta.textContent = '请求中…';
btn.disabled = true;
var t0 = Date.now();
if (!body.stream) {
fetch('/v1/chat/completions', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body),
})
.then(function (r) { return r.text().then(function (t) { return { s: r.status, t: t }; }); })
.then(function (x) {
out.textContent = x.t;
meta.textContent = 'HTTP ' + x.s + ' · ' + fmtDur(Date.now() - t0);
})
.catch(function (e) { out.textContent = '错误: ' + e.message; })
.then(function () { btn.disabled = false; refresh(); });
return;
}
fetch('/v1/chat/completions', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body),
}).then(function (r) {
if (!r.body) throw new Error('响应没有 body');
var reader = r.body.getReader();
var dec = new TextDecoder('utf-8');
var buf = '';
var text = '';
var frames = 0;
var finished = false;
function pump() {
return reader.read().then(function (res) {
if (res.done) {
meta.textContent = '完成 · ' + frames + ' 帧 · ' + fmtDur(Date.now() - t0) +
(finished ? '' : ' · 缺少 finish_reason');
return;
}
buf += dec.decode(res.value, { stream: true });
var idx;
while ((idx = buf.indexOf(NL2)) >= 0) {
var block = buf.slice(0, idx);
buf = buf.slice(idx + 2);
var lines = block.split(NL);
for (var i = 0; i < lines.length; i++) {
var line = lines[i];
if (line.indexOf('data:') !== 0) continue;
var payload = line.slice(5).trim();
if (!payload) continue;
if (payload === '[DONE]') { finished = true; continue; }
frames++;
try {
var o = JSON.parse(payload);
if (o.error) {
text += NL + '[error] ' + o.error.message + NL;
out.textContent = text;
continue;
}
var ch = o.choices && o.choices[0];
if (!ch) continue;
if (ch.finish_reason) finished = true;
var d = ch.delta || {};
if (d.reasoning_content) {
text += '[思考] ' + d.reasoning_content;
out.textContent = text;
}
if (d.content) {
text += d.content;
out.textContent = text;
}
if (d.tool_calls) {
for (var j = 0; j < d.tool_calls.length; j++) {
var tc = d.tool_calls[j];
var fn = tc.function || {};
text += NL + '[tool] ' + (fn.name || '') + ' ' + (fn.arguments || '') + NL;
out.textContent = text;
}
}
} catch (e) { /* 坏帧忽略 */ }
}
}
return pump();
});
}
return pump();
})
.catch(function (e) { out.textContent = '错误: ' + e.message; })
.then(function () { btn.disabled = false; refresh(); });
}
byId('tSend').addEventListener('click', sendTest);
byId('btnRefresh').addEventListener('click', refresh);
byId('btnResetAll').addEventListener('click', resetAll);
refresh();
setInterval(refresh, 5000);