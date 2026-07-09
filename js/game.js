"use strict";
/* 게임 엔진 통합: 상태 관리, 입력, 메인 루프, 채굴/건축, 미션, 저장 */

const SAVE_KEY = "bible-block-kingdom-3d-v1";

/* ===== 미션 ===== */
const MISSIONS = [
  { id: "m1",  emoji: "⛏️", name: "첫 채굴!",       desc: "아무 블럭이나 1개 캐기",        stat: "mined",        goal: 1,   reward: 10 },
  { id: "m2",  emoji: "🌳", name: "나무꾼",         desc: "원목 10개 캐기",               stat: "minedLog",     goal: 10,  reward: 20 },
  { id: "m3",  emoji: "🏠", name: "꼬마 건축가",     desc: "블럭 20개 놓기",               stat: "placed",       goal: 20,  reward: 20 },
  { id: "m4",  emoji: "📖", name: "퀴즈 새싹",       desc: "퀴즈 3문제 정답",              stat: "quizCorrect",  goal: 3,   reward: 15 },
  { id: "m5",  emoji: "🪨", name: "열심 광부",       desc: "돌 30개 캐기",                 stat: "minedStone",   goal: 30,  reward: 25 },
  { id: "m6",  emoji: "🎓", name: "성경 박사",       desc: "퀴즈 10문제 정답",             stat: "quizCorrect",  goal: 10,  reward: 30 },
  { id: "m7",  emoji: "💎", name: "보물 사냥꾼",     desc: "금이나 다이아 광석 캐기",       stat: "minedTreasure", goal: 1,  reward: 40 },
  { id: "m8",  emoji: "🃏", name: "말씀 수집가",     desc: "말씀 카드 5장 모으기",          stat: "cards",        goal: 5,   reward: 30 },
  { id: "m9",  emoji: "🏰", name: "열심 건축가",     desc: "블럭 100개 놓기",              stat: "placed",       goal: 100, reward: 50 },
  { id: "m10", emoji: "👑", name: "퀴즈 왕",         desc: "퀴즈 30문제 정답",             stat: "quizCorrect",  goal: 30,  reward: 100 },
  { id: "m11", emoji: "🕊️", name: "하늘을 나는 꿈", desc: "날개를 얻고 하늘 날기",         stat: "flew",         goal: 1,   reward: 50 },
  { id: "m12", emoji: "🌟", name: "대건축가",        desc: "블럭 300개 놓기",              stat: "placed",       goal: 300, reward: 150 },
];

function missionValue(m) {
  if (m.stat === "cards") return state.cards.length;
  return state.stats[m.stat] || 0;
}

/* ===== 상태 ===== */
let state = null;

function defaultState() {
  return {
    seed: Math.floor(Math.random() * 1e9),
    coins: 40,
    inv: { [B.DIRT]: 10, [B.PLANK]: 10 },
    hotbar: [B.DIRT, B.PLANK, B.LOG, B.COBBLE, B.GLASS, B.BRICK, B.GLOW, B.WOOL_PINK, B.RAINBOW],
    sel: 0,
    edits: {},                     // "x,y,z" -> 블럭 id (직접 바꾼 블럭만 저장)
    stats: {},                     // 미션용 카운터
    missionsDone: [],
    cards: [],                     // 모은 말씀 카드 인덱스
    perks: {},                     // wings / jump / speed
    quiz: { solved: {}, streak: 0, correct: 0 },
    settings: { sound: true, dayCycle: true, renderDist: 5, sensitivity: 5 },
    timeOfDay: 0.22,
    lastDaily: "",
    helpSeen: false,
    pos: null,
  };
}

function saveGame() {
  try {
    if (Game.player) {
      state.pos = {
        x: Game.player.pos.x, y: Game.player.pos.y, z: Game.player.pos.z,
        yaw: Game.player.yaw, pitch: Game.player.pitch, fly: Game.player.fly,
      };
    }
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (e) { /* 저장 불가 환경 무시 */ }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || typeof data.seed !== "number") return false;
    state = Object.assign(defaultState(), data);
    state.settings = Object.assign(defaultState().settings, data.settings || {});
    return true;
  } catch (e) { return false; }
}

