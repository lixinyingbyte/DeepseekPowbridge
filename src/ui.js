/**
管理面板：只负责 HTML + CSS。

前端脚本放在独立的 ui-client.js 里，由服务端读盘原样返回，

不经过任何字符串拼接、不需要任何转义。

本文件同样刻意不使用反斜杠字面量（换行用 String.fromCharCode 构造），

防止编辑链路上转义被吃掉导致面板整体加载失败。
*/

const NL = String.fromCharCode(10);
const PAGE_HEAD = [
'<!doctype html>',
'<html lang="zh-CN">',
'<head>',
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>DSX Proxy 管理面板</title>',
'<style>',
':root{--bg:#0f1115;--card:#171a21;--line:#242935;--fg:#e6e9ef;--dim:#8b93a3;--acc:#4c8dff;--ok:#3fb950;--warn:#d29922;--err:#f85149}',
'{box-sizing:border-box}',
'body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
'header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
'header h1{font-size:15px;margin:0;font-weight:600}',
'header .sp{flex:1}',
'main{padding:16px 20px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));align-items:start}',
'.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}',
'.card h2{font-size:13px;margin:0;padding:10px 14px;border-bottom:1px solid var(--line);font-weight:600;color:var(--dim);display:flex;gap:8px;align-items:center}',
'.card .body{padding:12px 14px}',
'table{width:100%;border-collapse:collapse;font-size:12px}',
'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}',
'th{color:var(--dim);font-weight:500}',
'tr:last-child td{border-bottom:none}',
'.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12px}',
'.kv dt{color:var(--dim)}',
'.kv dd{margin:0;word-break:break-all}',
'.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;border:1px solid var(--line)}',
'.pill.ok{color:var(--ok);border-color:rgba(63,185,80,.4)}',
'.pill.warn{color:var(--warn);border-color:rgba(210,153,34,.4)}',
'.pill.err{color:var(--err);border-color:rgba(248,81,73,.4)}',
'.pill.acc{color:var(--acc);border-color:rgba(76,141,255,.4)}',
'button{background:#222833;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer}',
'button:hover{border-color:var(--acc)}',
'button.primary{background:var(--acc);border-color:var(--acc);color:#fff}',
'button.danger{color:var(--err)}',
'button:disabled{opacity:.5;cursor:default}',
'input,select,textarea{background:#12151c;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font:inherit;font-size:12px;width:100%}',
'textarea{min-height:70px;resize:vertical;font-family:ui-monospace,Consolas,monospace}',
'.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
'.row>{width:auto}',
'pre{background:#0c0e13;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:320px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0}',
'.muted{color:var(--dim)}',
'.empty{color:var(--dim);padding:10px 0;text-align:center}',
'.think{color:#b58cff}',
'</style>',
'</head>',
'<body>',
'<header>',
'<h1>DSX Proxy 管理面板</h1>',
'<span id="up" class="pill acc">启动中…</span>',
'<span class="sp"></span>',
'<button id="btnRefresh">刷新</button>',
'<button id="btnResetAll" class="danger">重置全部会话</button>',
'</header>',
'<main>',
];
const BODY = [
'<section class="card">',
'<h2>运行状态</h2>',
'<div class="body"><dl class="kv" id="status"><dt>加载中…</dt><dd></dd></dl></div>',
'</section>',
'<section class="card">',
'<h2>累计统计</h2>',
'<div class="body"><dl class="kv" id="totals"><dt>加载中…</dt><dd></dd></dl></div>',
'</section>',
'<section class="card" style="grid-column:1/-1">',
'<h2>会话（每个 model|user 一条）</h2>',
'<div class="body">',
'<table><thead><tr><th>key</th><th>sessionId</th><th>parent</th><th>历史条数</th><th>历史字数</th><th>更新时间</th><th></th></tr></thead>',
'<tbody id="sessions"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody></table>',
'</div>',
'</section>',
'<section class="card" style="grid-column:1/-1">',
'<h2>最近请求</h2>',
'<div class="body">',
'<table><thead><tr><th>时间</th><th>model</th><th>user</th><th>流式</th><th>消息数</th><th>增量</th><th>发送/全量</th><th>耗时</th><th>结果</th></tr></thead>',
'<tbody id="recent"><tr><td colspan="9" class="empty">加载中…</td></tr></tbody></table>',
'</div>',
'</section>',
'<section class="card" style="grid-column:1/-1">',
'<h2>测试一条消息</h2>',
'<div class="body">',
'<div class="row" style="margin-bottom:8px">',
'<select id="tModel" style="width:160px"><option>deepseek-chat</option><option>deepseek-reasoner</option></select>',
'<label class="row" style="gap:4px"><input type="checkbox" id="tStream" checked style="width:auto"> 流式</label>',
'<label class="row" style="gap:4px"><input type="checkbox" id="tTools" style="width:auto"> 带示例工具</label>',
'<label class="row" style="gap:4px"><input type="checkbox" id="tNew" style="width:auto"> 开新对话</label>',
'<button class="primary" id="tSend">发送</button>',
'</div>',
'<textarea id="tPrompt">你好，请用一句话介绍你自己。</textarea>',
'<div class="row" style="margin:8px 0"><span class="muted" id="tMeta"></span></div>',
'<pre id="tOut">（输出会显示在这里）</pre>',
'</div>',
'</section>',
'</main>',
];
const PAGE_TAIL = [
'<script src="/ui-client.js"></script>',
'</body>',
'</html>',
].join(NL);
export function renderDashboard() {
return PAGE_HEAD.concat(BODY).join(NL) + NL + PAGE_TAIL;
}
export { PAGE_HEAD, BODY, PAGE_TAIL };