# 架构

## 一、它是什么

DeepseekPowbridge 是一个单向协议适配层：把 DeepSeek 官方 App 的私有 HTTP/SSE 协议，翻译成 OpenAI 兼容的 `/v1/chat/completions`。

不是反向代理（不转发、不缓存、不改写上游响应体），而是重新实现了一遍客户端行为。

```text
   OpenAI 客户端                  DeepseekPowbridge                 chat.deepseek.com
  ┌──────────────┐              ┌──────────────────┐              ┌──────────────────┐
  │ Cursor /     │  OpenAI 协议 │  server.js       │ DeepSeek 私有 │  /api/v0/        │
  │ OpenWebUI /  │ ───────────► │   ├ prompt.js    │ ───────────► │   chat_session/  │
  │ DeepSeek     │              │   ├ diff.js      │              │   create         │
  │ Harness /    │              │   ├ toolcalls.js │              │   create_pow_    │
  │ 任意 SDK     │ ◄─────────── │   └ upstream.js  │ ◄─────────── │   challenge      │
  └──────────────┘  SSE/tool    │                  │   SSE        │   chat/          │
                                │  sessions.js     │              │   completion     │
                                │  pow.js          │              └──────────────────┘
                                │  ui.js           │                      │
                                └──────────────────┘                      │
                                         │                                │
                                         └─────── pow-oracle ─────────────┘
                                              (adb → 真机 native)
```

## 二、模块职责

| 文件 | 职责 | 不该做的事 |
| --- | --- | --- |
| `src/index.js` | 读配置、组装依赖、监听端口、SIGINT 关闭 | 不写业务逻辑 |
| `src/server.js` | HTTP 路由、流式/非流式编排、工具解析与过滤、统计埋点 | 不直接发上游请求 |
| `src/upstream.js` | 构造上游请求、解析上游 SSE、把增量分发给 sink | 不管 OpenAI 格式 |
| `src/prompt.js` | `messages[]` → 单个 prompt 字符串；导出工具标记常量 | 不注入任何自造结构 |
| `src/diff.js` | messages 指纹、增量比对、决定 full/delta | 不碰网络 |
| `src/toolcalls.js` | 从模型回复里解析 DSX / DSML 两种工具格式 | 不做流式抑制 |
| `src/sessions.js` | `model\|user` → sessionId / parent / history 的映射 | 不解析 SSE |
| `src/pow.js` | 申请挑战、三种模式求 answer、构造请求头 | 不处理会话 |
| `src/ui.js` | 管理面板 HTML + CSS | 不含 JS 逻辑 |
| `src/ui-client.js` | 管理面板前端逻辑，独立文件由服务端原样返回 | 不被任何字符串拼接 |
| `src/creds.js` `http.js` `log.js` | 凭据读取、fetch 包装、带时间戳的日志 | — |

关键约束：`prompt.js` 只做文本拼接，不知道工具、角色、协议的存在。所有协议知识集中在 `server.js` 和 `toolcalls.js`。这条约束是踩坑换来的——早期 `prompt.js` 注入 `[[DSX_CALL]]` 格式和硬编码示例，导致模型照抄示例去调不存在的 `Bash`/`uname`。

## 三、一次请求的完整数据流

```text
POST /v1/chat/completions
  │
  ├─[1] server.js handleChat()
  │     ├ 解析 body，取 model / user / stream / messages
  │     ├ 检查 new_session → 命中则 sessions.reset()
  │     └ creds.ok() 为假 → 503 直接返回
  │
  ├─[2] diff.js computeDelta(messages, history)
  │     ├ 无 history          → mode=full
  │     ├ 前缀 hash 一致       → mode=delta，只取新增 user/tool
  │     └ 其他任何异常        → mode=full（正确性优先）
  │
  ├─[3] prompt.js buildPromptFromMessages(sendMessages)
  │     └ 各条 content 用双换行拼接，不做任何包装
  │
  ├─[4] sessions.get(model, user) → chat_session_id
  │     └ 首次调用走 POST /api/v0/chat_session/create
  │
  ├─[5] server.js 决定 thinking
  │     └ isThinkingRequest(): 模型名 / body 开关 / reasoning_effort
  │
  ├─[6] upstream.js chat()
  │     ├ pow.makeHeader() → x-ds-pow-response
  │     ├ POST /api/v0/chat/completion  { thinking_enabled, prompt, parent_message_id }
  │     └ 按 content-type 分流：application/json = 业务错误；text/event-stream = SSE
  │
  ├─[7] upstream.js readSse()
  │     ├ ready 帧         → sessions.setParent(response_message_id)
  │     ├ fragments/<i>/content → 查 fragTypes[i] → onThink 或 onText
  │     ├ thinking_content → onThink
  │     ├ status 帧        → FINISHED/INCOMPLETE/FAILED → onDone(reason)
  │     └ 连接关闭无结束帧  → 有正文报 length，无正文报 error
  │
  ├─[8] server.js 流式抑制（仅流式路径）
  │     ├ pending 缓冲 + findFirstMarker() 找最早的工具标记
  │     ├ 标记前的文本正常输出
  │     ├ partialMarkerLen() 处理标记跨 chunk 拆分
  │     └ 标记及其后内容整块吞掉，不进 content
  │
  ├─[9] onDone: toolcalls.js parseToolCalls()
  │     ├ 先试 DSX  [[DSX_CALL]]{json}[[/DSX_CALL]]
  │     └ 再试 DSML <||DSML|| invoke name="x"><||DSML|| parameter ...>
  │
  ├─[10] filterDeclared()（默认关闭）
  │     └ 严格模式：丢弃 body.tools 里没声明的工具名
  │
  └─[11] 收尾
        ├ 有 tool_calls → finish_reason=tool_calls，delta 带 index
        ├ 无 → finish_reason 用上游 reason，error 降级为 stop
        ├ 无论如何先发一个带 finish_reason 的帧，再发 [DONE]
        └ commitHistory() 记录本次 messages 指纹
```

