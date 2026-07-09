"use strict";
/* 블럭 정의 + 절차 생성 텍스처 아틀라스 (외부 이미지 없음) */

const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, LEAF: 6, WATER: 7,
  SNOW: 8, GLASS: 9, BRICK: 10, GOLD: 11, DIAMOND: 12, RAINBOW: 13, GLOW: 14,
  PLANK: 15, COBBLE: 16, CACTUS: 17, FLOWER_R: 18, FLOWER_Y: 19, BEDROCK: 20,
  WOOL_PINK: 21, WOOL_BLUE: 22, ICE: 23,
};

/* 타일 번호 (아틀라스 16x16 타일, 타일당 16px) */
const T = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, SAND: 4, LOG_SIDE: 5, LOG_TOP: 6,
  LEAF: 7, WATER: 8, SNOW: 9, SNOW_SIDE: 10, GLASS: 11, BRICK: 12, GOLD: 13,
  DIAMOND: 14, RAINBOW: 15, GLOW: 16, PLANK: 17, COBBLE: 18, CACTUS_SIDE: 19,
  CACTUS_TOP: 20, FLOWER_R: 21, FLOWER_Y: 22, BEDROCK: 23, WOOL_PINK: 24,
  WOOL_BLUE: 25, ICE: 26,
};

/* solid: 몸이 부딪히는지 / transparent: 반투명 렌더 패스 / plant: X자 식물 / breakable: 캘 수 있는지 */
const BLOCKS = {
  [B.AIR]:      { name: "공기", solid: false, breakable: false },
  [B.GRASS]:    { name: "잔디", solid: true, breakable: true, tiles: { top: T.GRASS_TOP, side: T.GRASS_SIDE, bottom: T.DIRT }, drop: B.DIRT },
  [B.DIRT]:     { name: "흙", solid: true, breakable: true, tiles: { top: T.DIRT, side: T.DIRT, bottom: T.DIRT } },
  [B.STONE]:    { name: "돌", solid: true, breakable: true, tiles: { top: T.STONE, side: T.STONE, bottom: T.STONE } },
  [B.SAND]:     { name: "모래", solid: true, breakable: true, tiles: { top: T.SAND, side: T.SAND, bottom: T.SAND } },
  [B.LOG]:      { name: "원목", solid: true, breakable: true, tiles: { top: T.LOG_TOP, side: T.LOG_SIDE, bottom: T.LOG_TOP } },
  [B.LEAF]:     { name: "나뭇잎", solid: true, breakable: true, tiles: { top: T.LEAF, side: T.LEAF, bottom: T.LEAF } },
  [B.WATER]:    { name: "물", solid: false, breakable: false, transparent: true, tiles: { top: T.WATER, side: T.WATER, bottom: T.WATER } },
  [B.SNOW]:     { name: "눈", solid: true, breakable: true, tiles: { top: T.SNOW, side: T.SNOW_SIDE, bottom: T.DIRT } },
  [B.GLASS]:    { name: "유리", solid: true, breakable: true, transparent: true, tiles: { top: T.GLASS, side: T.GLASS, bottom: T.GLASS } },
  [B.BRICK]:    { name: "벽돌", solid: true, breakable: true, tiles: { top: T.BRICK, side: T.BRICK, bottom: T.BRICK } },
  [B.GOLD]:     { name: "금", solid: true, breakable: true, tiles: { top: T.GOLD, side: T.GOLD, bottom: T.GOLD } },
  [B.DIAMOND]:  { name: "다이아", solid: true, breakable: true, tiles: { top: T.DIAMOND, side: T.DIAMOND, bottom: T.DIAMOND } },
  [B.RAINBOW]:  { name: "무지개", solid: true, breakable: true, tiles: { top: T.RAINBOW, side: T.RAINBOW, bottom: T.RAINBOW } },
  [B.GLOW]:     { name: "반짝돌", solid: true, breakable: true, emit: 1, tiles: { top: T.GLOW, side: T.GLOW, bottom: T.GLOW } },
  [B.PLANK]:    { name: "판자", solid: true, breakable: true, tiles: { top: T.PLANK, side: T.PLANK, bottom: T.PLANK } },
  [B.COBBLE]:   { name: "조약돌", solid: true, breakable: true, tiles: { top: T.COBBLE, side: T.COBBLE, bottom: T.COBBLE } },
  [B.CACTUS]:   { name: "선인장", solid: true, breakable: true, tiles: { top: T.CACTUS_TOP, side: T.CACTUS_SIDE, bottom: T.CACTUS_TOP } },
  [B.FLOWER_R]: { name: "빨간꽃", solid: false, breakable: true, plant: true, tiles: { top: T.FLOWER_R, side: T.FLOWER_R, bottom: T.FLOWER_R } },
  [B.FLOWER_Y]: { name: "노란꽃", solid: false, breakable: true, plant: true, tiles: { top: T.FLOWER_Y, side: T.FLOWER_Y, bottom: T.FLOWER_Y } },
  [B.BEDROCK]:  { name: "기반암", solid: true, breakable: false, tiles: { top: T.BEDROCK, side: T.BEDROCK, bottom: T.BEDROCK } },
  [B.WOOL_PINK]:{ name: "분홍양털", solid: true, breakable: true, tiles: { top: T.WOOL_PINK, side: T.WOOL_PINK, bottom: T.WOOL_PINK } },
  [B.WOOL_BLUE]:{ name: "하늘양털", solid: true, breakable: true, tiles: { top: T.WOOL_BLUE, side: T.WOOL_BLUE, bottom: T.WOOL_BLUE } },
  [B.ICE]:      { name: "얼음", solid: true, breakable: true, transparent: true, tiles: { top: T.ICE, side: T.ICE, bottom: T.ICE } },
};

