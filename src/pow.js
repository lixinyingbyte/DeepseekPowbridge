import crypto from 'node:crypto';
import { tag } from './log.js';
import { httpRequest } from './http.js';

/**
 * PoW（工作量证明）求解器。
 *
 * 依据 PoW说明.md 的实测结论：
 *   base = {20位随机hex}_{时间戳}_
 *   第一段是客户端本地随机值（不是服务端 salt）
 *   第二段必须是 challenge.expire_at（用当前时间 native 返回 -1）
 *
 * 三种模式：
 *   oracle    —— 外部「计算器」HTTP 服务（唯一可靠，推荐）
 *   manual    —— 配置里直接放一个抓包得到的 x-ds-pow-response（一次性，会过期）
 *   heuristic —— 纯 JS 猜算法。**实测不可用**，默认禁用。
 */
export class Pow {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.goodTimestamp = null;   // 'expire' | 'now'
    this._oracleAlive = null;
    this._oracleCheckedAt = 0;
  }

  /**
   * 申请挑战。
   *
   * 路径有两个说法：
   *   Upstream.java（实际跑通的代码）：/api/v0/chat/create_pow_challenge
   *   PoW说明.md（笔记）：/api/v0/create_pow_challenge
   * 以代码为准，同时对 404 做一次回退。
   */
  async createChallenge(token) {
    const paths = this.cfg.challengePath
      ? [this.cfg.challengePath]
      : ['/api/v0/chat/create_pow_challenge', '/api/v0/create_pow_challenge'];

    let lastErr = null;
    for (const p of paths) {
      try {
        const resp = await httpRequest(this.cfg.baseUrl + p, {
          method: 'POST',
          headers: this.headers(token, 'application/json'),
          body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
          timeoutMs: 20000,
        });
        const text = await resp.text();
        if (resp.status === 404 && paths.length > 1) {
          lastErr = new Error(p + ' -> 404');
          tag('POW', p + ' 不存在，尝试下一个路径');
          continue;
        }
        if (!resp.ok) {
          throw new Error('create_pow_challenge HTTP ' + resp.status + ': ' + text.slice(0, 300));
        }
        let data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error('挑战 JSON 解析失败: ' + text.slice(0, 200)); }
        const ch = findChallenge(data);
        if (!ch) throw new Error('挑战结构里没有 challenge 字段: ' + text.slice(0, 300));
        tag('POW', '挑战来源 ' + p);
        return ch;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('申请 PoW 挑战失败');
  }

  /** 算出可直接放进 x-ds-pow-response 的 base64。 */
  async makeHeader(token) {
    let mode = this.cfg.mode || 'oracle';

    if (mode === 'manual') {
      const h = (this.cfg.manualHeader || '').trim();
      if (!h) throw new Error('pow.mode=manual 但 pow.manualHeader 为空');
      tag('POW', '使用配置里的手工 pow 头（一次性，失效后请改 oracle）');
      return h;
    }

    if (mode === 'oracle' && !(await this.oracleAlive())) {
      if (this.cfg.allowUnsafe) {
        tag('POW', 'oracle 不可达（' + this.cfg.oracleUrl + '），降级到 heuristic（实验性）');
        mode = 'heuristic';
      } else {
        throw new Error('PoW oracle 不可达: ' + (this.cfg.oracleUrl || '(未配置)')
          + '\n  1) 手机连上 adb\n  2) adb forward tcp:17381 tcp:17381\n'
          + '  3) 确认 dsxsniff 模块日志有 [POWSRV] 已启动');
      }
    }

    const ch = await this.createChallenge(token);
    const challenge = ch.challenge || '';
    const salt = ch.salt || '';
    const signature = ch.signature || '';
    const algorithm = ch.algorithm || 'DeepSeekHashV1';
    const difficulty = Number(ch.difficulty || 144000);
    const expireAt = Number(ch.expire_at || 0);
    tag('POW', 'challenge salt=' + salt.slice(0, 12) + ' difficulty=' + difficulty
      + ' expire_at=' + expireAt + ' algo=' + algorithm + ' mode=' + mode);

    let lastErr = null;
    for (const kind of this.candidateOrder(salt)) {
      const base = buildBase(kind, expireAt, salt, challenge);
      try {
        const answer = mode === 'oracle'
          ? await this.solveViaOracle(base, challenge, difficulty)
          : this.solveHeuristic(base, challenge, difficulty);
        if (answer >= 0) {
          this.goodTimestamp = kind;
          tag('POW', '命中 base 形态 ' + kind + ' base=[' + base + '] answer=' + answer);
          return encodeHeader({ algorithm, challenge, salt, signature, answer });
        }
      } catch (e) {
        lastErr = e;
        tag('POW', '候选 ' + kind + ' 失败: ' + e.message);
      }
    }
    throw new Error('PoW 求解失败（mode=' + mode + '）'
      + (lastErr ? '：' + lastErr.message : '，所有 base 形态都未命中'));
  }

  /**
   * 候选顺序：命中过的形态排第一。
   *
   * 形态来自手机端 Pow.java 实测的候选列表：
   *   salt_expire  salt + "_" + expireAt + "_"   ← 手机端注释「实测命中这个」
   *   salt_now     salt + "_" + now + "_"
   *   salt         salt
   *   rand_expire  20位随机hex + "_" + expireAt + "_"
   *   rand_now     20位随机hex + "_" + now + "_"
   *   challenge    challenge 原文
   *
   * 只试随机 hex 不够：native 会校验 base 与 challenge 的绑定关系，
   * 以 salt 开头的形态才是客户端真实做法。
   */
  candidateOrder(salt) {
    const all = [];
    if (salt && salt.length > 0) {
      all.push('salt_expire', 'salt_now', 'salt');
    }
    all.push('rand_expire', 'rand_now', 'challenge');
    if (!this.goodTimestamp) return all;
    return [this.goodTimestamp].concat(all.filter((k) => k !== this.goodTimestamp));
  }

  /** 探测 oracle 是否可达，2 秒缓存避免每轮都探。 */
  async oracleAlive() {
    const url = this.cfg.oracleUrl;
    if (!url) return false;
    const now = Date.now();
    if (this._oracleCheckedAt && now - this._oracleCheckedAt < 2000) {
      return this._oracleAlive === true;
    }
    this._oracleCheckedAt = now;
    try {
      const u = new URL(url);
      const net = await import('node:net');
      const port = Number(u.port || 80);
      this._oracleAlive = await new Promise((resolve) => {
        const s = net.connect({ host: u.hostname, port, timeout: 800 });
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('timeout', () => { s.destroy(); resolve(false); });
        s.once('error', () => resolve(false));
      });
    } catch (e) {
      this._oracleAlive = false;
    }
    return this._oracleAlive === true;
  }

  async solveViaOracle(base, challenge, difficulty) {
    const url = this.cfg.oracleUrl;
    if (!url) throw new Error('pow.mode=oracle 但 pow.oracleUrl 为空');
    const resp = await httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, challenge, difficulty }),
      timeoutMs: this.cfg.timeoutMs || 60000,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error('oracle HTTP ' + resp.status + ': ' + text.slice(0, 300));
    const o = JSON.parse(text);
    const ans = Number(o.answer);
    if (!Number.isFinite(ans)) throw new Error('oracle 返回没有 answer 字段: ' + text.slice(0, 200));
    return ans;
  }

  /**
   * 启发式求解 —— **实测不可用**。
   *
   * 曾经「命中」过一个 answer，但上游直接回 40301 INVALID_POW_RESPONSE。
   * 说明「哈希前 8 位 ≤ difficulty」这个判据是错的：真实判定在 native 里，
   * 而且服务端还会校验 base 与 challenge 的绑定关系。
   *
   * 默认直接失败并提示改用 oracle，避免静默给出错误答案浪费请求。
   * 需要实验时把 pow.allowUnsafe 设为 true。
   */
  solveHeuristic(base, challenge, difficulty) {
    if (!this.cfg.allowUnsafe) {
      tag('POW', 'heuristic 已禁用：实测其答案会被上游拒绝（40301 INVALID_POW_RESPONSE）');
      tag('POW', '正确做法：pow.mode=oracle，接真机上的 PowServer');
      return -1;
    }

    const algos = ['sha3-256', 'shake256', 'sha256'];
    const patterns = [
      ['b+c+n', (b, c, n) => b + c + n],
      ['b+n+c', (b, c, n) => b + n + c],
      ['c+b+n', (b, c, n) => c + b + n],
      ['b+c', (b, c) => b + c],
    ];

    for (const algo of algos) {
      for (const [patName, mix] of patterns) {
        for (let n = 0; n < 200000; n++) {
          const seed = mix(base, challenge, n);
          const hex = hashHex(algo, seed);
          if (!hex) continue;
          const v = parseInt(hex.slice(0, 8), 16);
          if (v <= difficulty) {
            tag('POW', 'heuristic 假命中 algo=' + algo + ' pat=' + patName + ' answer=' + n);
            return n;
          }
        }
      }
    }
    tag('POW', 'heuristic 未命中');
    return -1;
  }

  headers(token, contentType) {
    const h = {
      'Authorization': 'Bearer ' + token.bearer,
      'x-client-platform': 'android',
      'x-client-version': this.cfg.clientVersion || '2.6.1',
      'x-client-locale': this.cfg.locale || 'zh_CN',
      'x-client-bundle-id': this.cfg.bundleId || 'com.deepseek.chat',
      'x-client-timezone-offset': String(this.cfg.timezoneOffset || 28800),
      'x-device-model': this.cfg.deviceModel || 'PC',
      'x-device-id': token.deviceId,
      'User-Agent': 'DeepSeek/' + (this.cfg.clientVersion || '2.6.1') + ' Android/PC',
      'Accept': 'application/json',
      'Accept-Charset': 'UTF-8',
    };
    if (token.rangersId) h['x-rangers-id'] = token.rangersId;
    if (contentType) h['Content-Type'] = contentType;
    return h;
  }
}

