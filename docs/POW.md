PoW（工作量证明）
DeepSeek 的 `/api/v0/chat/completion` 强制要求 `x-ds-pow-response` 头。这个头是一个 base64 编码的 JSON，里面的 `answer` 必须由挑战参数算出来。
算法在客户端的 `librscrypto.so` 里，是 Rust 编译的。电脑上没有这个 so，纯 JS 复现不保证命中。
一、三种模式
配置在 `config.json` 的 `pow.mode`。

模式可靠性适用场景oracle100%日常使用（推荐）manual一次性接口联调，抓一个头贴进去heuristic不可靠研究用，实测会被上游拒绝
1.1 oracle（推荐）
把 base、challenge、difficulty 通过 HTTP 发给一个「计算器」，它返回 answer。
text

复制

下载

```
电脑 (pc-demo)  --POST /pow-->  oracle 服务  -->  真机 native
```

部署步骤：
手机上装好 dsxsniff 模块（在 LSPatch 里启用），打开 DeepSeek App

连 USB，开 USB 调试

建转发：

bat

复制

下载

```
adb forward tcp:17381 tcp:17381
adb forward --list
```

必须能看到 `tcp:17381 tcp:17381` 这一行，否则连接被拒。
模块日志里应该看到：

text

复制

下载

```
[POWSRV] PowCalculator 就绪 方法=a 实例=true
[POWSRV] bind OK port=17381
[POWSRV] base=[...] diff=144000 -> 112283
```

验证：用权威样本测一下

text

复制

下载

```
base     = 4ea0ae923a0a9debbdf6_1792823072798_
answer   应为 112283
```

USB 断开会导致转发失效，需要重新执行 adb forward。这是非 root 环境借用 native 算力的固有代价。
1.2 manual（临时联调）
直接抓一个 x-ds-pow-response 头贴到 `pow.manualHeader`。
json

复制

下载

```
"pow": {
  "mode": "manual",
  "manualHeader": "<把抓包得到的 x-ds-pow-response 头粘贴到这里>"
}
```

每次上游下发新挑战都要重新抓，只适合接口联调。
1.3 heuristic（兜底，默认禁用）
纯 JS 猜算法。从 librscrypto.so 提取的线索：
text

复制

下载

```
/root/.cargo/registry/src/.../keccak-0.2.0-pre.0/src/lib.rs
/root/.cargo/git/checkouts/rust-sha3-.../sha3c/src/lib.rs
A round_count greater than KECCAK_F_ROUND_COUNT is not supported
```

说明算法用的是 Keccak / SHA-3 家族，不是 SHA-256——这解释了为什么所有 sha256 拼接尝试全部失败。
当前实现会枚举 sha3-256、shake256、sha256 与几种输入拼接的组合，命中即缓存。但：
Node 的 sha3-256 与 Keccak-256 在 padding 上不同

即使算出一个数，上游也会返回 40301 INVALID_POW_RESPONSE

说明「哈希前 N 位不超过 difficulty」这个判据是错的，真实判定在 native 里

所以 heuristic 默认直接返回 -1 并提示改用 oracle，需要实验时把 `pow.allowUnsafe` 设为 true。
二、base 的形态（最关键）
base 第一段必须是服务端下发的 salt，不是随机 hex。
实测对比：
text

复制

下载

```
正确  salt + 下划线 + expire_at + 下划线
      c9933b13a231f0ef0635_1792929746859_   -> answer 64294

错误  20位随机hex + 下划线 + expire_at + 下划线
      fc3588ac1a765a3dddde_1792929413274_   -> -1
```

注意 salt 是 20 位 hex（如 c9933b13a231f0ef0635），不是 12 位。
早期实现只试随机 hex，导致所有请求都报 PoW 求解失败。
候选顺序（pow.js 的 candidateOrder）：
salt_expire — salt 加下划线加 expire_at 加下划线

salt_now — salt 加下划线加 now 加下划线

salt — 纯 salt

rand_expire / rand_now / challenge — 兜底

日志里会打命中哪一形态：
text

复制

下载

```
[POW] 命中 base 形态 salt_expire base=[c9933b13a231f0ef0635_1792929746859_] answer=64294
```

只要一直看到 salt_expire，说明形态对了。
三、挑战的获取
text

复制

下载

```
POST /api/v0/chat/create_pow_challenge
Body: {"target_path": "/api/v0/chat/completion"}
```

返回结构里有 challenge、salt、signature、difficulty、expire_at、algorithm。
pow.js 会递归找 challenge 字段，兼容几种嵌套形状。路径有 404 时自动回退到 /api/v0/create_pow_challenge。
四、x-ds-pow-response 的构造
算出 answer 后：
js

复制

下载

```
const payload = {
  algorithm,      // 'DeepSeekHashV1'
  challenge,      // 挑战原文
  salt,           // 20 位 hex
  signature,      // 挑战签名
  answer,         // 算出来的数字
  target_path: '/api/v0/chat/completion',
};
header = base64(JSON.stringify(payload));
```

五、错误排查
40301 INVALID_POW_RESPONSE
上游业务错误，但 HTTP 状态是 200，content-type 是 application/json 而不是 SSE。
json

复制

下载

```
{"code":40301,"msg":"INVALID_POW_RESPONSE","data":null}
```

本代理已在 upstream.js 里先判断 content-type，命中就报错而不是当成空回复。
可能原因：
oracle 不可达，pow.js 抛「oracle 不可达」——检查 adb forward --list

oracle 返回的 answer 是 -1——说明计算器没接上，检查 dsxsniff 日志

base 形态不对——看日志里「命中 base 形态」那行

用了 heuristic 模式——改用 oracle

PoW oracle 不可达
text

复制

下载

```
PoW oracle 不可达: http://127.0.0.1:17381/pow
  1) 手机连上 adb
  2) adb forward tcp:17381 tcp:17381
  3) 确认 dsxsniff 模块日志有 [POWSRV] 已启动
```

按这三步排查。USB 松动是最常见原因。
code=0 但无正文
json

复制

下载

```
{"code":0,"data":null}
```

通常是会话或风控异常，重试即可。本代理会报错并触发上层重试。
六、为什么不能纯 JS 实现
librscrypto.so 里的实现有几个反编译工具难以完全还原的细节：
Keccak 的具体 padding 方式

round_count 的实际取值

base 与 challenge 的绑定校验逻辑

即使哈希部分算对了，上游还会校验 base 是否真的由服务端下发的 salt 派生。所以最稳的路还是 oracle——让真机上的 native 代码自己算。
七、其他接法
除了 dsxsniff 模块，理论上还可以：
frida-server：用 frida 脚本加载 librscrypto.so 后反射调用

QEMU：在 Linux 虚拟机里跑该 so（需要 ARM 转译）

自建 Android 服务：写一个只做 PowCalculator 调用的小 App，暴露 HTTP

src/pow-oracle.js 提供的是最小骨架，solve() 里的 TODO 换成任意一种实现即可。