/* ===== 경제 / 미션 ===== */
function addCoins(n) {
  state.coins += n;
  UI.updateCoins();
  if (n > 0) UI.flyCoin(`+${n} 🪙`);
}

function spendCoins(n) {
  if (state.coins < n) { UI.toast("코인이 부족해요! 퀴즈를 풀어 보세요 📖"); return false; }
  state.coins -= n;
  UI.updateCoins();
  return true;
}

function bumpStat(key, n = 1) {
  state.stats[key] = (state.stats[key] || 0) + n;
  checkMissions();
}

function checkMissions() {
  for (const m of MISSIONS) {
    if (state.missionsDone.includes(m.id)) continue;
    if (missionValue(m) >= m.goal) {
      state.missionsDone.push(m.id);
      addCoins(m.reward);
      UI.sfx.mission();
      UI.toast(`🏆 미션 완수! [${m.name}] +${m.reward}코인`, true);
    }
  }
  UI.updateMissionTracker();
}

function applyPerks() {
  const p = Game.player;
  if (!p) return;
  p.canFly = !!state.perks.wings;
  p.jumpMul = state.perks.jump ? 1.5 : 1;
  p.speedMul = state.perks.speed ? 1.4 : 1;
  document.getElementById("flyBtn").classList.toggle("hidden", !p.canFly);
}