function isOpaque(id) {
  const b = BLOCKS[id];
  return !!(b && b.solid && !b.transparent && !b.plant);
}

/* ===== 텍스처 아틀라스 그리기 (256x256, 16px 타일) ===== */
let ATLAS_CANVAS = null;

function buildAtlas() {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 256;
  const c = cv.getContext("2d");
  const rand = mulberry32(1234);

  function T2XY(t) { return [(t % 16) * 16, Math.floor(t / 16) * 16]; }
  function fill(t, color) {
    const [ox, oy] = T2XY(t);
    c.fillStyle = color; c.fillRect(ox, oy, 16, 16);
  }
  function px(t, x, y, color) {
    const [ox, oy] = T2XY(t);
    c.fillStyle = color; c.fillRect(ox + x, oy + y, 1, 1);
  }
  function speckle(t, colors, n) {
    for (let i = 0; i < n; i++) {
      px(t, Math.floor(rand() * 16), Math.floor(rand() * 16), colors[Math.floor(rand() * colors.length)]);
    }
  }
  function clearTile(t) {
    const [ox, oy] = T2XY(t);
    c.clearRect(ox, oy, 16, 16);
  }

  // 잔디 윗면
  fill(T.GRASS_TOP, "#5cb843");
  speckle(T.GRASS_TOP, ["#6cc953", "#4ea338", "#79d660", "#54ad3d"], 90);
  // 잔디 옆면 (흙 + 위 잔디띠)
  fill(T.GRASS_SIDE, "#8a6a45");
  speckle(T.GRASS_SIDE, ["#7a5c3a", "#977450", "#6f5334"], 60);
  c.fillStyle = "#5cb843";
  { const [ox, oy] = T2XY(T.GRASS_SIDE); c.fillRect(ox, oy, 16, 3); }
  for (let i = 0; i < 16; i += 2) px(T.GRASS_SIDE, i, 3, "#5cb843");
  // 흙
  fill(T.DIRT, "#8a6a45");
  speckle(T.DIRT, ["#7a5c3a", "#977450", "#6f5334", "#9a7a55"], 90);
  // 돌
  fill(T.STONE, "#8f8f8f");
  speckle(T.STONE, ["#7d7d7d", "#a0a0a0", "#868686", "#999999"], 90);
  // 모래
  fill(T.SAND, "#e8d9a0");
  speckle(T.SAND, ["#dbca8c", "#f2e5b4", "#d1bf82"], 90);
  // 원목 옆면
  fill(T.LOG_SIDE, "#7a5a33");
  for (let x = 1; x < 16; x += 4) {
    for (let y = 0; y < 16; y++) px(T.LOG_SIDE, x, y, "#654a29");
  }
  speckle(T.LOG_SIDE, ["#6b4f2c", "#87653c"], 40);
  // 원목 윗면 (나이테)
  fill(T.LOG_TOP, "#a37e4c");
  { const [ox, oy] = T2XY(T.LOG_TOP);
    c.strokeStyle = "#7a5a33";
    for (let r = 2; r <= 7; r += 2.4) {
      c.beginPath(); c.arc(ox + 8, oy + 8, r, 0, Math.PI * 2); c.stroke();
    } }
  // 나뭇잎
  fill(T.LEAF, "#3e9432");
  speckle(T.LEAF, ["#337d29", "#4aa93c", "#2c6d23", "#57bd48"], 110);
  // 물 (반투명)
  clearTile(T.WATER);
  { const [ox, oy] = T2XY(T.WATER);
    c.fillStyle = "rgba(52,110,220,0.72)"; c.fillRect(ox, oy, 16, 16);
    c.fillStyle = "rgba(120,170,255,0.5)";
    for (let i = 0; i < 8; i++) c.fillRect(ox + Math.floor(rand()*13), oy + Math.floor(rand()*15), 3, 1);
  }
  // 눈
  fill(T.SNOW, "#f4fbff");
  speckle(T.SNOW, ["#e2eef7", "#ffffff", "#d8e8f4"], 60);
  fill(T.SNOW_SIDE, "#8a6a45");
  speckle(T.SNOW_SIDE, ["#7a5c3a", "#977450"], 50);
  { const [ox, oy] = T2XY(T.SNOW_SIDE); c.fillStyle = "#f4fbff"; c.fillRect(ox, oy, 16, 4); }
  // 유리
  clearTile(T.GLASS);
  { const [ox, oy] = T2XY(T.GLASS);
    c.fillStyle = "rgba(200,235,255,0.28)"; c.fillRect(ox, oy, 16, 16);
    c.strokeStyle = "rgba(255,255,255,0.9)"; c.strokeRect(ox + 0.5, oy + 0.5, 15, 15);
    c.fillStyle = "rgba(255,255,255,0.75)";
    c.fillRect(ox + 2, oy + 5, 1, 4); c.fillRect(ox + 3, oy + 3, 1, 3);
    c.fillRect(ox + 11, oy + 9, 1, 4); c.fillRect(ox + 12, oy + 8, 1, 3);
  }
  // 벽돌
  fill(T.BRICK, "#b8503f");
  { const [ox, oy] = T2XY(T.BRICK);
    c.fillStyle = "#d9d3c8";
    for (let y = 0; y < 16; y += 4) c.fillRect(ox, oy + y, 16, 1);
    for (let y = 0; y < 16; y += 8) { c.fillRect(ox + 8, oy + y, 1, 4); c.fillRect(ox, oy + y + 4, 1, 4); c.fillRect(ox + 4, oy + y + 4, 1, 4); c.fillRect(ox + 12, oy + y + 4, 1, 4); }
  }
  speckle(T.BRICK, ["#a8462f", "#c75c48"], 40);
  // 금
  fill(T.GOLD, "#f2c33c");
  speckle(T.GOLD, ["#ffd95e", "#dba725", "#fff0a0"], 70);
  { const [ox, oy] = T2XY(T.GOLD);
    c.fillStyle = "#fffbe0";
    c.fillRect(ox + 3, oy + 3, 2, 2); c.fillRect(ox + 11, oy + 9, 2, 2);
    c.strokeStyle = "#c9971a"; c.strokeRect(ox + 0.5, oy + 0.5, 15, 15);
  }
  // 다이아
  fill(T.DIAMOND, "#5fe3d7");
  speckle(T.DIAMOND, ["#8ff2e8", "#3fc8bb", "#c8fff8"], 70);
  { const [ox, oy] = T2XY(T.DIAMOND);
    c.fillStyle = "#ffffff";
    c.fillRect(ox + 4, oy + 4, 2, 2); c.fillRect(ox + 10, oy + 10, 2, 2); c.fillRect(ox + 11, oy + 3, 1, 1);
    c.strokeStyle = "#2fa89c"; c.strokeRect(ox + 0.5, oy + 0.5, 15, 15);
  }
  // 무지개
  { const [ox, oy] = T2XY(T.RAINBOW);
    const cols = ["#ff5f5f", "#ff9d4d", "#ffe14d", "#5fd463", "#4da3ff", "#7d6bff", "#c76bff", "#ff7dc7"];
    for (let y = 0; y < 16; y += 2) { c.fillStyle = cols[(y / 2) % 8]; c.fillRect(ox, oy + y, 16, 2); }
  }
  // 반짝돌 (발광)
  fill(T.GLOW, "#ffd24d");
  { const [ox, oy] = T2XY(T.GLOW);
    c.fillStyle = "#fff3b0"; c.fillRect(ox + 3, oy + 3, 10, 10);
    c.fillStyle = "#ffffff"; c.fillRect(ox + 6, oy + 6, 4, 4);
    c.fillStyle = "#e8a923";
    c.fillRect(ox, oy, 2, 2); c.fillRect(ox + 14, oy, 2, 2); c.fillRect(ox, oy + 14, 2, 2); c.fillRect(ox + 14, oy + 14, 2, 2);
  }
  // 판자
  fill(T.PLANK, "#b08a4f");
  { const [ox, oy] = T2XY(T.PLANK);
    c.fillStyle = "#96703c";
    for (let y = 3; y < 16; y += 4) c.fillRect(ox, oy + y, 16, 1);
  }
  speckle(T.PLANK, ["#a37e45", "#bd965a"], 50);
  // 조약돌
  fill(T.COBBLE, "#9a9a9a");
  { const [ox, oy] = T2XY(T.COBBLE);
    c.fillStyle = "#828282";
    c.fillRect(ox + 1, oy + 1, 5, 4); c.fillRect(ox + 8, oy + 2, 6, 5);
    c.fillRect(ox + 2, oy + 8, 6, 5); c.fillRect(ox + 10, oy + 9, 5, 5);
    c.fillStyle = "#b0b0b0";
    c.fillRect(ox + 2, oy + 2, 3, 2); c.fillRect(ox + 9, oy + 3, 4, 3); c.fillRect(ox + 3, oy + 9, 4, 3);
  }
  // 선인장
  fill(T.CACTUS_SIDE, "#3d8f3d");
  { const [ox, oy] = T2XY(T.CACTUS_SIDE);
    c.fillStyle = "#2e7030";
    for (let x = 2; x < 16; x += 5) c.fillRect(ox + x, oy, 1, 16);
    c.fillStyle = "#5cb85c"; c.fillRect(ox, oy, 1, 16); c.fillRect(ox + 15, oy, 1, 16);
  }
  fill(T.CACTUS_TOP, "#4a9e4a");
  { const [ox, oy] = T2XY(T.CACTUS_TOP);
    c.fillStyle = "#2e7030"; c.fillRect(ox + 7, oy + 2, 2, 12); c.fillRect(ox + 2, oy + 7, 12, 2);
  }
  // 꽃 (투명 배경 + 십자 식물)
  function flower(t, petal, center) {
    clearTile(t);
    const [ox, oy] = T2XY(t);
    c.fillStyle = "#3e9432"; // 줄기
    c.fillRect(ox + 7, oy + 8, 2, 8);
    c.fillRect(ox + 5, oy + 11, 2, 1); c.fillRect(ox + 9, oy + 12, 2, 1);
    c.fillStyle = petal;
    c.fillRect(ox + 5, oy + 3, 6, 6);
    c.fillRect(ox + 4, oy + 4, 8, 4); c.fillRect(ox + 6, oy + 2, 4, 8);
    c.fillStyle = center; c.fillRect(ox + 7, oy + 5, 2, 2);
  }
  flower(T.FLOWER_R, "#ff5f5f", "#ffe14d");
  flower(T.FLOWER_Y, "#ffd24d", "#ff9d4d");
  // 기반암
  fill(T.BEDROCK, "#3a3a3a");
  speckle(T.BEDROCK, ["#2a2a2a", "#4d4d4d", "#565656"], 100);
  // 양털
  fill(T.WOOL_PINK, "#f2a7c3");
  speckle(T.WOOL_PINK, ["#e795b3", "#fcbbd3", "#ec9fbc"], 80);
  fill(T.WOOL_BLUE, "#7fb8f0");
  speckle(T.WOOL_BLUE, ["#6da7e0", "#93c7fa", "#78b0e8"], 80);
  // 얼음
  clearTile(T.ICE);
  { const [ox, oy] = T2XY(T.ICE);
    c.fillStyle = "rgba(165,215,255,0.85)"; c.fillRect(ox, oy, 16, 16);
    c.fillStyle = "rgba(255,255,255,0.7)";
    c.fillRect(ox + 3, oy + 2, 1, 5); c.fillRect(ox + 4, oy + 6, 1, 3);
    c.fillRect(ox + 10, oy + 8, 1, 5); c.fillRect(ox + 11, oy + 6, 1, 3);
  }

  ATLAS_CANVAS = cv;
  return cv;
}

