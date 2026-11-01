# DeepseekPowbridge
把 DeepSeek 官方 App 的登录态，包装成一个本地 OpenAI 兼容 API。
任何支持 OpenAI SDK 的客户端——Cursor、OpenWebUI、LobeChat、DeepSeek Harness、或者你自己写的一段 fetch——把 base_url 指到 http://127.0.0.1:17380/v1 就能用。
不需要 API Key，不需要充值，走你自己账号的额度。
本项目仅供学习 HTTP 协议与本地 API 适配，请遵守 DeepSeek 服务条款。每个部署者使用自己的账号凭据。
特性
OpenAI 兼容：/v1/chat/completions、/v1/models，流式与非流式都支持

深度思考：deepseek-reasoner 或 reasoning_effort 触发，思考内容走 reasoning_content，不混进正文

工具调用：识别 DeepSeek 原生的 DSML 标签和旧版 DSX 控制块，转成标准 tool_calls

增量发送：多轮对话只发新增消息，不用每轮重传整段历史

会话隔离：按 model 加 user 分开，并发不串台

管理面板：浏览器打开就能看状态、会话、请求记录，还能直接发测试消息

零依赖：只有 Node.js 内置模块，npm install 都不需要

快速开始
环境
Node.js 18 或更高（需要内置 fetch）

一个已登录的 DeepSeek 账号

PoW 计算器：一台能跑 DeepSeek App 的 Android 手机（见下方说明）

三步跑起来
第一步：启动
Windows 双击 start.bat，macOS / Linux 执行 ./start.sh。
首次运行会自动从 config.example.json 复制出 config.json 并打开编辑器。
第二步：填凭据
需要两个值：creds.bearer 和 creds.deviceId。
获取方式（浏览器 DevTools，最简单）：
电脑浏览器访问 https://chat.deepseek.com 并登录

按 F12 打开 Network，随便发一条消息

找任意一条 api/v0/ 开头的请求，在 Request Headers 里复制：
Authorization 去掉 Bearer 前缀，填到 creds.bearer

x-device-id，填到 creds.deviceId

有效期通常几天，过期后重做一次。
第三步：配 PoW
DeepSeek 每次对话都要求一个工作量证明头，算法在客户端的 librscrypto.so 里。电脑上没有这个库，所以需要一台 Android 手机当计算器：
bash

复制

下载

```
# 手机装好 dsxsniff 模块并打开 DeepSeek App
adb forward tcp:17381 tcp:17381
adb forward --list          # 必须能看到 tcp:17381
```

然后 config.json 里保持默认的 "pow": {"mode": "oracle"} 即可。
没配 PoW 也能启动，但每次请求会报「oracle 不可达」。详见 docs/POW.md。
验证
bash

复制

下载

```
curl http://127.0.0.1:17380/v1/models
```

返回两个模型就说明活了。
客户端接入
OpenAI SDK（Python）
python

复制

下载

```
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:17380/v1", api_key="any")

resp = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "9.11 和 9.9 哪个大"}],
)
print("思考：", resp.choices[0].message.reasoning_content)
print("回答：", resp.choices[0].message.content)
```

api_key 随便填，代理不校验；真凭据在 config.json 里。
环境变量方式
bash

复制

下载

```
export OPENAI_BASE_URL=http://127.0.0.1:17380/v1
export OPENAI_API_KEY=any
```

管理面板
浏览器打开 http://127.0.0.1:17380/
能看到运行状态、累计统计、会话列表、最近 50 条请求，还有一个测试框可以直接发消息并逐帧看输出。
常用操作
开深度思考
三种方式任选：
json

复制

下载

```
{"model": "deepseek-reasoner"}
{"model": "deepseek-chat", "thinking": true}
{"model": "deepseek-chat", "reasoning_effort": "high"}
```

思考内容走 reasoning_content，正文走 content，两者分开。
开新对话
json

复制

下载

```
{"new_session": true, "messages": []}
```

或者发请求头 x-new-session: 1。会清掉当前 model 加 user 的会话，下次全量发送。
多账号 / 多会话
用 user 字段区分：
json

复制

下载

```
{"user": "alice", "messages": []}
{"user": "bob", "messages": []}
```

各自的会话、历史、增量指纹互不干扰。
增量发送
默认开启。第二次起只在历史前缀没变时发送新增消息，日志会打节省了多少字：
text

复制

下载

```
[API] 增量 mode=delta reason=prefix-matched 全量=1234字/9条 本次=56字/2条 节省=1178字
```

