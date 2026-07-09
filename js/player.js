"use strict";
/* 1인칭 플레이어: 이동/중력/충돌/수영/날기 */

class Player {
  constructor(world) {
    this.world = world;
    this.pos = { x: 0, y: 40, z: 0 };   // 발 위치
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = -0.15;
    this.onGround = false;
    this.fly = false;
    this.canFly = false;    // 날개(상점)로 잠금해제
    this.speedMul = 1;      // 빠른 신발 능력
    this.jumpMul = 1;       // 점프 부스트 능력
    this.HALF = 0.3;
    this.HEIGHT = 1.8;
    this.EYE = 1.62;
  }

  eye() { return [this.pos.x, this.pos.y + this.EYE, this.pos.z]; }

  forward() {
    return [
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      -Math.cos(this.pitch) * Math.cos(this.yaw),
    ];
  }

  collides(px, py, pz) {
    const w = this.world, H = this.HALF;
    const x0 = Math.floor(px - H), x1 = Math.floor(px + H);
    const y0 = Math.floor(py), y1 = Math.floor(py + this.HEIGHT);
    const z0 = Math.floor(pz - H), z1 = Math.floor(pz + H);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const b = BLOCKS[w.get(x, y, z)];
          if (b && b.solid) return true;
        }
    return false;
  }

  /* 블럭 (bx,by,bz)에 블럭을 놓으면 몸과 겹치는지 */
  intersectsBlock(bx, by, bz) {
    const H = this.HALF;
    return (
      bx + 1 > this.pos.x - H && bx < this.pos.x + H &&
      by + 1 > this.pos.y && by < this.pos.y + this.HEIGHT &&
      bz + 1 > this.pos.z - H && bz < this.pos.z + H
    );
  }

  inWater() {
    const w = this.world;
    return w.get(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z)) === B.WATER;
  }
  eyeInWater() {
    const w = this.world;
    return w.get(Math.floor(this.pos.x), Math.floor(this.pos.y + this.EYE), Math.floor(this.pos.z)) === B.WATER;
  }

  moveAxis(axis, delta) {
    if (delta === 0) return;
    const step = 0.05 * Math.sign(delta);
    let remaining = delta;
    while (Math.abs(remaining) > 1e-9) {
      const d = Math.abs(remaining) > 0.05 ? step : remaining;
      const np = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
      np[axis] += d;
      if (this.collides(np.x, np.y, np.z)) {
        if (axis === "y") {
          if (delta < 0) this.onGround = true;
          this.vel.y = 0;
        } else {
          this.vel[axis] = 0;
        }
        return;
      }
      this.pos = np;
      remaining -= d;
    }
  }

  update(dt, input) {
    dt = Math.min(dt, 0.05);
    const water = this.inWater();
    const speed = (this.fly ? 9.5 : water ? 3 : 4.4) * this.speedMul;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let mx = input.fwd * sin + input.strafe * cos;
    let mz = input.fwd * -cos + input.strafe * sin;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) { mx /= mlen; mz /= mlen; }
    this.vel.x = mx * speed;
    this.vel.z = mz * speed;

    if (this.fly) {
      this.vel.y = (input.jump ? 9 : 0) + (input.down ? -9 : 0);
    } else if (water) {
      this.vel.y -= 5 * dt;
      this.vel.y = Math.max(this.vel.y, -2.5);
      if (input.jump) this.vel.y = 3.6;
    } else {
      this.vel.y -= 25 * dt;
      this.vel.y = Math.max(this.vel.y, -40);
      if (input.jump && this.onGround) this.vel.y = 8.4 * this.jumpMul;
    }

    this.onGround = false;
    this.moveAxis("y", this.vel.y * dt);
    this.moveAxis("x", this.vel.x * dt);
    this.moveAxis("z", this.vel.z * dt);

    // 월드 밖으로 못 나가게
    const w = this.world;
    this.pos.x = Math.max(1, Math.min(w.SX - 1, this.pos.x));
    this.pos.z = Math.max(1, Math.min(w.SZ - 1, this.pos.z));
    if (this.pos.y < -8) { // 혹시 떨어지면 스폰으로
      const s = w.findSpawn();
      this.pos = { x: s.x, y: s.y + 1, z: s.z };
      this.vel = { x: 0, y: 0, z: 0 };
    }
    if (this.pos.y > w.SY + 20) this.pos.y = w.SY + 20;
  }
}

/* 복셀 레이캐스트 (Amanatides & Woo) — 조준한 블럭 찾기 */
function raycastBlock(world, ox, oy, oz, dx, dy, dz, maxDist) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? x + 1 - ox : ox - x) * tDX) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? y + 1 - oy : oy - y) * tDY) : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? z + 1 - oz : oz - z) * tDZ) : Infinity;
  let nx = 0, ny = 0, nz = 0, t = 0;

  for (let i = 0; i < 256; i++) {
    const id = world.get(x, y, z);
    if (id !== B.AIR && id !== B.WATER) {
      return { x, y, z, id, nx, ny, nz };
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDX; nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDY; nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDZ; nx = 0; ny = 0; nz = -stepZ;
    }
    if (t > maxDist) return null;
  }
  return null;
}
