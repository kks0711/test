"use strict";
/* HUD + 모든 메뉴/모달 UI. 게임 상태(state)와 경제 함수(addCoins 등)는 game.js에 있음 */

/* ===== 상점 목록 ===== */
const SHOP_BLOCKS = [
  { id: 2,  n: 10, price: 5 },   // 흙
  { id: 4,  n: 10, price: 6 },   // 모래
  { id: 15, n: 10, price: 8 },   // 판자
  { id: 16, n: 10, price: 8 },   // 조약돌
  { id: 5,  n: 10, price: 10 },  // 원목
  { id: 6,  n: 10, price: 6 },   // 나뭇잎
  { id: 8,  n: 10, price: 10 },  // 눈
  { id: 23, n: 10, price: 12 },  // 얼음
  { id: 21, n: 10, price: 12 },  // 분홍양털
  { id: 22, n: 10, price: 12 },  // 하늘양털
  { id: 9,  n: 10, price: 15 },  // 유리
  { id: 10, n: 10, price: 15 },  // 벽돌
  { id: 14, n: 10, price: 20 },  // 반짝돌
  { id: 11, n: 5,  price: 30 },  // 금
  { id: 13, n: 10, price: 40 },  // 무지개
  { id: 12, n: 5,  price: 45 },  // 다이아
];

const SHOP_PERKS = [
  { key: "wings", name: "천사 날개", emoji: "🕊️", desc: "하늘을 날 수 있어요! (F키 / 🕊️버튼)", price: 150 },
  { key: "jump",  name: "힘찬 다리", emoji: "🦵", desc: "점프가 1.5배 높아져요", price: 60 },
  { key: "speed", name: "빠른 신발", emoji: "👟", desc: "1.4배 빨리 달려요", price: 60 },
  { key: "card",  name: "말씀 카드 뽑기", emoji: "🃏", desc: "말씀 카드 1장 랜덤!", price: 30, repeat: true },
];