/* 아틀라스에서 블럭 아이콘 그리기 (인벤토리/핫바용 미니 입체 블럭) */
function drawBlockIcon(ctx2d, id, x, y, size) {
  const b = BLOCKS[id];
  if (!b || !b.tiles) return;
  const s = size;
  if (b.plant) {
    const [tx, ty] = [(b.tiles.side % 16) * 16, Math.floor(b.tiles.side / 16) * 16];
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.drawImage(ATLAS_CANVAS, tx, ty, 16, 16, x, y, s, s);
    return;
  }
  ctx2d.imageSmoothingEnabled = false;
  const topT = b.tiles.top, sideT = b.tiles.side;
  const [tx, ty] = [(topT % 16) * 16, Math.floor(topT / 16) * 16];
  const [sx, sy] = [(sideT % 16) * 16, Math.floor(sideT / 16) * 16];
  const hw = s / 2, hh = s / 4;
  // 윗면 (마름모)
  ctx2d.save();
  ctx2d.translate(x + hw, y + hh);
  ctx2d.transform(1, 0.5, -1, 0.5, 0, 0);
  ctx2d.drawImage(ATLAS_CANVAS, tx, ty, 16, 16, -hw / 1.42, -hw / 1.42, s / 1.42, s / 1.42);
  ctx2d.restore();
  // 왼쪽 면
  ctx2d.save();
  ctx2d.translate(x, y + hh);
  ctx2d.transform(1, 0.5, 0, 1, 0, 0);
  ctx2d.drawImage(ATLAS_CANVAS, sx, sy, 16, 16, 0, 0, hw, s * 0.55);
  ctx2d.restore();
  // 오른쪽 면 (조금 어둡게)
  ctx2d.save();
  ctx2d.translate(x + hw, y + hh + hw / 2);
  ctx2d.transform(1, -0.5, 0, 1, 0, 0);
  ctx2d.drawImage(ATLAS_CANVAS, sx, sy, 16, 16, 0, 0, hw, s * 0.55);
  ctx2d.globalAlpha = 0.25; ctx2d.fillStyle = "#000";
  ctx2d.fillRect(0, 0, hw, s * 0.55);
  ctx2d.restore();
  ctx2d.globalAlpha = 1;
}