function buildBase(kind, expireAt, salt, challenge) {
  const now = Date.now();
  const ts = expireAt > 0 ? expireAt : now;
  switch (kind) {
    case 'salt_expire': return salt + '_' + ts + '_';
    case 'salt_now': return salt + '_' + now + '_';
    case 'salt': return salt;
    case 'rand_expire': return randomHex(20) + '_' + ts + '_';
    case 'rand_now': return randomHex(20) + '_' + now + '_';
    case 'challenge': return challenge || '';
    default: return randomHex(20) + '_' + ts + '_';
  }
}

function encodeHeader(o) {
  const payload = {
    algorithm: o.algorithm,
    challenge: o.challenge,
    salt: o.salt,
    signature: o.signature,
    answer: o.answer,
    target_path: '/api/v0/chat/completion',
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function findChallenge(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.challenge && typeof o.challenge === 'object' && o.challenge.challenge) return o.challenge;
  if (typeof o.challenge === 'string' && o.challenge.length > 0) return o;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object') {
      const r = findChallenge(v);
      if (r) return r;
    }
  }
  return null;
}

function hashHex(algo, s) {
  try {
    if (algo === 'shake256') {
      return crypto.createHash('shake256', { outputLength: 32 }).update(s, 'utf8').digest('hex');
    }
    return crypto.createHash(algo).update(s, 'utf8').digest('hex');
  } catch (e) {
    return '';
  }
}

function randomHex(n) {
  const chars = '0123456789abcdef';
  const buf = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += chars[buf[i] & 0x0f];
  return out;
}
