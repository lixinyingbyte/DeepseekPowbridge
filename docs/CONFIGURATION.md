# 配置

配置文件默认是项目根目录的 `config.json`。首次运行 `start.bat` / `start.sh` 会从 `config.example.json` 复制一份。

> `config.json` 含真实凭据，已在 `.gitignore` 里排除，绝不要提交。

查找顺序：`--config 参数` → 环境变量 `DSX_CONFIG` → `config.json` → `config.example.json`。

## 一、完整示例

```json
{
  "host": "127.0.0.1",
  "port": 17380,

  "deepseek": {
    "baseUrl": "https://chat.deepseek.com",
    "clientVersion": "2.7.1",
    "bundleId": "com.deepseek.chat",
    "locale": "zh_CN",
    "timezoneOffset": 28800
  },

  "device": {
    "model": "PC"
  },

  "creds": {
    "bearer": "",
    "deviceId": "",
    "rangersId": ""
  },

  "pow": {
    "mode": "oracle",
    "oracleUrl": "http://127.0.0.1:17381/pow",
    "manualHeader": "",
    "timeoutMs": 60000
  },

  "delta": {
    "enabled": true,
    "minDeltaChars": 1
  },

  "tools": {
    "filterUndeclared": false
  },

  "log": {
    "level": "info"
  }
}
```

## 二、字段说明

### 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | string | `127.0.0.1` | 监听地址。改成 `0.0.0.0` 会暴露到局域网，谨慎 |
| `port` | number | `17380` | 监听端口。被占用时自动往后试 10 个 |

### deepseek

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | string | `https://chat.deepseek.com` | 上游地址 |
| `clientVersion` | string | `2.7.1` | 伪装成客户端的版本号，会进 `x-client-version` 头 |
| `bundleId` | string | `com.deepseek.chat` | 进 `x-client-bundle-id` 头 |
| `locale` | string | `zh_CN` | 进 `x-client-locale` 头 |
| `timezoneOffset` | number | `28800` | 时区偏移秒数，东八区是 28800 |

`clientVersion` 建议跟着官方 App 更新。版本太旧可能被上游拒绝，太新可能没有对应行为。当前实测可用的是 `2.7.1`。

### device

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `model` | string | `PC` | 进 `x-device-model` 头 |

改成真实机型名（如 `CDY-AN00`）可能降低风控概率，但没有明确证据。

### creds

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bearer` | string | `Authorization` 头去掉 `Bearer` 前缀后的值。必需 |
| `deviceId` | string | `x-device-id` 头的值。必需 |
| `rangersId` | string | `x-rangers-id` 头，通常为空 |

`bearer` 和 `deviceId` 任一为空，`creds.ok()` 返回 false，所有请求直接 503。

获取方式见根 [README](../README.md) 第二节。有效期通常数天，过期后需要重新抓。

### pow

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | string | `oracle` | `oracle` / `manual` / `heuristic`，详见 [POW.md](POW.md) |
| `oracleUrl` | string | `http://127.0.0.1:17381/pow` | oracle 模式的求解服务地址 |
| `manualHeader` | string | 空 | `manual` 模式下直接用的 base64 头 |
| `timeoutMs` | number | `60000` | 求解超时 |
| `challengePath` | string | 自动 | 申请挑战的路径，一般不用改 |
| `allowUnsafe` | boolean | `false` | 允许降级到 `heuristic`。默认禁用，因为 `heuristic` 实测会被上游拒绝 |

### delta

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 关掉则每次都全量发送 |
| `minDeltaChars` | number | `1` | 增量字数低于此值就退回全量 |

关掉增量的场景：调试时想看完整 prompt，或者怀疑增量逻辑导致上下文错乱。

### tools

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `filterUndeclared` | boolean | `false` | `true` 则丢弃 `body.tools` 里没声明的工具调用 |

默认放行（`false`）是因为实测发现：严格过滤会让模型想调的 `pwd` / `run_command` 被静默吞掉，客户端只看到「说了一句话就停下」，反而更难排查。

需要防止模型乱编工具名时再打开。

### log

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `level` | string | `info` | 目前仅占位，日志级别暂未实现分支 |

## 三、环境变量

| 变量 | 说明 |
| --- | --- |
| `DSX_CONFIG` | 指定配置文件路径，优先级低于 `--config` 参数 |
| `DSX_TEST_PORT` | 覆盖端口，冒烟测试用（默认 17999） |

## 四、命令行

```bash
node src/index.js                    默认读 config.json
node src/index.js --config my.json   指定配置
node src/index.js --self-test        只自检，不启动
node src/pow-oracle.js --port 17381  启动 PoW 计算器骨架
```

`--self-test` 输出示例：

```text
[BOOT] 已加载配置 .../config.json
[SELF] 配置加载 OK
[SELF] 凭据完整: true
[SELF] PoW 模式: oracle
[SELF] 上游: https://chat.deepseek.com
[SELF] 增量发送: 开启（阈值 1 字）
[SELF] 工具过滤: 放行（原样透传）
```

凭据不完整时会额外打一行提示：

```text
[SELF] 提示：在 config.json 的 creds.bearer / creds.deviceId 填入抓包值
```

## 五、安全提示

- `config.json` 有真实凭据，`.gitignore` 已排除。分享项目前用 `git status` 确认它没被 add。
- 不要把 `host` 改成 `0.0.0.0` 后在没有防火墙的机器上运行——任何人拿到你的本地端口就等于用你的账号。
- 本项目不分发、不代理他人的凭据，每个部署者用自己的账号。
