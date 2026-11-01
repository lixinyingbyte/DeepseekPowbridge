import { keccak256, sha3_256 } from './keccak.mjs';

const BASE = '4ea0ae923a0a9debbdf6_1792823072798_';
const CHALLENGE = '2bb4344c814b59056b7381be6f0d482e29395bccd14881598c7207c109db7fd2';
const SALT = '';  // 未知，先空着
const DIFFICULTY = 144000n;
const EXPECTED = 112283;

// 排列：决定输入字符串怎么拼
const arrangements = [
  ['base+challenge+i', (b, c, i) => b + c + i],
  ['challenge+base+i', (b, c, i) => c + b + i],
  ['base+i+challenge', (b, c, i) => b + i + c],
  ['challenge+i+base', (b, c, i) => c + i + b],
  ['i+base+challenge', (b, c, i) => i + b + c],
  ['base+i', (b, c, i) => b + i],
  ['challenge+i', (b, c, i) => c + i],
  ['i+challenge', (b, c, i) => i + c],
  ['i+base', (b, c, i) => i + b],
  ['base+challenge', (b, c, i) => b + c + i],  // i 当 uint32 二进制？先试十进制
];

// 判据：决定什么叫「满足难度」
const conditions = [
  ['uint64BE(hash) <= diff', (h) => h.readBigUInt64BE(0) <= DIFFICULTY],
  ['uint64LE(hash) <= diff', (h) => h.readBigUInt64LE(0) <= DIFFICULTY],
  ['uint32BE(hash) <= diff', (h) => BigInt(h.readUInt32BE(0)) <= DIFFICULTY],
  ['uint32LE(hash) <= diff', (h) => BigInt(h.readUInt32LE(0)) <= DIFFICULTY],
  ['hex[:16] int <= diff', (h) => BigInt('0x' + h.toString('hex').slice(0, 16)) <= DIFFICULTY],
  ['hex[:8] int <= diff', (h) => BigInt('0x' + h.toString('hex').slice(0, 8)) <= DIFFICULTY],
  ['last8hex <= diff', (h) => BigInt('0x' + h.toString('hex').slice(-8)) <= DIFFICULTY],
  ['leading zeros >= 18 bits', (h) => {
    let n = 0;
    for (let i = 0; i < h.length; i++) {
      if (h[i] === 0) { n += 8; continue; }
      for (let b = 7; b >= 0; b--) { if ((h[i] >> b) & 1) return n >= 18; n++; }
    }
    return n >= 18;
  }],
  ['leading zeros >= 17 bits', (h) => {
    let n = 0;
    for (let i = 0; i < h.length; i++) {
      if (h[i] === 0) { n += 8; continue; }
      for (let b = 7; b >= 0; b--) { if ((h[i] >> b) & 1) return n >= 17; n++; }
    }
    return n >= 17;
  }],
];

const LIMIT = 500000;
let hits = 0;

for (const hasher of [['keccak', keccak256], ['sha3', sha3_256]]) {
  for (const [aName, aFn] of arrangements) {
    for (const [cName, cFn] of conditions) {
      for (let i = 0; i < LIMIT; i++) {
        const s = aFn(BASE, CHALLENGE, String(i));
        const h = hasher[1](s);
        if (cFn(h)) {
          if (i === EXPECTED) {
            console.log(`★★★ 完全正确: ${hasher[0]} | ${aName} | ${cName} -> ${i}`);
          } else {
            console.log(`  命中但不同: ${hasher[0]} | ${aName} | ${cName} -> ${i} (期望 ${EXPECTED})`);
          }
          hits++;
          break;
        }
      }
    }
  }
}

console.log(`\n搜索完成，共 ${hits} 个组合命中，期望答案是 ${EXPECTED}`);
