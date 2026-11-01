# 开发指南

## 一、环境要求

- Node.js >= 18（用到内置 `fetch` 和 `AbortController`）
- 无任何第三方依赖，`package.json` 里没有 `dependencies`

## 二、本地开发

```bash
git clone <repo>
cd DeepseekPowbridge-main
cp config.example.json config.json
# 编辑 config.json，填 creds.bearer 和 creds.deviceId
node src/index.js --self-test     # 先自检
node src/index.js                 # 启动
```

改完代码直接重启进程即可，没有构建步骤、没有热重载。

## 三、测试矩阵

```bash
npm run regress    # 68 项，离线回归
npm run smoke      # 7 项，HTTP 层冒烟
npm test           # 两个都跑
```

通过时应看到 `68/68 通过` 和 `7/7 通过`。

### 3.1 regress.mjs

用假的 upstream 直接驱动 `createServer`，不联网。覆盖：

| 组 | 内容 |
| --- | --- |
| P1–P14 | prompt 不注入任何自造结构，只拼接正文 |
| A1–A3 | 严格模式下未声明工具被丢弃 |
| B1–B7 | DSX 工具调用解析、delta 带 index、finish_reason 正确 |
| C1–C3 | 上游出错仍有 finish_reason，带 error 对象，以 DONE 收尾 |
| D1–D3 | 标记跨 chunk 拆分仍能识别 |
| E1–E2 | 非流式路径同样过滤 |
| F1–F2 | 普通文本完整输出 |
| G1–G5 | DSML 完整块解析 |
| H1–H3 | DSML 跨 chunk 拆分 |
| I1–I3 | 只有 DSML 无前置文本 |
| J1–J3 | 非流式 DSML |
| K1–K3 | `string` 属性 / 数字 / 布尔类型还原 |
| L1–L8 | 思考模式：三种触发、`reasoning_content` 分离、流式正确 |
| M1–M9 | 增量：首次 full、第二次 delta、前缀不一致退回 full、`new_session` 重置 |

测试桩的关键：假 `Sessions` 必须是有状态的（用 Map 存 history），否则增量用例永远走 full。这个坑踩过一次。

### 3.2 smoke.mjs

启动真实进程（端口 17999，用 `config.example.json` 的空凭据），验证：

- `GET /v1/models` 返回 200 且包含两个模型
- 未知路由 404
- 无凭据时 503
- 503 响应体带 `error.message`
- 流式请求无凭据也立即 503，不卡住

## 四、代码风格

- ESM，`"type": "module"`
- 两空格缩进
- 不用第三方库，Node 内置优先
- 注释写「为什么」不写「做什么」

## 五、编辑时的避坑清单

这个项目有几次因为编辑链路上的字符丢失导致代码损坏，教训如下。

### 5.1 不要在源码里写反斜杠字面量

`toolcalls.js` 和 `ui-client.js` 刻意不含任何反斜杠：

```js
// 好：运行时构造
const P = String.fromCharCode(0xFF5C);
const NL = String.fromCharCode(10);
const AMP = String.fromCharCode(38, 97, 109, 112, 59);

// 坏：字面量可能在编辑/传输中被吃掉
const re = /\s+/;
const s = '\n';
```

DSML 的分隔符是全角竖线 `U+FF5C`，`upstream.js` 里的 `THINK_PATH` 也用同样方式拼（`String.fromCharCode(95)` 是下划线）。

### 5.2 改文件优先用行级脚本

大文件用整块替换时，如果搜索串里的缩进和实际不符就会静默失败。稳妥做法是写一个 `.cjs` 脚本按行号操作：

```js
const fs = require('fs');
const lines = fs.readFileSync('src/server.js', 'utf8').split(/\r?\n/);
lines.splice(idx, 0, 'inserted line');
fs.writeFileSync('src/server.js', lines.join('\n'));
```

写完立刻 `node --check` 验证。

### 5.3 改完必须跑测试

```bash
node --check src/*.js && npm test
```

语法错误和逻辑错误分开查，别混在一起。

## 六、已知坑

### 6.1 上游业务错误藏在 HTTP 200 里

```json
{"code":40301,"msg":"INVALID_POW_RESPONSE","data":null}
```

不先判断 `content-type` 的话，SSE 解析器会读到 0 片段就静默「成功结束」，客户端只看到空回复。

### 6.2 流在无正文时断开必须报错

上游偶尔发完 ready 就直接断连，一帧正文都没有。当成正常 `stop` 上报的话，客户端会收到空 assistant 消息并报 `Stream ended without finish_reason`，且不触发重试。

判定规则：

- 收到 `status` 或 DONE → 用其 reason
- 连接关闭且有正文 → `length`
- 连接关闭且无正文 → `error`

### 6.3 parent_message_id 不能恒为 null

必须用 SSE ready 帧实时下发的 `response_message_id`。指向「已经有孩子的节点」会让上游把消息当成修改版本。

### 6.4 思考增量只有下标没有类型

见 [ARCHITECTURE.md](ARCHITECTURE.md#四思考分流最容易写错的地方) 第四节。

### 6.5 管理面板脚本不能拼进 HTML 字符串

拼进去就要处理转义，而转义在编辑链路上极其脆弱。现在拆成独立文件 `src/ui-client.js`，服务端 `fs.readFileSync` 原样返回。

## 七、目录结构

```text
DeepseekPowbridge-main/
├── start.bat / start.sh      一键启动
├── config.example.json       配置模板（可入库）
├── config.json               实际配置（已 gitignore）
├── package.json              无依赖
├── README.md                 项目说明
├── docs/                     开发文档
│   ├── README.md             索引
│   ├── ARCHITECTURE.md       架构
│   ├── API.md                接口
│   ├── CONFIGURATION.md      配置
│   ├── POW.md                PoW
│   └── DEVELOPMENT.md        本文件
├── src/
│   ├── index.js              入口
│   ├── server.js             HTTP 路由 + 编排
│   ├── upstream.js           上游客户端 + SSE 解析
│   ├── prompt.js             messages 拼接 + 标记常量
│   ├── diff.js               增量比对
│   ├── toolcalls.js          DSX / DSML 解析
│   ├── sessions.js           会话映射
│   ├── pow.js                PoW 三模式
│   ├── pow-oracle.js         计算器骨架
│   ├── creds.js              凭据
│   ├── http.js               fetch 包装
│   ├── log.js                带时间戳日志
│   ├── ui.js                 面板 HTML + CSS
│   └── ui-client.js          面板前端脚本
└── test/
    ├── regress.mjs           68 项离线回归
    ├── smoke.mjs             7 项冒烟
    └── pow-search.mjs        PoW 输入拼接穷举（研究用，依赖外部 keccak.mjs）
```

`test/pow-search.mjs` 是 PoW 算法的逆向研究脚本，不属于自动化测试，也不在 `npm test` 里。它顶部 `import { keccak256, sha3_256 } from './keccak.mjs'`，而 `keccak.mjs` 未随仓库提供，直接跑会报模块找不到——需要自己补一个 Keccak-256 实现才能用。

## 八、贡献流程

1. fork 后在新分支改
2. `node --check src/*.js && npm test` 全绿
3. 涉及新功能的，在 `test/regress.mjs` 加对应用例
4. 提交前确认 `git status` 里没有 `config.json`
5. PR 描述里写清楚「解决什么问题」而不是「改了什么」
