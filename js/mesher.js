"use strict";
/* 청크(16x64x16) → WebGL 정점 배열 생성
   정점 형식: x,y,z, u,v, shade, emit (7 float) */

const FACES = [
  { dir: [0, 1, 0],  corners: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], shade: 1.0,  tile: "top",    uvTop: true },
  { dir: [0, -1, 0], corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], shade: 0.55, tile: "bottom", uvTop: true },
  { dir: [1, 0, 0],  corners: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]], shade: 0.68, tile: "side" },
  { dir: [-1, 0, 0], corners: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]], shade: 0.68, tile: "side" },
  { dir: [0, 0, 1],  corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], shade: 0.82, tile: "side" },
  { dir: [0, 0, -1], corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], shade: 0.82, tile: "side" },
];
/* 옆면 UV: 아래쪽 모서리 2개(v=1) → 위쪽 모서리 2개(v=0) 순서 */
const SIDE_UV = [[0, 1], [1, 1], [1, 0], [0, 0]];
const TOP_UV  = [[0, 0], [1, 0], [1, 1], [0, 1]];

const TILE_UV_SIZE = 1 / 16;
const TILE_INSET = 0.02; // 텍스처 번짐 방지용 안쪽 여백

function tileUV(t, uu, vv) {
  const u0 = (t % 16) / 16, v0 = Math.floor(t / 16) / 16;
  return [
    u0 + (TILE_INSET + uu * (1 - 2 * TILE_INSET)) * TILE_UV_SIZE,
    v0 + (TILE_INSET + vv * (1 - 2 * TILE_INSET)) * TILE_UV_SIZE,
  ];
}

function buildChunkGeometry(world, cx, cz) {
  const opq = [];  // 불투명
  const tra = [];  // 반투명(물/유리/얼음/식물)
  const x0 = cx * world.CHUNK, z0 = cz * world.CHUNK;
  const x1 = Math.min(x0 + world.CHUNK, world.SX);
  const z1 = Math.min(z0 + world.CHUNK, world.SZ);

  function pushQuad(arr, corners, bx, by, bz, tile, shade, emit, uvMap) {
    const vs = [];
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      const [u, v] = tileUV(tile, uvMap[i][0], uvMap[i][1]);
      vs.push([bx + c[0], by + c[1], bz + c[2], u, v, shade, emit]);
    }
    // 삼각형 2개: 0-1-2, 0-2-3
    arr.push(...vs[0], ...vs[1], ...vs[2], ...vs[0], ...vs[2], ...vs[3]);
  }

  for (let x = x0; x < x1; x++) {
    for (let z = z0; z < z1; z++) {
      for (let y = 0; y < world.SY; y++) {
        const id = world.blocks[world.idx(x, y, z)];
        if (id === B.AIR) continue;
        const def = BLOCKS[id];
        const emit = def.emit || 0;

        if (def.plant) {
          // X자 십자 식물
          const t = def.tiles.side;
          pushQuad(tra, [[0.15,0,0.15],[0.85,0,0.85],[0.85,1,0.85],[0.15,1,0.15]], x, y, z, t, 1.0, emit, SIDE_UV);
          pushQuad(tra, [[0.85,0,0.15],[0.15,0,0.85],[0.15,1,0.85],[0.85,1,0.15]], x, y, z, t, 1.0, emit, SIDE_UV);
          continue;
        }

        const transparent = !!def.transparent;
        const target = transparent ? tra : opq;

        for (const f of FACES) {
          const nx = x + f.dir[0], ny = y + f.dir[1], nz = z + f.dir[2];
          const nid = world.get(nx, ny, nz);
          let visible;
          if (transparent) {
            // 물/유리끼리 맞닿은 면은 그리지 않음, 불투명 블럭에 가린 면도 생략
            visible = nid !== id && !isOpaque(nid);
          } else {
            visible = !isOpaque(nid);
          }
          if (!visible) continue;
          const tile = def.tiles[f.tile];
          pushQuad(target, f.corners, x, y, z, tile, f.shade, emit, f.uvTop ? TOP_UV : SIDE_UV);
        }
      }
    }
  }

  return {
    opq: new Float32Array(opq),
    tra: new Float32Array(tra),
  };
}