const UI = (() => {

  /* ===== 효과음 (Web Audio) ===== */
  let audioCtx = null;
  function tone(freq, dur, type, vol, delay) {
    if (state && state.settings && !state.settings.sound) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t = audioCtx.currentTime + (delay || 0);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol || 0.1, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t); osc.stop(t + dur);
    } catch (e) { /* 무시 */ }
  }
  const sfx = {
    place:   () => tone(260, 0.08, "square", 0.08),
    dig:     () => tone(160, 0.1, "sawtooth", 0.08),
    buy:     () => { tone(660, 0.08, "square", 0.1); tone(880, 0.1, "square", 0.1, 0.08); },
    correct: () => { tone(523, 0.12, "square", 0.11); tone(659, 0.12, "square", 0.11, 0.1); tone(784, 0.2, "square", 0.11, 0.2); },
    wrong:   () => { tone(220, 0.2, "sawtooth", 0.09); tone(180, 0.25, "sawtooth", 0.09, 0.15); },
    bonus:   () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.14, "square", 0.11, i * 0.09)); },
    mission: () => { [392, 523, 659, 784, 1046].forEach((f, i) => tone(f, 0.13, "square", 0.11, i * 0.08)); },
    card:    () => { [880, 1108, 1318].forEach((f, i) => tone(f, 0.16, "sine", 0.12, i * 0.1)); },
    click:   () => tone(500, 0.05, "square", 0.05),
  };

  const $ = (id) => document.getElementById(id);

  /* ===== 토스트 / 코인 표시 ===== */
  function toast(msg, gold) {
    const el = document.createElement("div");
    el.className = "toast" + (gold ? " gold" : "");
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function updateCoins() {
    $("coinCount").textContent = state.coins;
    document.querySelectorAll(".shopCoinCount").forEach((e) => (e.textContent = state.coins));
    const box = $("coinBox");
    box.classList.remove("bump");
    void box.offsetWidth;
    box.classList.add("bump");
  }

  function flyCoin(text) {
    const el = document.createElement("div");
    el.className = "coin-fly";
    el.textContent = text;
    const r = $("coinBox").getBoundingClientRect();
    el.style.left = r.left + r.width / 2 - 20 + "px";
    el.style.top = r.bottom + 8 + "px";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  /* ===== 모달 관리 ===== */
  const MODALS = ["welcomeModal", "quizModal", "shopModal", "invModal", "missionsModal", "cardsModal", "settingsModal", "helpModal", "cardGetModal"];
  function anyModalOpen() {
    return MODALS.some((m) => !$(m).classList.contains("hidden"));
  }
  function closeAll() {
    MODALS.forEach((m) => $(m).classList.add("hidden"));
  }
  function open(id) {
    closeAll();
    $(id).classList.remove("hidden");
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /* ===== 핫바 / 가방 ===== */
  function renderHotbar() {
    const bar = $("hotbar");
    bar.innerHTML = "";
    state.hotbar.forEach((id, i) => {
      const slot = document.createElement("div");
      slot.className = "slot" + (state.sel === i ? " sel" : "");
      const num = document.createElement("span");
      num.className = "num"; num.textContent = i + 1;
      slot.appendChild(num);
      if (id && BLOCKS[id]) {
        const cv = document.createElement("canvas");
        cv.width = 54; cv.height = 54;
        drawBlockIcon(cv.getContext("2d"), id, 8, 8, 38);
        slot.appendChild(cv);
        const cnt = document.createElement("span");
        cnt.className = "cnt";
        cnt.textContent = state.inv[id] || 0;
        slot.appendChild(cnt);
      }
      slot.addEventListener("click", () => { state.sel = i; renderHotbar(); });
      bar.appendChild(slot);
    });
  }

  function renderInventory() {
    const grid = $("invGrid");
    grid.innerHTML = "";
    const ids = Object.keys(state.inv).map(Number).filter((id) => state.inv[id] > 0 && BLOCKS[id]);
    if (ids.length === 0) {
      grid.innerHTML = "<p class='modal-desc'>가방이 비었어요! 땅을 파거나 상점에서 블럭을 사 보세요 ⛏️</p>";
      return;
    }
    ids.sort((a, b) => a - b);
    for (const id of ids) {
      const item = document.createElement("div");
      item.className = "shop-item inv-item";
      const cv = document.createElement("canvas");
      cv.width = 48; cv.height = 48;
      drawBlockIcon(cv.getContext("2d"), id, 6, 6, 34);
      item.appendChild(cv);
      const nm = document.createElement("div");
      nm.className = "s-name"; nm.textContent = BLOCKS[id].name;
      item.appendChild(nm);
      const ct = document.createElement("div");
      ct.className = "i-cnt"; ct.textContent = state.inv[id] + "개";
      item.appendChild(ct);
      item.addEventListener("click", () => {
        state.hotbar[state.sel] = id;
        sfx.click();
        renderHotbar();
        toast(`${BLOCKS[id].name} 블럭을 ${state.sel + 1}번 칸에 넣었어요!`);
        saveGame();
      });
      grid.appendChild(item);
    }
  }

  /* ===== 상점 ===== */
  function renderShop() {
    updateCoins();
    const bg = $("shopBlocks");
    bg.innerHTML = "";
    for (const s of SHOP_BLOCKS) {
      const item = document.createElement("div");
      item.className = "shop-item";
      const cv = document.createElement("canvas");
      cv.width = 48; cv.height = 48;
      drawBlockIcon(cv.getContext("2d"), s.id, 6, 6, 34);
      item.appendChild(cv);
      const nm = document.createElement("div");
      nm.className = "s-name"; nm.textContent = BLOCKS[s.id].name;
      item.appendChild(nm);
      const dc = document.createElement("div");
      dc.className = "s-desc"; dc.textContent = `가진 개수: ${state.inv[s.id] || 0}`;
      item.appendChild(dc);
      const buy = document.createElement("button");
      buy.className = "buy-btn";
      buy.textContent = `${s.n}개 🪙${s.price}`;
      buy.disabled = state.coins < s.price;
      buy.addEventListener("click", () => {
        if (!spendCoins(s.price)) return;
        state.inv[s.id] = (state.inv[s.id] || 0) + s.n;
        sfx.buy();
        toast(`${BLOCKS[s.id].name} ${s.n}개를 샀어요!`, true);
        renderShop(); renderHotbar(); saveGame();
      });
      item.appendChild(buy);
      bg.appendChild(item);
    }

    const pg = $("shopPerks");
    pg.innerHTML = "";
    for (const p of SHOP_PERKS) {
      const item = document.createElement("div");
      item.className = "shop-item";
      const em = document.createElement("div");
      em.className = "s-emoji"; em.textContent = p.emoji;
      item.appendChild(em);
      const nm = document.createElement("div");
      nm.className = "s-name"; nm.textContent = p.name;
      item.appendChild(nm);
      const dc = document.createElement("div");
      dc.className = "s-desc"; dc.textContent = p.desc;
      item.appendChild(dc);
      const owned = !p.repeat && state.perks[p.key];
      if (owned) {
        const ob = document.createElement("span");
        ob.className = "owned-badge"; ob.textContent = "✅ 보유";
        item.appendChild(ob);
      } else {
        const buy = document.createElement("button");
        buy.className = "buy-btn";
        buy.textContent = `🪙${p.price}`;
        buy.disabled = state.coins < p.price;
        buy.addEventListener("click", () => {
          if (!spendCoins(p.price)) return;
          sfx.buy();
          if (p.key === "card") {
            grantRandomCard();
          } else {
            state.perks[p.key] = true;
            applyPerks();
            toast(`${p.emoji} ${p.name}을(를) 얻었어요!`, true);
            if (p.key === "wings") {
              bumpStat("flew", 0); // 미션 갱신 트리거
              $("flyBtn").classList.remove("hidden");
              toast("F키 또는 🕊️ 버튼으로 날아 보세요!");
            }
          }
          renderShop(); saveGame();
        });
        item.appendChild(buy);
      }
      pg.appendChild(item);
    }
  }

  /* ===== 퀴즈 ===== */
  let curCat = -1;
  let curQuiz = null;
  let answered = false;
  let hintUsed = false;

  function renderQuizCats() {
    $("quizCatsView").classList.remove("hidden");
    $("quizPlayView").classList.add("hidden");
    const box = $("quizCats");
    box.innerHTML = "";

    const rnd = document.createElement("button");
    rnd.className = "cat-btn random";
    rnd.innerHTML = `🎲 아무거나!<span class="cat-sub">모든 주제에서 랜덤 출제</span>`;
    rnd.addEventListener("click", () => startQuiz(-1));
    box.appendChild(rnd);

    QUIZ_CATEGORIES.forEach((cat, i) => {
      const solved = (state.quiz.solved[i] || []).length;
      const btn = document.createElement("button");
      btn.className = "cat-btn";
      btn.innerHTML = `${cat.emoji} ${cat.name}<span class="cat-sub">${solved}/${cat.questions.length} 문제 정답</span>`;
      btn.addEventListener("click", () => startQuiz(i));
      box.appendChild(btn);
    });
  }

  function startQuiz(catIdx) {
    curCat = catIdx;
    $("quizCatsView").classList.add("hidden");
    $("quizPlayView").classList.remove("hidden");
    nextQuestion();
  }

  function pickQuestion() {
    const catIdx = curCat >= 0 ? curCat : Math.floor(Math.random() * QUIZ_CATEGORIES.length);
    const cat = QUIZ_CATEGORIES[catIdx];
    const solved = state.quiz.solved[catIdx] || [];
    // 아직 안 맞힌 문제 우선, 다 맞혔으면 전체에서 랜덤
    let pool = cat.questions.map((_, i) => i).filter((i) => !solved.includes(i));
    if (pool.length === 0) pool = cat.questions.map((_, i) => i);
    const qi = pool[Math.floor(Math.random() * pool.length)];
    return { catIdx, qi, q: cat.questions[qi] };
  }

  function nextQuestion() {
    curQuiz = pickQuestion();
    answered = false;
    hintUsed = false;
    const { q, catIdx } = curQuiz;
    const cat = QUIZ_CATEGORIES[catIdx];

    $("quizTag").textContent = `${cat.emoji} ${cat.name}`;
    $("quizDiff").textContent = "⭐".repeat(q.d) + `  (🪙${QUIZ_REWARD[q.d]})`;
    $("quizQ").textContent = q.q;
    $("quizFb").textContent = "";
    $("quizVerse").textContent = "";
    $("quizStreak").textContent = state.quiz.streak >= 2 ? `🔥 ${state.quiz.streak}문제 연속 정답 중!` : "";
    $("btnNextQ").classList.add("hidden");
    $("btnHint").disabled = state.coins < 5;

    const box = $("quizA");
    box.innerHTML = "";
    const order = q.a.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const labels = ["①", "②", "③", "④"];
    order.forEach((ai, pos) => {
      const btn = document.createElement("button");
      btn.className = "answer-btn";
      btn.dataset.ai = ai;
      btn.textContent = `${labels[pos]} ${q.a[ai]}`;
      btn.addEventListener("click", () => answer(btn, ai));
      box.appendChild(btn);
    });
  }

  function useHint() {
    if (answered || hintUsed) return;
    if (!spendCoins(5)) { toast("코인이 5개 필요해요!"); return; }
    hintUsed = true;
    $("btnHint").disabled = true;
    // 오답 2개 흐리게 + 비활성화
    const wrong = [...$("quizA").children].filter((b) => Number(b.dataset.ai) !== 0);
    for (let i = wrong.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [wrong[i], wrong[j]] = [wrong[j], wrong[i]];
    }
    wrong.slice(0, 2).forEach((b) => { b.classList.add("dim"); b.disabled = true; });
    sfx.click();
    toast("🙏 기도 찬스! 보기 2개가 사라졌어요");
    saveGame();
  }

  function answer(btn, ai) {
    if (answered) return;
    answered = true;
    const { q, catIdx, qi } = curQuiz;
    const correct = ai === 0; // 데이터에서 첫 번째 보기가 정답
    const btns = [...$("quizA").children];
    btns.forEach((b) => (b.disabled = true));
    btns.forEach((b) => { if (Number(b.dataset.ai) === 0) b.classList.add("correct"); });

    const fb = $("quizFb");
    if (correct) {
      state.quiz.streak++;
      state.quiz.correct++;
      if (!state.quiz.solved[catIdx]) state.quiz.solved[catIdx] = [];
      if (!state.quiz.solved[catIdx].includes(qi)) state.quiz.solved[catIdx].push(qi);

      let earned = QUIZ_REWARD[q.d];
      let msg = `⭕ 딩동댕~ 정답! +${earned}코인`;
      if (state.quiz.streak % 3 === 0) {
        earned += 10;
        msg = `🎉 정답! ${state.quiz.streak}연속 보너스까지 +${earned}코인!`;
        sfx.bonus();
      } else {
        sfx.correct();
      }
      fb.textContent = msg;
      fb.style.color = "#2e8b26";
      addCoins(earned);
      bumpStat("quizCorrect");

      // 3문제 정답마다 말씀 카드
      if (state.quiz.correct % 3 === 0) {
        setTimeout(() => grantRandomCard(), 700);
      }
    } else {
      btn.classList.add("wrong");
      state.quiz.streak = 0;
      addCoins(1);
      fb.textContent = `❌ 정답은 "${q.a[0]}" — ${ENCOURAGE[Math.floor(Math.random() * ENCOURAGE.length)]} (+1코인)`;
      fb.style.color = "#c0392b";
      sfx.wrong();
    }
    $("quizVerse").textContent = `📖 ${q.v}`;
    $("quizStreak").textContent = state.quiz.streak >= 2 ? `🔥 ${state.quiz.streak}문제 연속 정답 중!` : "";
    $("btnNextQ").classList.remove("hidden");
    saveGame();
  }

  /* ===== 말씀 카드 ===== */
  function grantRandomCard() {
    const missing = VERSE_CARDS.map((_, i) => i).filter((i) => !state.cards.includes(i));
    if (missing.length === 0) {
      addCoins(10);
      toast("🃏 카드를 모두 모아서 대신 +10코인!", true);
      return;
    }
    const ci = missing[Math.floor(Math.random() * missing.length)];
    state.cards.push(ci);
    sfx.card();
    const card = VERSE_CARDS[ci];
    const el = $("cardGetCard");
    el.innerHTML = `<div class="vc-emoji">${card.emoji}</div><div class="vc-text">"${card.text}"</div><div class="vc-ref">${card.ref}</div>`;
    $("cardGetModal").classList.remove("hidden");
    bumpStat("cardsGot");
    if (state.cards.length === VERSE_CARDS.length) {
      setTimeout(() => { addCoins(200); toast("👑 말씀 카드 24장 완성! +200코인!", true); sfx.mission(); }, 800);
    }
    saveGame();
  }

  function renderCards() {
    $("cardProgress").textContent = `모은 카드: ${state.cards.length} / ${VERSE_CARDS.length}장 (퀴즈 3문제 정답마다 1장!)`;
    const grid = $("cardGrid");
    grid.innerHTML = "";
    VERSE_CARDS.forEach((card, i) => {
      const el = document.createElement("div");
      if (state.cards.includes(i)) {
        el.className = "verse-card";
        el.innerHTML = `<div class="vc-emoji">${card.emoji}</div><div class="vc-text">"${card.text}"</div><div class="vc-ref">${card.ref}</div>`;
      } else {
        el.className = "verse-card locked";
        el.textContent = "?";
      }
      grid.appendChild(el);
    });
  }

  /* ===== 미션 ===== */
  function renderMissions() {
    const list = $("missionList");
    list.innerHTML = "";
    for (const m of MISSIONS) {
      const val = missionValue(m);
      const done = state.missionsDone.includes(m.id);
      const el = document.createElement("div");
      el.className = "mission" + (done ? " done" : "");
      const pct = Math.min(100, Math.round((val / m.goal) * 100));
      el.innerHTML = `
        <div class="m-info">
          <div class="m-name">${done ? "✅" : m.emoji} ${m.name}</div>
          <div class="m-desc">${m.desc} (${Math.min(val, m.goal)}/${m.goal})</div>
          <div class="m-bar"><div style="width:${done ? 100 : pct}%"></div></div>
        </div>
        <div class="m-reward">🪙${m.reward}</div>`;
      list.appendChild(el);
    }
  }

  function updateMissionTracker() {
    const next = MISSIONS.find((m) => !state.missionsDone.includes(m.id));
    const el = $("missionTracker");
    if (!next) { el.classList.add("hidden"); return; }
    const val = Math.min(missionValue(next), next.goal);
    el.classList.remove("hidden");
    el.innerHTML = `${next.emoji} ${next.name}: ${next.desc} (${val}/${next.goal})
      <div class="bar"><div style="width:${Math.round((val / next.goal) * 100)}%"></div></div>`;
  }

  /* ===== 설정 ===== */
  function bindSettings() {
    $("setSound").checked = state.settings.sound;
    $("setDay").checked = state.settings.dayCycle;
    $("setRD").value = state.settings.renderDist;
    $("setSens").value = state.settings.sensitivity;
    $("setSound").addEventListener("change", (e) => { state.settings.sound = e.target.checked; saveGame(); });
    $("setDay").addEventListener("change", (e) => { state.settings.dayCycle = e.target.checked; saveGame(); });
    $("setRD").addEventListener("input", (e) => { state.settings.renderDist = Number(e.target.value); saveGame(); });
    $("setSens").addEventListener("input", (e) => { state.settings.sensitivity = Number(e.target.value); saveGame(); });
    $("btnResetWorld").addEventListener("click", () => {
      if (confirm("정말 세상을 처음부터 다시 만들까요?\n(지은 건물, 코인, 카드가 모두 사라져요!)")) {
        Game.hardReset();
      }
    });
  }

  /* ===== 초기화 ===== */
  function init() {
    // 메뉴 버튼
    $("btnQuiz").addEventListener("click", () => { open("quizModal"); renderQuizCats(); });
    $("btnShop").addEventListener("click", () => { open("shopModal"); renderShop(); });
    $("btnInv").addEventListener("click", () => { open("invModal"); renderInventory(); });
    $("btnMissions").addEventListener("click", () => { open("missionsModal"); renderMissions(); });
    $("btnCards").addEventListener("click", () => { open("cardsModal"); renderCards(); });
    $("btnSettings").addEventListener("click", () => open("settingsModal"));
    $("btnHelp").addEventListener("click", () => open("helpModal"));

    // 닫기 버튼들
    $("btnCloseQuiz").addEventListener("click", closeAll);
    $("btnCloseShop").addEventListener("click", closeAll);
    $("btnCloseInv").addEventListener("click", closeAll);
    $("btnCloseMissions").addEventListener("click", closeAll);
    $("btnCloseCards").addEventListener("click", closeAll);
    $("btnCloseSettings").addEventListener("click", closeAll);
    $("btnCloseHelp").addEventListener("click", closeAll);
    $("btnCloseCardGet").addEventListener("click", () => $("cardGetModal").classList.add("hidden"));
    $("btnStart").addEventListener("click", () => {
      closeAll();
      state.helpSeen = true;
      saveGame();
    });

    // 퀴즈
    $("btnNextQ").addEventListener("click", nextQuestion);
    $("btnBackCats").addEventListener("click", renderQuizCats);
    $("btnHint").addEventListener("click", useHint);

    // 상점 탭
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        $("shopBlocks").classList.toggle("hidden", tab.dataset.tab !== "blocks");
        $("shopPerks").classList.toggle("hidden", tab.dataset.tab !== "perks");
      });
    });

    // 날기 버튼
    $("flyBtn").addEventListener("click", () => Game.toggleFly());

    bindSettings();
  }

  function showWelcome() {
    const card = VERSE_CARDS[Math.floor(Math.random() * VERSE_CARDS.length)];
    $("welcomeVerse").innerHTML = `📖 오늘의 말씀<br>"${card.text}"<br><small>- ${card.ref} -</small>`;
    $("welcomeModal").classList.remove("hidden");
  }

  return {
    init, toast, updateCoins, flyCoin, renderHotbar, renderInventory, renderShop,
    renderMissions, updateMissionTracker, renderCards, grantRandomCard,
    anyModalOpen, closeAll, open, showWelcome, sfx,
  };
})();
