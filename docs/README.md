# 文档索引

DeepseekPowbridge 的开发文档，按阅读顺序排列。

| 文档 | 内容 | 读者 |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层架构、模块职责、一次请求的完整数据流 | 想改代码的人 |
| [API.md](API.md) | OpenAI 兼容端点、管理接口、错误码、响应头 | 接入方 |
| [CONFIGURATION.md](CONFIGURATION.md) | `config.json` 每个字段的含义与默认值 | 部署者 |
| [POW.md](POW.md) | PoW 三种模式、base 形态、oracle 部署 | 卡在 40301 的人 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 本地开发、测试矩阵、已知坑 | 贡献者 |

## 快速导航

- 想跑起来：根目录 [README](../README.md) 的第一、二节
- 报 `40301 INVALID_POW_RESPONSE`：[POW.md](POW.md)
- 客户端说 `Stream ended without finish_reason`：[API.md](API.md#二流式协议契约) 的「流式协议契约」
- 思考内容混进正文：[ARCHITECTURE.md](ARCHITECTURE.md#四思考分流最容易写错的地方) 的「思考分流」
- 想加新的工具格式：[ARCHITECTURE.md](ARCHITECTURE.md#九扩展点) 的「扩展点」