## 四、思考分流（最容易写错的地方）

开思考时，上游下发两个 fragment：

```text
fragments[0] = { type: "THINK",  content: "……" }   思考过程
fragments[1] = { type: "ANSWER", content: "……" }   正式回答
```

首帧给的是完整结构，能拿到 `type`。但后续增量帧是：

```json
{"p": "response/fragments/0/content", "v": "下一个字"}
```

只有下标，没有类型。所以必须维护一张表：

```js
const fragTypes = [];        // 下标 → 'THINK' | 'ANSWER'
// 首帧/全量帧时刷新
fragTypes[i] = f.type;
// 增量帧时查表
const type = fragTypes[idx];
```

早期没建这张表，所有增量都走 `onText`，思考内容就混进了正文。

还有第二个坑：上游思考增量还有一条独立路径 `p = "response/thinking_content"`。早期用 `p.includes('content')` 兜底判断，而 `"response/thinking_content"` 里也含 "content"，于是被当成正文。现在必须在兜底分支之前先判思考路径：

```js
if (p.indexOf(THINK_PATH) >= 0 || p.indexOf('reasoning_content') >= 0) {
  emit('onThink', v);      // 必须先于 content 判断
  return null;
}
if (p.includes('content')) {
  emit('onText', v);
}
```

## 五、工具调用解析

支持两种格式，互斥（DSX 解析出结果就不再试 DSML，避免重复）。

### 5.1 DSX（旧版 Android 模块自造）

```text
[[DSX_CALL]]
{"calls":[{"id":"t1","tool":"read_file","path":"a.txt"}]}
[[/DSX_CALL]]
```

提取第一个 `{` 到最后一个 `}`，容错 JSON（去 BOM/零宽字符、中文引号转半角、去尾逗号）后 `JSON.parse`。

### 5.2 DSML（DeepSeek 网页/App 原生）

```text
<||DSML|| calls>
<||DSML|| invoke name="read">
<||DSML|| parameter name="file_path" string="true">a.txt</||DSML|| parameter>
</||DSML|| invoke>
</||DSML|| calls>
```

（实际是全角竖线 U+FF5C，上面为可读性用半角示意）

`toolcalls.js` 用纯字符串扫描实现，不用正则：逐字符找 `<||DSML||`，解析标签名和 `name` / `string` 属性，按 `invoke` / `parameter` 配对取值。

为什么不用正则：源码里的 `\s`、`\[`、`\n` 这类转义经过多轮编辑/传输可能被吃掉，正则就变成错的。现在所有特殊字符用 `String.fromCharCode(0xFF5C)` 之类运行时构造，源码里一个反斜杠字面量都没有。

类型还原：`string="true"` 保持字符串；否则尝试 `true`/`false`/`null`/整数/小数，都不是就保持原串。

## 六、流式抑制

控制块绝不能出现在 `content` 里。做法：

```text
feedText(d):
  full.push(d)                     // 完整文本留一份给解析器
  if (suppressing) return          // 已经进入控制块，丢弃
  pending += d
  hit = findFirstMarker(pending)   // 遍历所有标记找最早的
  if (hit):
    if (hit.start > 0) write(content = pending[0..hit.start])
    suppressing = true             // 此后一律不再输出正文
    return
  keep = partialMarkerLen(pending) // 末尾可能是标记的前缀
  write(content = pending[0..len-keep])
  pending = pending[len-keep..]
```

`partialMarkerLen()` 解决标记被拆到两个 chunk 的情况——`[[DSX` 和 `_CALL]]` 分别到达时，不能把 `[[DSX` 当正文吐出去。

非流式路径用 `stripCallBlocks()` 做同样的清理，兜底。

## 七、增量发送

上游靠 `chat_session_id + parent_message_id` 维护上下文，天然支持只发新增内容。

`diff.js` 的做法：

- 每条消息规范化成 `role长度:role|content长度:content|toolcalls长度:json`，带长度前缀避免分隔符歧义
- 整个数组 sha256 作为指纹
- 下次请求比对 `messages[0..count]` 的 hash
- 一致 → 只取新增里 `role` 为 `user` / `tool` 的

assistant 消息不进增量——那是上游自己生成的回复，客户端回传只是回声，重发纯浪费 token。

任何不确定都退回 full：`no-history`、`no-new-messages`、`history-diverged`、`delta-only-assistant`、`delta-too-small`、`disabled`。

## 八、会话管理

key = `model|user`，三张 Map：

| Map | 内容 |
| --- | --- |
| `session` | key → chat_session_id |
| `parent` | key → parent_message_id |
| `history` | key → `{ count, hash, chars, sessionId, updatedAt }` |

`parent_message_id` 必须用 SSE ready 帧实时下发的 `response_message_id`，不能自己编，也不能重复用——指向「已经有孩子的节点」会让上游把消息当成修改版本。

`reset()` 同时清三张表，下次请求重新建会话并全量发送。

## 九、扩展点

想加新的工具格式：

1. `prompt.js` 的 `TOOL_MARKERS` 加一对 `{ start, end }`
2. `toolcalls.js` 的 `parseToolCalls()` 加一个解析分支
3. `server.js` 的 `stripCallBlocks()` 和 `findFirstMarker()` 自动生效（都遍历 `TOOL_MARKERS`）
4. `test/regress.mjs` 加一组用例

`TOOL_MARKERS` 是单一数据源，流式抑制和离线清理都从它推导，不会出现「流式认得、非流式不认得」的不一致。
