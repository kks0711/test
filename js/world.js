"use strict";
/* 256x64x256 복셀 월드 + 절차 지형 생성 (언덕/숲/사막/설원/호수/나무/꽃/광석) */

class World {
  constructor(seed) {
    this.seed = seed;
    this.SX = 256; this.SY = 64; this.SZ = 256;
    this.SEA = 26;
    this.CHUNK = 16;
    this.blocks = new Uint8Array(this.SX * this.SY * this.SZ);
    this.heights = new Int16Array(this.SX * this.SZ); // 지표 높이 캐시
  }

  idx(x, y, z) { return ((x * this.SZ) + z) * this.SY + y; }

  inBounds(x, y, z) {
    return x >= 0 && z >= 0 && y >= 0 && x < this.SX && z < this.SZ && y < this.SY;
  }

  get(x, y, z) {
    if (y < 0) return B.BEDROCK;
    if (y >= this.SY) return B.AIR;
    if (x < 0 || z < 0 || x >= this.SX || z >= this.SZ) return B.AIR;
    return this.blocks[this.idx(x, y, z)];
  }

  set(x, y, z, id) {
    if (!this.inBounds(x, y, z)) return;
    this.blocks[this.idx(x, y, z)] = id;
  }

  /* 해당 기둥에서 가장 높은 단단한 블럭의 y (없으면 0) */
  surfaceY(x, z) {
    for (let y = this.SY - 1; y >= 0; y--) {
      const id = this.get(x, y, z);
      if (id !== B.AIR && BLOCKS[id].solid) return y;
    }
    return 0;
  }

  generate(onProgress) {
    const n1 = makeNoise2D(this.seed);        // 기본 언덕
    const n2 = makeNoise2D(this.seed + 101);  // 큰 산맥
    const nT = makeNoise2D(this.seed + 202);  // 온도 (설원/사막)
    const nM = makeNoise2D(this.seed + 303);  // 습도 (숲)

    const SX = this.SX, SY = this.SY, SZ = this.SZ, SEA = this.SEA;

    for (let x = 0; x < SX; x++) {
      for (let z = 0; z < SZ; z++) {
        const hill = fbm(n1, x * 0.014, z * 0.014, 4, 2, 0.5) * 10;
        const mount = Math.max(0, fbm(n2, x * 0.006, z * 0.006, 3, 2, 0.5)) * 22;
        let h = Math.floor(28 + hill + mount);
        h = Math.max(6, Math.min(SY - 10, h));
        this.heights[x * SZ + z] = h;

        const temp = fbm(nT, x * 0.005, z * 0.005, 2, 2, 0.5);   // -1(춥다) ~ 1(덥다)
        const moist = fbm(nM, x * 0.008, z * 0.008, 2, 2, 0.5);
        const isSnow = temp < -0.28;
        const isDesert = temp > 0.34 && moist < 0.1;

        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = B.BEDROCK;
          else if (y < h - 3) {
            id = B.STONE;
            // 광석: 돌 속에 금/다이아
            const r = hash2(x * 3 + y * 7, z * 5 + y, this.seed);
            if (y < 24 && r < 0.006) id = B.GOLD;
            else if (y < 18 && r > 0.9965) id = B.DIAMOND;
          }
          else if (y < h) id = isDesert ? B.SAND : B.DIRT;
          else { // 지표
            if (h < SEA + 1) id = B.SAND;            // 물가/물속 바닥
            else if (isDesert) id = B.SAND;
            else if (isSnow) id = B.SNOW;
            else id = B.GRASS;
          }
          this.blocks[this.idx(x, y, z)] = id;
        }
        // 물 채우기
        if (h < SEA) {
          for (let y = h + 1; y <= SEA; y++) this.blocks[this.idx(x, y, z)] = B.WATER;
          if (isSnow) this.blocks[this.idx(x, SEA, z)] = B.ICE; // 설원 호수는 얼음
        }
      }
      if (onProgress && x % 32 === 0) onProgress(x / SX);
    }

    // 나무 / 선인장 / 꽃 심기
    for (let x = 2; x < SX - 2; x++) {
      for (let z = 2; z < SZ - 2; z++) {
        const h = this.heights[x * SZ + z];
        if (h <= SEA) continue;
        const top = this.get(x, h, z);
        const r = hash2(x, z, this.seed + 7);

        if (top === B.GRASS || top === B.SNOW) {
          const moist = fbm(nM, x * 0.008, z * 0.008, 2, 2, 0.5);
          const treeChance = moist > 0.15 ? 0.022 : 0.006; // 습한 곳 = 숲
          if (r < treeChance && h < SY - 9) this.plantTree(x, h + 1, z);
          else if (top === B.GRASS && r > 0.975) {
            this.set(x, h + 1, z, r > 0.988 ? B.FLOWER_Y : B.FLOWER_R);
          }
        } else if (top === B.SAND && h > SEA + 1) {
          if (r < 0.004 && h < SY - 5) {
            const ch = 2 + Math.floor(hash2(x, z, 99) * 2);
            for (let i = 1; i <= ch; i++) this.set(x, h + i, z, B.CACTUS);
          }
        }
      }
    }
  }

  plantTree(x, y, z) {
    const th = 4 + Math.floor(hash2(x, z, 31) * 2); // 줄기 4~5
    for (let i = 0; i < th; i++) this.set(x, y + i, z, B.LOG);
    const ty = y + th; // 잎 중심
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -2; dy <= 1; dy++) {
          const dist = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 1.5;
          if (dist > 3.6) continue;
          const bx = x + dx, by = ty + dy, bz = z + dz;
          if (this.get(bx, by, bz) === B.AIR) this.set(bx, by, bz, B.LEAF);
        }
      }
    }
    this.set(x, ty + 1, z, B.LEAF);
  }

  /* 스폰 지점: 중앙 근처에서 물 위가 아닌 곳 */
  findSpawn() {
    const cx = this.SX >> 1, cz = this.SZ >> 1;
    for (let r = 0; r < 60; r++) {
      for (let a = 0; a < 8; a++) {
        const x = cx + Math.round(Math.cos(a * 0.785) * r * 2);
        const z = cz + Math.round(Math.sin(a * 0.785) * r * 2);
        if (x < 4 || z < 4 || x >= this.SX - 4 || z >= this.SZ - 4) continue;
        const h = this.surfaceY(x, z);
        const top = this.get(x, h, z);
        if (h > this.SEA && (top === B.GRASS || top === B.SAND || top === B.SNOW)) {
          return { x: x + 0.5, y: h + 1, z: z + 0.5 };
        }
      }
    }
    return { x: cx + 0.5, y: this.SY - 8, z: cz + 0.5 };
  }
}
