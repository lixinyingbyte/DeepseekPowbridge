import http from 'node:http';

/**
 * PoW Oracle —— 可选的「算力外挂」。
 *
 * 背景：手机方案之所以能算 PoW，是因为模块跑在 DeepSeek 进程里，直接反射
 * 调用客户端已加载的 librscrypto.so。电脑上没有这个 so，纯 JS 复现算法
 * 不保证命中。最稳的做法是让一台已 root、能跑该 so 的设备当计算器：
 *
 *   电脑 (pc-demo) --HTTP--> 本 oracle 服务 --> 你的真机/模拟器 (调 native)
 *
 * 本文件提供一个**最小骨架**：POST /pow {base, challenge, difficulty} -> {answer}。
 * 把 handle() 里 TODO 换成真正的 native 调用（例如通过 adb shell / frida /
 * 自建 Android 小程序暴露 HTTP）即可。
 *
 * 启动：node src/pow-oracle.js --port 17381
 */

const port = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : 17381);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 真正的求解入口。
 * @param {{base:string, challenge:string, difficulty:number}} q
 * @returns {Promise<number>} answer，失败返回 -1
 */
async function solve(q) {
  // TODO: 接上真实计算器。典型做法三选一：
  //   1) adb 转发：真机上跑一个只做 PowCalculator 调用的 Android 服务，
  //      用 adb forward tcp:17382 tcp:17382 映射到本机再 fetch。
  //   2) frida-server：用 frida 脚本加载 librscrypto.so 后调用 native 方法。
  //   3) 如果你已经逆向出算法：在这里用 node:crypto 实现并返回。
  //
  // 骨架默认返回 -1（表示「本 oracle 还没接计算器」），调用方会报错提示。
  void q;
  return -1;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/pow') {
    try {
      const q = JSON.parse(await readBody(req));
      if (!q || typeof q.challenge !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
        return;
      }
      const answer = await solve(q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log('[ORACLE] 监听 http://127.0.0.1:' + port + '/pow（等待接入真实计算器）');
});