要关掉的话在 config.json 里设 "delta": {"enabled": false}。
文档

文档内容docs/ARCHITECTURE.md分层架构、一次请求的完整数据流、思考分流、工具解析docs/API.md全部端点、请求/响应格式、流式协议契约、错误码docs/CONFIGURATION.mdconfig.json 每个字段的含义与默认值docs/POW.mdPoW 三种模式、base 形态、oracle 部署、40301 排查docs/DEVELOPMENT.md本地开发、测试矩阵、编辑避坑清单
常见问题
客户端报 Stream ended without finish_reason 然后重试 5 次
这是 DeepSeek Harness 这类严格客户端的典型症状。原因是流里没有带 finish_reason 的 chunk 就发了 [DONE]。
本代理在所有出口（包括错误路径）都保证有 finish 帧。如果还遇到，检查是不是用了旧版代码，或者客户端要求的字段和 OpenAI 规范有出入。
报 40301 INVALID_POW_RESPONSE
PoW 没算对。按顺序排查：
adb forward --list 有没有 tcp:17381

dsxsniff 日志有没有 [POWSRV] bind OK

看代理日志里「命中 base 形态」那行，应该是 salt_expire

是不是用了 heuristic 模式——那个模式实测会被上游拒绝

详见 docs/POW.md。
模型总是调用不存在的工具（比如 pwd、Bash）
tools.filterUndeclared 默认是 false（放行），模型吐什么就转什么。如果希望严格过滤，改成 true：
json

复制

下载

```
"tools": { "filterUndeclared": true }
```

但要注意：严格过滤会让模型想调但没在请求里声明的工具被静默丢弃，客户端只看到「说了一句话就停下」，反而更难排查。
思考内容混进了正文
旧版本的 bug，已在 upstream.js 修复。原因是上游思考增量走 response/thinking_content 路径，而兜底判断用的是 p.includes('content')，两者冲突。现在先判思考路径再判 content。
确认代码是最新的：findstr THINK_PATH src/upstream.js 应该有输出。
换个客户端版本号
改 config.json 的 deepseek.clientVersion。当前实测可用的是 2.7.1。版本太旧可能被上游拒绝。
端口被占用
会自动往后试 10 个端口。日志里会打「端口 17380 被占用，改用 17381」。
项目结构
text

复制

下载

```
pc-demo/
├── start.bat / start.sh      一键启动
├── config.example.json       配置模板
├── config.json               实际配置（已 gitignore，含凭据）
├── package.json              无第三方依赖
├── README.md                 本文件
├── docs/                     开发文档
├── src/
│   ├── index.js              入口、组装依赖、监听端口
│   ├── server.js             HTTP 路由、流式编排、统计
│   ├── upstream.js           上游请求构造 + SSE 解析
│   ├── prompt.js             messages 拼接 + 工具标记常量
│   ├── diff.js               增量比对
│   ├── toolcalls.js          DSX / DSML 工具解析
│   ├── sessions.js           会话映射（sessionId / parent / history）
│   ├── pow.js                PoW 三种模式
│   ├── pow-oracle.js         计算器骨架
│   ├── creds.js / http.js / log.js
│   ├── ui.js                 面板 HTML + CSS
│   └── ui-client.js          面板前端脚本
└── test/
    ├── regress.mjs           68 项离线回归
    ├── smoke.mjs             7 项冒烟
    └── pow-search.mjs        PoW 输入拼接穷举（研究用，依赖外部 keccak.mjs）
    └── pow-search.mjs        PoW 输入拼接穷举（PoW 研究）
```

测试
bash

复制

下载

```
npm run regress    # 68 项，离线，用假 upstream
npm run smoke      # 7 项，真进程
npm test           # 两个都跑
```

全部通过应该看到：
text

复制

下载

```
68/68 通过
7/7 通过
```

已知限制
PoW 的 heuristic 模式不可靠，生产必须用 oracle

会话映射在内存，进程重启后上游会开新会话（模型失忆一次）

凭据需要手动续期，数天过期一次

usage 字段恒为 0，因为上游不返回 token 计数

只在 Windows 上充分测试过，macOS / Linux 理论上可用但未验证

安全
config.json 含真实凭据，已在 .gitignore 里排除。提交前用 git status 确认它没被 add。
默认监听 127.0.0.1，只有本机能访问。改成 0.0.0.0 等于把账号借给整个局域网，务必确认有防火墙保护。
许可
仅供学习研究。使用本工具产生的任何后果由使用者自负，包括但不限于账号被限制、服务条款违约等。请自行评估风险。