API 参考
服务默认监听 http://127.0.0.1:17380。
一、OpenAI 兼容端点
1.1 GET /v1/models
返回可用模型列表。
json

复制

下载

```
{
  "object": "list",
  "data": [
    { "id": "deepseek-chat", "object": "model", "owned_by": "deepseek" },
    { "id": "deepseek-reasoner", "object": "model", "owned_by": "deepseek" }
  ]
}
```

1.2 POST /v1/chat/completions
主端点。请求体遵循 OpenAI 规范，额外支持几个扩展字段。
请求字段

字段类型说明modelstringdeepseek-chat 或 deepseek-reasoner。含 reasoner/think/-r1 会自动开思考messagesarray必需。role + content，content 可以是字符串或 text 分片数组streamboolean是否流式，默认 falsetoolsarrayOpenAI 工具定义。声明了才会出现在下游 tool_calls 里（严格模式）userstring会话隔离维度，默认 default。不同 user 互不干扰thinkingboolean扩展。强制开思考enable_thinkingboolean扩展。同上，别名reasoningboolean扩展。同上，别名deep_thinkboolean扩展。同上，别名reasoning_effortstring扩展。OpenAI 标准字段，非 none/minimal 即开思考new_sessionboolean扩展。为真则重置该 model 加 user 的会话，本次全量发送
请求头

头说明Content-Type必须是 application/jsonx-session-id等价于 body 的 user 字段x-new-session: 1等价于 new_session: truex-session-action: reset同上
非流式响应
json

复制

下载

```
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1793516341,
  "model": "deepseek-chat",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "回答正文",
      "reasoning_content": "思考过程（开了思考才有）",
      "tool_calls": [
        {
          "id": "call_0",
          "type": "function",
          "function": { "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" }
        }
      ]
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "x_dsx": {
    "thinking": true,
    "delta_mode": "delta",
    "delta_reason": "prefix-matched",
    "sent_chars": 56,
    "full_chars": 1234,
    "sent_messages": 2,
    "full_messages": 9
  }
}
```

有 tool_calls 时 content 为 null，finish_reason 为 tool_calls。
usage 恒为 0，因为上游不返回 token 计数，这里不做伪造。
x_dsx 是本项目扩展字段，客户端可忽略。
流式响应
text

复制

下载

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"reasoning_content":"思考中"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"正文"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]
```

流式响应头

头说明X-DSX-Delta-Modefull 或 deltaX-DSX-Sent-Chars本次实际发给上游的字符数X-DSX-Full-Chars全量模式的字符数X-DSX-Thinking1 表示本次开了思考
二、流式协议契约
这一节是给客户端开发者看的。违反任何一条都会被严格客户端判为传输失败。
2.1 必须以 finish_reason 收尾
流中必须存在至少一个 finish_reason 非 null 的 chunk，且在 [DONE] 之前。
DeepSeek Harness 见到 [DONE] 前没有 finish_reason 就报 Stream ended without finish_reason，然后重试 5 次，5 次都同样的错，全部失败。
本代理在所有出口都保证这一条，包括出错路径：
text

复制

下载

```
data: {"error":{"message":"...","type":"upstream_error"}}
data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

2.2 tool_calls 的 delta 必须带 index
OpenAI SDK 靠 delta.tool_calls[].index 把多个分片拼成一个调用。缺了会拼错或丢参数。
2.3 content 里不能有控制块
DSX_CALL 和 DSML 这类标记必须在流式输出时就被抑制，不能先吐出去再在结束时不认账。
2.4 finish_reason 取值

值含义stop正常结束tool_calls模型要调工具length被截断（上游断开但已有正文）error上游出错（本代理会降级成 stop，部分客户端不认 error）
2.5 心跳
无输出超过 15 秒会发 SSE 注释帧，形式为冒号空格 ping 加两个换行，不占 choices。
三、管理接口
供内置面板使用，也可单独调。
3.1 GET /api/status
json

复制

下载

```
{
  "uptimeMs": 123456,
  "startedAtText": "2026-11-01 09:03:19",
  "credsOk": true,
  "config": {
    "host": "127.0.0.1",
    "port": 17380,
    "powMode": "oracle",
    "clientVersion": "2.7.1",
    "baseUrl": "https://chat.deepseek.com",
    "deltaEnabled": true,
    "minDeltaChars": 1,
    "filterUndeclared": false
  },
  "totals": {
    "requests": 42,
    "deltaRequests": 30,
    "fullRequests": 12,
    "savedChars": 158000,
    "toolCalls": 7,
    "errors": 1
  },
  "sessions": [
    {
      "key": "deepseek-chat|default",
      "sessionId": "e0d6bbca-...",
      "parent": 2,
      "historyCount": 9,
      "historyChars": 1234,
      "updatedAt": 1793516341000
    }
  ],
  "recent": [
    {
      "t": 1793516341000,
      "model": "deepseek-chat",
      "user": "default",
      "stream": true,
      "msgs": 9,
      "mode": "delta",
      "reason": "prefix-matched",
      "sentChars": 56,
      "fullChars": 1234,
      "savedChars": 1178,
      "status": "ok",
      "ms": 1203
    }
  ]
}
```

recent 最多保留 50 条。
3.2 POST /api/reset
重置单个会话。
json

复制

下载

```
{ "model": "deepseek-chat", "user": "default" }
```

3.3 POST /api/reset-all
重置全部会话，无参数。
3.4 GET /v1/sessions
会话列表，结构同 /api/status 的 sessions 字段。
3.5 POST /v1/sessions/reset
等价于 /api/reset，走 OpenAI 命名空间。
四、管理面板
GET / 返回内置面板 HTML，GET /ui-client.js 返回面板脚本。
面板功能：
运行状态：凭据、PoW 模式、增量开关、工具过滤模式、上游地址、启动时间

累计统计：请求总数、增量/全量次数、累计节省字数、工具调用帧数、错误次数

会话表：每个 model 加 user 的详情，可逐行重置

最近请求：时间、模型、增量模式、发送/全量字数、耗时、结果

测试框：选模型/流式/带工具/开新对话，直接打本代理 /v1，逐帧显示 content 和 reasoning_content

每 5 秒自动刷新。
五、错误响应
统一格式：
json

复制

下载

```
{ "error": { "message": "..." } }
```

状态码场景400请求体不是合法 JSON404路由不存在500代理内部异常502上游拒绝（PoW 无效、会话创建失败、连接中断）503没有可用凭据
上游业务错误（如 40301 INVALID_POW_RESPONSE）通过 502 返回，message 里带上游原始 code 和 msg。
六、示例
curl 非流式
bash

复制

下载

```
curl -s http://127.0.0.1:17380/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

curl 流式
bash

复制

下载

```
curl -N http://127.0.0.1:17380/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

curl 带工具
bash

复制

下载

```
curl -s http://127.0.0.1:17380/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"deepseek-chat","tools":[{"type":"function","function":{"name":"read_file","description":"读文件","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}],"messages":[{"role":"user","content":"看看 a.txt"}]}'
```

curl 开新对话
bash

复制

下载

```
curl -s http://127.0.0.1:17380/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"deepseek-chat","new_session":true,"messages":[{"role":"user","content":"重新开始"}]}'
```

Python SDK
python

复制

下载

```
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:17380/v1", api_key="not-needed")

resp = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "9.11 和 9.9 哪个大"}],
)
print("思考:", resp.choices[0].message.reasoning_content)
print("回答:", resp.choices[0].message.content)
```

注意：api_key 随便填，代理不校验；真正的凭据在 config.json 里。