/* ===== 게임 본체 ===== */
const Game = {
  world: null, player: null, renderer: null,
  ready: false,
  keys: new Set(),
  dirtyChunks: new Set(),
  buildQueue: [],
  builtChunks: new Set(),
  touch: { fwd: 0, strafe: 0, jump: false, down: false },
  isTouchDevice: "ontouchstart" in window,
  lastSave: 0,

  chunkKey(cx, cz) { return cx + "," + cz; },

  markDirty(x, z) {
    const C = this.world.CHUNK;
    const cx = Math.floor(x / C), cz = Math.floor(z / C);
    this.dirtyChunks.add(this.chunkKey(cx, cz));
    // 청크 경계면이면 이웃도
    const lx = x - cx * C, lz = z - cz * C;
    if (lx === 0) this.dirtyChunks.add(this.chunkKey(cx - 1, cz));
    if (lx === C - 1) this.dirtyChunks.add(this.chunkKey(cx + 1, cz));
    if (lz === 0) this.dirtyChunks.add(this.chunkKey(cx, cz - 1));
    if (lz === C - 1) this.dirtyChunks.add(this.chunkKey(cx, cz + 1));
  },

  setBlock(x, y, z, id) {
    this.world.set(x, y, z, id);
    state.edits[`${x},${y},${z}`] = id;
    this.markDirty(x, z);
  },

  /* 조준한 블럭 찾기 */
  target() {
    const p = this.player;
    const eye = p.eye();
    const f = p.forward();
    return raycastBlock(this.world, eye[0], eye[1], eye[2], f[0], f[1], f[2], 6);
  },

  breakTarget() {
    const hit = this.target();
    if (!hit) return false;
    const def = BLOCKS[hit.id];
    if (!def || !def.breakable) {
      UI.toast("이 블럭은 부술 수 없어요!");
      return false;
    }
    const drop = def.drop || hit.id;
    state.inv[drop] = (state.inv[drop] || 0) + 1;
    this.setBlock(hit.x, hit.y, hit.z, B.AIR);
    UI.sfx.dig();
    bumpStat("mined");
    if (hit.id === B.LOG) bumpStat("minedLog");
    if (hit.id === B.STONE) bumpStat("minedStone");
    if (hit.id === B.GOLD || hit.id === B.DIAMOND) {
      bumpStat("minedTreasure");
      UI.toast(`💎 와! ${def.name} 광석을 캤어요!`, true);
    }
    UI.renderHotbar();
    return true;
  },

  placeTarget() {
    const hit = this.target();
    if (!hit) return false;
    const id = state.hotbar[state.sel];
    if (!id || !BLOCKS[id]) { UI.toast("가방(E)에서 블럭을 골라 핫바에 넣어 보세요!"); return false; }
    if ((state.inv[id] || 0) <= 0) {
      UI.toast(`${BLOCKS[id].name} 블럭이 없어요! 캐거나 상점에서 사요 🛒`);
      return false;
    }
    // 식물을 조준했으면 그 자리에, 아니면 조준면 옆칸에
    let bx, by, bz;
    if (BLOCKS[hit.id].plant) { bx = hit.x; by = hit.y; bz = hit.z; }
    else { bx = hit.x + hit.nx; by = hit.y + hit.ny; bz = hit.z + hit.nz; }

    if (by < 1 || by >= this.world.SY) return false;
    if (!this.world.inBounds(bx, by, bz)) return false;
    const cur = this.world.get(bx, by, bz);
    if (cur !== B.AIR && cur !== B.WATER && !BLOCKS[cur].plant) return false;
    if (BLOCKS[id].solid && this.player.intersectsBlock(bx, by, bz)) {
      UI.toast("너무 가까워요! 한 걸음 뒤로 🚶");
      return false;
    }
    state.inv[id]--;
    this.setBlock(bx, by, bz, id);
    UI.sfx.place();
    bumpStat("placed");
    UI.renderHotbar();
    return true;
  },

  toggleFly() {
    const p = this.player;
    if (!p.canFly) { UI.toast("상점에서 🕊️ 천사 날개를 사면 날 수 있어요!"); return; }
    p.fly = !p.fly;
    if (p.fly) {
      p.vel.y = 0;
      bumpStat("flew");
      UI.toast("🕊️ 날기 시작! (스페이스=위로, Shift=아래로)");
    } else {
      UI.toast("착지 준비~!");
    }
    document.getElementById("flyBtn").classList.toggle("on", p.fly);
    document.getElementById("btnUpT").classList.toggle("hidden", !p.fly);
    document.getElementById("btnDownT").classList.toggle("hidden", !p.fly);
  },

  hardReset() {
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  },

  /* ===== 입력 ===== */
  bindInput() {
    const canvas = this.renderer.canvas;

    // 포인터 락 (데스크톱)
    canvas.addEventListener("click", () => {
      if (!UI.anyModalOpen() && !this.isTouchDevice && !document.pointerLockElement) {
        canvas.requestPointerLock();
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (!document.pointerLockElement || UI.anyModalOpen()) return;
      const sens = 0.0016 * (0.5 + state.settings.sensitivity * 0.14);
      this.player.yaw += e.movementX * sens;
      this.player.pitch -= e.movementY * sens;
      this.player.pitch = Math.max(-1.55, Math.min(1.55, this.player.pitch));
    });

    canvas.addEventListener("mousedown", (e) => {
      if (!document.pointerLockElement || UI.anyModalOpen()) return;
      if (e.button === 0) this.breakTarget();
      else if (e.button === 2) this.placeTarget();
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("wheel", (e) => {
      if (UI.anyModalOpen()) return;
      state.sel = ((state.sel + (e.deltaY > 0 ? 1 : -1)) % 9 + 9) % 9;
      UI.renderHotbar();
    }, { passive: true });

    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      // 숫자키 핫바
      if (!UI.anyModalOpen() && k >= "1" && k <= "9") {
        state.sel = Number(k) - 1;
        UI.renderHotbar();
        return;
      }
      // 메뉴 토글
      const menuKeys = { e: "btnInv", q: "btnQuiz", b: "btnShop", m: "btnMissions", k: "btnCards", h: "btnHelp" };
      if (menuKeys[k]) {
        if (UI.anyModalOpen()) UI.closeAll();
        else document.getElementById(menuKeys[k]).click();
        e.preventDefault();
        return;
      }
      if (UI.anyModalOpen()) return;
      if (k === "f") { this.toggleFly(); return; }
      this.keys.add(k);
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());

    if (this.isTouchDevice) this.bindTouch();

    window.addEventListener("beforeunload", () => saveGame());
    document.addEventListener("visibilitychange", () => { if (document.hidden) saveGame(); });
  },

  bindTouch() {
    document.getElementById("touchUI").classList.remove("hidden");
    document.getElementById("lockHint").classList.add("hidden");
    const joy = document.getElementById("joy");
    const stick = document.getElementById("joyStick");
    let joyId = null, joyCX = 0, joyCY = 0;

    joy.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      joyId = t.identifier;
      const r = joy.getBoundingClientRect();
      joyCX = r.left + r.width / 2; joyCY = r.top + r.height / 2;
      e.preventDefault();
    }, { passive: false });
    joy.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joyId) continue;
        let dx = (t.clientX - joyCX) / 45, dy = (t.clientY - joyCY) / 45;
        const len = Math.hypot(dx, dy);
        if (len > 1) { dx /= len; dy /= len; }
        this.touch.strafe = dx;
        this.touch.fwd = -dy;
        stick.style.transform = `translate(calc(-50% + ${dx * 34}px), calc(-50% + ${dy * 34}px))`;
      }
      e.preventDefault();
    }, { passive: false });
    const joyEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joyId) continue;
        joyId = null;
        this.touch.fwd = 0; this.touch.strafe = 0;
        stick.style.transform = "translate(-50%,-50%)";
      }
    };
    joy.addEventListener("touchend", joyEnd);
    joy.addEventListener("touchcancel", joyEnd);

    // 화면 드래그로 시점 회전
    const canvas = this.renderer.canvas;
    let lookId = null, lastX = 0, lastY = 0;
    canvas.addEventListener("touchstart", (e) => {
      for (const t of e.changedTouches) {
        if (lookId === null) { lookId = t.identifier; lastX = t.clientX; lastY = t.clientY; }
      }
    }, { passive: true });
    canvas.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookId) continue;
        const sens = 0.005 * (0.5 + state.settings.sensitivity * 0.14);
        this.player.yaw += (t.clientX - lastX) * sens;
        this.player.pitch -= (t.clientY - lastY) * sens;
        this.player.pitch = Math.max(-1.55, Math.min(1.55, this.player.pitch));
        lastX = t.clientX; lastY = t.clientY;
      }
      e.preventDefault();
    }, { passive: false });
    const lookEnd = (e) => {
      for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null;
    };
    canvas.addEventListener("touchend", lookEnd);
    canvas.addEventListener("touchcancel", lookEnd);

    // 버튼
    const hold = (id, on, off) => {
      const el = document.getElementById(id);
      el.addEventListener("touchstart", (e) => { on(); e.preventDefault(); }, { passive: false });
      el.addEventListener("touchend", (e) => { if (off) off(); e.preventDefault(); }, { passive: false });
    };
    hold("btnJumpT", () => (this.touch.jump = true), () => (this.touch.jump = false));
    hold("btnUpT", () => (this.touch.jump = true), () => (this.touch.jump = false));
    hold("btnDownT", () => (this.touch.down = true), () => (this.touch.down = false));
    hold("btnBreakT", () => this.breakTarget());
    hold("btnPlaceT", () => this.placeTarget());
  },

  gatherInput() {
    const k = this.keys;
    let fwd = 0, strafe = 0;
    if (k.has("w") || k.has("arrowup")) fwd += 1;
    if (k.has("s") || k.has("arrowdown")) fwd -= 1;
    if (k.has("d") || k.has("arrowright")) strafe += 1;
    if (k.has("a") || k.has("arrowleft")) strafe -= 1;
    fwd += this.touch.fwd; strafe += this.touch.strafe;
    return {
      fwd: Math.max(-1, Math.min(1, fwd)),
      strafe: Math.max(-1, Math.min(1, strafe)),
      jump: k.has(" ") || this.touch.jump,
      down: k.has("shift") || this.touch.down,
    };
  },

  /* ===== 청크 관리 ===== */
  ensureChunks() {
    const C = this.world.CHUNK;
    const RD = state.settings.renderDist;
    const pcx = Math.floor(this.player.pos.x / C);
    const pcz = Math.floor(this.player.pos.z / C);
    const maxC = Math.ceil(this.world.SX / C);
    const visible = [];

    for (let cx = pcx - RD; cx <= pcx + RD; cx++) {
      for (let cz = pcz - RD; cz <= pcz + RD; cz++) {
        if (cx < 0 || cz < 0 || cx >= maxC || cz >= maxC) continue;
        const ddx = cx - pcx, ddz = cz - pcz;
        const dist = Math.sqrt(ddx * ddx + ddz * ddz);
        if (dist > RD + 0.5) continue;
        const key = this.chunkKey(cx, cz);
        visible.push({ key, cx, cz, dist });
        if (!this.builtChunks.has(key) && !this.buildQueue.some((q) => q.key === key)) {
          this.buildQueue.push({ key, cx, cz, dist });
        }
      }
    }
    // 가까운 것부터 빌드 (프레임당 2개)
    this.buildQueue.sort((a, b) => a.dist - b.dist);
    let built = 0;
    while (this.buildQueue.length && built < 2) {
      const q = this.buildQueue.shift();
      this.renderer.setChunk(q.key, buildChunkGeometry(this.world, q.cx, q.cz));
      this.builtChunks.add(q.key);
      built++;
    }
    // 편집된 청크 다시 메시 (프레임당 3개)
    let remeshed = 0;
    for (const key of this.dirtyChunks) {
      if (remeshed >= 3) break;
      const [cx, cz] = key.split(",").map(Number);
      if (cx < 0 || cz < 0 || cx >= maxC || cz >= maxC) { this.dirtyChunks.delete(key); continue; }
      this.renderer.setChunk(key, buildChunkGeometry(this.world, cx, cz));
      this.builtChunks.add(key);
      this.dirtyChunks.delete(key);
      remeshed++;
    }
    return visible;
  },

  /* ===== 하늘 / 시간 ===== */
  skyState(dt) {
    if (state.settings.dayCycle && !UI.anyModalOpen()) {
      state.timeOfDay = (state.timeOfDay + dt / 480) % 1; // 8분 주기
    }
    const tod = state.settings.dayCycle ? state.timeOfDay : 0.22;
    const raw = Math.sin(tod * Math.PI * 2); // >0 낮, <0 밤
    const dayF = Math.max(0, Math.min(1, raw * 2 + 0.5));
    const duskF = Math.max(0, 1 - Math.abs(raw) * 3) * 0.65;
    const day = [0.49, 0.75, 0.94], night = [0.03, 0.05, 0.13], dusk = [0.96, 0.58, 0.36];
    const sky = [0, 1, 2].map((i) => {
      let c = night[i] + (day[i] - night[i]) * dayF;
      return c + (dusk[i] - c) * duskF;
    });
    const sun = Math.max(0.3, Math.min(1, 0.3 + dayF * 0.7));
    return { sky, sun };
  },

  /* ===== 초기화 & 루프 ===== */
  async init() {
    const bar = document.getElementById("loadBar");
    const tip = document.getElementById("loadTip");
    tip.textContent = GAME_TIPS[Math.floor(Math.random() * GAME_TIPS.length)];
    const step = (p) => { bar.style.width = p + "%"; return new Promise((r) => setTimeout(r, 30)); };

    if (!loadGame()) state = defaultState();
    await step(8);

    buildAtlas();
    await step(15);

    this.world = new World(state.seed);
    this.world.generate();
    await step(55);

    // 저장된 편집 적용
    for (const key in state.edits) {
      const [x, y, z] = key.split(",").map(Number);
      this.world.set(x, y, z, state.edits[key]);
    }
    await step(65);

    this.renderer = new Renderer(document.getElementById("glcanvas"), ATLAS_CANVAS);
    this.player = new Player(this.world);

    if (state.pos) {
      this.player.pos = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
      this.player.yaw = state.pos.yaw; this.player.pitch = state.pos.pitch;
      this.player.fly = !!state.pos.fly && !!state.perks.wings;
    } else {
      const s = this.world.findSpawn();
      this.player.pos = { x: s.x, y: s.y, z: s.z };
    }
    applyPerks();
    document.getElementById("flyBtn").classList.toggle("on", this.player.fly);

    // 스폰 주변 청크 미리 빌드
    const C = this.world.CHUNK;
    const pcx = Math.floor(this.player.pos.x / C), pcz = Math.floor(this.player.pos.z / C);
    const maxC = Math.ceil(this.world.SX / C);
    for (let cx = pcx - 2; cx <= pcx + 2; cx++) {
      for (let cz = pcz - 2; cz <= pcz + 2; cz++) {
        if (cx < 0 || cz < 0 || cx >= maxC || cz >= maxC) continue;
        const key = this.chunkKey(cx, cz);
        this.renderer.setChunk(key, buildChunkGeometry(this.world, cx, cz));
        this.builtChunks.add(key);
      }
    }
    await step(92);

    UI.init();
    UI.updateCoins();
    UI.renderHotbar();
    UI.updateMissionTracker();
    this.bindInput();
    await step(100);

    document.getElementById("loading").remove();

    // 출석 보상
    const today = new Date().toISOString().slice(0, 10);
    if (state.lastDaily !== today) {
      state.lastDaily = today;
      if (state.helpSeen) { // 첫날은 환영 모달로 대체
        addCoins(20);
        UI.toast("🎁 오늘의 출석 선물 +20코인! 내일 또 만나요", true);
      }
    }
    if (!state.helpSeen) UI.showWelcome();
    else UI.showWelcome(); // 매일 오늘의 말씀 보여주기

    saveGame();
    this.ready = true;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  },

  loop(now) {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const paused = UI.anyModalOpen();
    if (!paused) {
      this.player.update(dt, this.gatherInput());
    }

    const visible = this.ensureChunks();
    const { sky, sun } = this.skyState(dt);
    const RD = state.settings.renderDist * 16;

    const hit = paused ? null : this.target();

    // 청크 좌표 → 월드 중심 거리로 정렬용 dist 재계산
    const eye = this.player.eye();
    for (const v of visible) {
      const wx = v.cx * 16 + 8, wz = v.cz * 16 + 8;
      v.dist = Math.hypot(wx - eye[0], wz - eye[2]);
    }

    this.renderer.draw(eye, this.player.yaw, this.player.pitch, {
      skyColor: sky,
      sun,
      fogStart: RD * 0.55,
      fogEnd: RD * 0.98,
      visibleChunks: visible,
      highlight: hit ? { x: hit.x, y: hit.y, z: hit.z } : null,
    });

    // HUD 상태
    document.getElementById("underwater").classList.toggle("hidden", !this.player.eyeInWater());
    document.getElementById("lockHint").classList.toggle(
      "hidden",
      this.isTouchDevice || paused || !!document.pointerLockElement
    );

    // 자동 저장 (8초마다)
    if (now - this.lastSave > 8000) {
      this.lastSave = now;
      saveGame();
    }

    requestAnimationFrame((t) => this.loop(t));
  },
};

window.addEventListener("DOMContentLoaded", () => {
  Game.init().catch((err) => {
    console.error(err);
    const tip = document.getElementById("loadTip");
    if (tip) tip.textContent = "앗! 게임을 시작할 수 없어요: " + err.message;
  });
});

/* 테스트/디버깅용 전역 노출 */
window.G = {
  get state() { return state; },
  Game, addCoins, spendCoins, bumpStat, saveGame,
};
