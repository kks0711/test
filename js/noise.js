"use strict";
/* 시드 기반 난수 + 2D 그라디언트 노이즈 (지형 생성용) */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 위치 기반 결정적 해시 (나무/꽃/광석 배치용) */
function hash2(x, z, seed) {
  let h = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

function makeNoise2D(seed) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const G = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;

  return function noise2(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const gBL = G[perm[perm[X] + Y] & 7];
    const gBR = G[perm[perm[X + 1] + Y] & 7];
    const gTL = G[perm[perm[X] + Y + 1] & 7];
    const gTR = G[perm[perm[X + 1] + Y + 1] & 7];
    const u = fade(xf), v = fade(yf);
    const b = lerp(gBL[0]*xf + gBL[1]*yf, gBR[0]*(xf-1) + gBR[1]*yf, u);
    const t = lerp(gTL[0]*xf + gTL[1]*(yf-1), gTR[0]*(xf-1) + gTR[1]*(yf-1), u);
    return lerp(b, t, v); // 대략 -1 ~ 1
  };
}

function fbm(noise, x, y, octaves, lacunarity, gain) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}
