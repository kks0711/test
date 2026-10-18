"use strict";

/* ------------------------------------------------------------------ 유틸 */
const TOKEN = document.querySelector('meta[name="studio-token"]').content;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");
const fmtTime = (t) => new Date(t * 1000).toLocaleString("ko-KR");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DENS = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

async function api(method, path, body, raw) {
  const opt = { method, headers: { "X-Studio-Token": TOKEN } };
  if (raw !== undefined) {
    opt.body = raw;
  } else if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch("/api" + path, opt);
  let data;
  try { data = await res.json(); } catch { throw new Error("서버 응답을 읽을 수 없습니다 (" + res.status + ")"); }
  if (!res.ok || data.ok === false) throw new Error(data.error || "요청 실패 (" + res.status + ")");
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.background = bad ? "var(--bad)" : "";
  t.style.color = bad ? "#fff" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2600);
}

function modal(html) {
  $("#modalBody").innerHTML = html;
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

async function watchJob(id, onUpdate) {
  let since = 0;
  for (;;) {
    const j = await api("GET", `/jobs/${id}?since=${since}`);
    since = j.next;
    onUpdate(j);
    if (j.status !== "running") return j;
    await sleep(600);
  }
}

/* ------------------------------------------------------------------ 상태 */
const S = {
  env: null, projects: [], pid: null, p: null, tab: "overview",
  cfg: null, dirty: false, decodeJob: null,
  edit: { dir: "assets/www", items: [], file: null, text: "", modified: false, loadedText: "" },
  ruleResults: {}, build: { job: null, lines: [], steps: [], running: false, status: "" },
  newIcons: null,
};

/* ------------------------------------------------------------------ 시작 */
async function init() {
  await Promise.all([loadEnv(), loadProjects()]);
  renderSide();
  const last = localStorage.getItem("studio.pid");
  if (last && S.projects.some((p) => p.id === last)) await openProject(last);
  else render();
}

async function loadEnv() {
  try { S.env = await api("GET", "/env"); } catch (e) { S.env = null; }
  const pill = $("#envPill");
  if (!S.env) { pill.textContent = "서버 연결 실패"; pill.className = "pill bad"; return; }
  pill.textContent = S.env.ready ? "● 도구 준비됨" : "● 도구 설치 필요";
  pill.className = "pill " + (S.env.ready ? "ok" : "bad");
}
$("#envPill").onclick = showEnv;

function showEnv() {
  const rows = (S.env?.items || []).map((i) => `
    <div class="tool-row"><span>${i.ok ? "✅" : "❌"}</span>
      <div><b>${esc(i.label)}</b><small>${esc(i.detail)}</small>${i.ok ? "" : `<small>→ ${esc(i.fix)}</small>`}</div></div>`).join("");
  const need = S.env?.items.find((i) => i.key === "apktool" && !i.ok);
  modal(`<h3>환경 점검</h3>
    <p class="muted">작업 폴더: <code>${esc(S.env?.workspace || "")}</code></p>${rows}
    <div id="installLog" class="log" style="height:120px;margin-top:12px" hidden></div>
    <div class="modal-actions">
      ${need ? '<button class="btn primary" id="btnInstall">apktool 자동 설치</button>' : ""}
      <button class="btn" onclick="closeModal()">닫기</button></div>`);
  const b = $("#btnInstall");
  if (b) b.onclick = async () => {
    b.disabled = true;
    const log = $("#installLog"); log.hidden = false;
    try {
      const { job } = await api("POST", "/env/install");
      const j = await watchJob(job, (u) => { log.textContent += u.lines.join("\n") + (u.lines.length ? "\n" : ""); });
      if (j.status === "error") throw new Error(j.error);
      await loadEnv(); toast("설치 완료"); closeModal();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  };
}

async function loadProjects() {
  try { S.projects = (await api("GET", "/projects")).projects; } catch { S.projects = []; }
}

function renderSide() {
  const ul = $("#projectList");
  if (!S.projects.length) { ul.innerHTML = '<li class="empty-side">아직 프로젝트가 없습니다.<br>APK를 올려 시작하세요.</li>'; return; }
  ul.innerHTML = S.projects.map((p) => `
    <li><button class="project-item ${p.id === S.pid ? "active" : ""}" data-open="${esc(p.id)}">
      <b>${esc(p.appName || p.sourceName)}</b>
      <span>${esc(p.packageName || "")}</span>
      <span>원본 ${esc(p.sourceName)} · 빌드 ${p.builds}개</span></button></li>`).join("");
  $$("[data-open]", ul).forEach((b) => (b.onclick = () => openProject(b.dataset.open)));
}

async function openProject(id) {
  try {
    const d = await api("GET", `/projects/${id}`);
    S.pid = id; S.p = d; S.cfg = structuredClone(d.config); S.dirty = false;
    S.edit = { dir: "assets/www", items: [], file: null, text: "", modified: false, loadedText: "" };
    S.ruleResults = {}; S.newIcons = null;
    localStorage.setItem("studio.pid", id);
    if (!d.decoded) S.tab = "overview";
    renderSide(); render();
  } catch (e) {
    toast(e.message, true);
    localStorage.removeItem("studio.pid");
    S.pid = null; render();
  }
}

async function refreshProject() {
  const d = await api("GET", `/projects/${S.pid}`);
  S.p = d;
  if (!S.dirty) S.cfg = structuredClone(d.config);
}

/* ------------------------------------------------------------------ 렌더 */
function render() {
  const m = $("#main");
  if (!S.pid || !S.p) { m.innerHTML = welcomeHTML(); bindWelcome(); return; }
  if (!S.p.decoded) { m.innerHTML = decodingHTML(); return; }
  const a = S.p.analysis;
  const tabs = [["overview", "개요·점검"], ["clone", "복제 설정"], ["upgrade", "업그레이드"], ["build", "빌드·배포"]];
  m.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(a.label)} <span class="muted" style="font-weight:400">→ ${esc(S.cfg.appName)}</span></h1>
        <div class="sub mono">${esc(a.package)} → ${esc(S.cfg.packageName)}</div></div>
      <div class="row">
        <button class="btn small danger" id="btnDelete">프로젝트 삭제</button>
      </div>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([k, l], i) =>
      `<button class="tab ${S.tab === k ? "active" : ""}" role="tab" data-tab="${k}"><span class="n">${i + 1}</span>${l}</button>`).join("")}</div>
    <div id="tabBody">${tabHTML()}</div>
    ${["clone", "upgrade"].includes(S.tab) ? saveBarHTML() : ""}`;
  $$("[data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; render(); if (S.tab === "upgrade") loadDir(S.edit.dir); }));
  $("#btnDelete").onclick = deleteProject;
  bindTab();
}

function tabHTML() {
  return { overview: overviewHTML, clone: cloneHTML, upgrade: upgradeHTML, build: buildHTML }[S.tab]();
}
function bindTab() {
  ({ overview() {}, clone: bindClone, upgrade: bindUpgrade, build: bindBuild })[S.tab]();
  bindFields();
  const sb = $("#saveBtn"); if (sb) sb.onclick = saveCfg;
}

function saveBarHTML() {
  return `<div class="savebar"><span class="msg ${S.dirty ? "dirty" : ""}" id="saveMsg">${S.dirty ? "저장하지 않은 변경이 있습니다" : "모든 변경이 저장되었습니다"}</span>
    <div class="row"><button class="btn primary" id="saveBtn" ${S.dirty ? "" : "disabled"}>저장</button>
    <button class="btn" data-goto="build">빌드 탭으로 →</button></div></div>`;
}
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) { S.tab = g.dataset.goto; render(); }
});

function markDirty() {
  S.dirty = true;
  const msg = $("#saveMsg"); if (msg) { msg.textContent = "저장하지 않은 변경이 있습니다"; msg.classList.add("dirty"); }
  const sb = $("#saveBtn"); if (sb) sb.disabled = false;
}

async function saveCfg() {
  try {
    const r = await api("PUT", `/projects/${S.pid}/config`, S.cfg);
    S.cfg = r.config; S.dirty = false;
    await loadProjects(); renderSide();
    toast("저장했습니다");
    render();
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

/* 입력 ↔ cfg 바인딩 (data-bind="swing.appId") */
function getPath(o, p) { return p.split(".").reduce((x, k) => x?.[k], o); }
function setPath(o, p, v) { const ks = p.split("."); const l = ks.pop(); ks.reduce((x, k) => x[k], o)[l] = v; }
function bindFields() {
  $$("[data-bind]").forEach((el) => {
    const path = el.dataset.bind;
    const ev = el.type === "checkbox" ? "change" : "input";
    el.addEventListener(ev, () => {
      let v = el.type === "checkbox" ? el.checked : el.value;
      if (el.dataset.num) v = parseInt(v || "0", 10) || 0;
      setPath(S.cfg, path, v);
      if (path === "packageName") el.classList.toggle("invalid", !PKG_RE.test(v));
      markDirty();
    });
  });
}
const PKG_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/* ------------------------------------------------------------------ 웰컴 / 새 프로젝트 */
function welcomeHTML() {
  return `<div class="hero">
    <h1>APK를 복제하고, 계속 업그레이드하세요</h1>
    <p class="muted">APK 한 개를 올리면 이름·패키지명·아이콘을 바꿔 독립된 앱으로 복제하고, 화면(HTML/CSS/JS)과 버전을 고쳐 서명된 새 APK로 다시 빌드합니다. 모든 작업은 이 컴퓨터 안에서만 이루어집니다.</p>
    <div class="flow">
      <div><b>① 업로드·분석</b>패키지, 권한, 서명, 서버 연동 구조를 해체해 점검</div>
      <div><b>② 복제 설정</b>앱 이름 · 패키지명 · 아이콘 · 권한</div>
      <div><b>③ 업그레이드</b>버전, 화면 편집, 텍스트 치환, 서버 식별값</div>
      <div><b>④ 빌드·검증</b>서명 → 정렬 → 독립 검증 → 다운로드</div>
    </div>
    <div class="drop" id="welcomeDrop" tabindex="0" role="button"><b>여기에 APK 파일을 끌어다 놓거나 클릭</b>.apk 파일 (최대 400MB)</div>
    <input type="file" id="welcomeFile" accept=".apk" hidden>
  </div>`;
}
function bindWelcome() {
  const drop = $("#welcomeDrop"), file = $("#welcomeFile");
  if (!drop) return;
  drop.onclick = () => file.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") file.click(); };
  file.onchange = () => file.files[0] && uploadApk(file.files[0]);
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && uploadApk(e.dataTransfer.files[0]));
}

$("#btnNew").onclick = () => {
  const opts = S.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.appName || p.sourceName)} (${esc(p.id)})</option>`).join("");
  modal(`<h3>새 프로젝트</h3>
    <div class="drop" id="mDrop" tabindex="0" role="button"><b>APK 파일 선택 / 끌어다 놓기</b>브라우저에서 업로드</div>
    <input type="file" id="mFile" accept=".apk" hidden>
    <div class="spacer"></div>
    <label class="field">또는 이 컴퓨터(서버)의 파일 경로<input type="text" id="mPath" placeholder="/home/me/app.apk" class="mono"></label>
    <div class="spacer"></div>
    <label class="field">설정 복사 (선택) <small>원본 앱이 업데이트됐을 때, 기존 복제 설정을 새 APK에 그대로 적용</small>
      <select id="mCopy"><option value="">복사 안 함</option>${opts}</select></label>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">취소</button>
      <button class="btn primary" id="mGo">경로로 시작</button></div>`);
  const drop = $("#mDrop"), file = $("#mFile");
  drop.onclick = () => file.click();
  file.onchange = () => file.files[0] && uploadApk(file.files[0], $("#mCopy").value);
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && uploadApk(e.dataTransfer.files[0], $("#mCopy").value));
  $("#mGo").onclick = async () => {
    const path = $("#mPath").value.trim();
    if (!path) return toast("경로를 입력하거나 파일을 선택하세요", true);
    try {
      const r = await api("POST", "/projects/import", { path, copyFrom: $("#mCopy").value || null });
      closeModal(); startDecoding(r.id, r.job);
    } catch (e) { toast(e.message, true); }
  };
};

async function uploadApk(file, copyFrom) {
  if (!S.env?.ready) { toast("먼저 환경 점검에서 필수 도구를 준비하세요", true); showEnv(); return; }
  if (!file.name.toLowerCase().endsWith(".apk")) return toast(".apk 파일만 올릴 수 있습니다", true);
  closeModal();
  $("#main").innerHTML = `<div class="hero"><h1>업로드 중…</h1><p class="muted">${esc(file.name)} (${fmtSize(file.size)})</p></div>`;
  try {
    const q = `?name=${encodeURIComponent(file.name)}${copyFrom ? "&copyFrom=" + encodeURIComponent(copyFrom) : ""}`;
    const r = await api("POST", "/projects/upload" + q, undefined, file);
    startDecoding(r.id, r.job);
  } catch (e) { toast(e.message, true); S.pid = null; render(); }
}

async function startDecoding(id, jobId) {
  S.pid = id; S.p = { decoded: false }; S.tab = "overview";
  render();
  const logEl = () => $("#decLog");
  try {
    const j = await watchJob(jobId, (u) => {
      const el = logEl(); if (!el) return;
      el.textContent += u.lines.join("\n") + (u.lines.length ? "\n" : "");
      el.scrollTop = el.scrollHeight;
    });
    if (j.status === "error") throw new Error(j.error);
    await loadProjects();
    await openProject(id);
    toast("분석이 끝났습니다");
  } catch (e) { toast(e.message, true); await loadProjects(); S.pid = null; S.p = null; renderSide(); render(); }
}
function decodingHTML() {
  return `<div class="hero"><h1>APK 해체·분석 중…</h1><p class="muted">apktool 로 리소스와 코드를 풀고 구조를 분석합니다. (보통 10–30초)</p>
    <div id="decLog" class="log"></div></div>`;
}

async function deleteProject() {
  if (!confirm(`이 프로젝트와 모든 빌드·키스토어를 삭제할까요?\n\n키스토어를 백업하지 않았다면 이후 같은 서명으로 업그레이드할 수 없습니다.`)) return;
  try {
    await api("DELETE", `/projects/${S.pid}`);
    localStorage.removeItem("studio.pid");
    S.pid = null; S.p = null;
    await loadProjects(); renderSide(); render(); toast("삭제했습니다");
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------------------ 탭 1: 개요 */
function overviewHTML() {
  const a = S.p.analysis;
  const kind = { swing2app: "Swing2App 하이브리드 (Cordova WebView)", cordova: "Cordova 하이브리드", native: "네이티브 Android" }[a.kind];
  const sw = a.swing || {};
  const lvlName = { fix: "자동 처리", warn: "주의", info: "참고" };
  return `
  <div class="card"><h3>원본 APK</h3><p class="hint">분석된 정보입니다. 파일은 변경되지 않습니다.</p>
    <dl class="kv">
      <dt>앱 이름</dt><dd><b>${esc(a.label)}</b></dd>
      <dt>패키지명</dt><dd class="mono">${esc(a.package)}</dd>
      <dt>버전</dt><dd>${esc(a.versionName)} <span class="muted">(versionCode ${a.versionCode})</span></dd>
      <dt>SDK</dt><dd>minSdk ${esc(a.minSdk)} · targetSdk ${esc(a.targetSdk)}</dd>
      <dt>유형</dt><dd>${esc(kind)}</dd>
      <dt>크기</dt><dd>${fmtSize(a.size)} <span class="muted mono">sha256 ${esc((a.sha256 || "").slice(0, 16))}…</span></dd>
      <dt>원본 서명</dt><dd>${esc(a.cert.owner || "확인 불가")}<br><span class="muted mono">SHA-256 ${esc(a.cert.sha256 || "")}</span></dd>
      <dt>컴포넌트</dt><dd>Activity ${a.components.activity} · Service ${a.components.service} · Receiver ${a.components.receiver} · Provider ${a.components.provider}</dd>
    </dl></div>

  <div class="card"><h3>복제 전 점검</h3><p class="hint">'자동 처리'는 빌드할 때 알아서 고쳐지고, '주의'는 복제 후 직접 확인이 필요한 항목입니다.</p>
    ${a.risks.map((r) => `<div class="risk"><span class="tag ${r.level}">${lvlName[r.level]}</span><div><b>${esc(r.title)}</b><p>${esc(r.detail)}</p></div></div>`).join("")}</div>

  ${a.kind === "swing2app" ? `<div class="card"><h3>Swing2App 식별값</h3><p class="hint">이 값들이 앱을 서버·푸시와 연결합니다. 업그레이드 탭에서 바꿀 수 있습니다.</p>
    <dl class="kv"><dt>appId</dt><dd class="mono">${esc(sw.appId)}</dd><dt>OneSignal</dt><dd class="mono">${esc(sw.onsAppId)}</dd>
    <dt>FCM sender</dt><dd class="mono">${esc(sw.senderID)}</dd><dt>packageId</dt><dd class="mono">${esc(sw.packageId)}</dd>
    <dt>엔진 버전</dt><dd>${esc(sw.engineVersionValue)} · 앱 버전값 ${esc(sw.versionValue)}</dd></dl></div>` : ""}

  <div class="card"><h3>권한 ${a.permissions.length}개 · Cordova 플러그인 ${a.plugins.length}개</h3>
    <div class="chips">${a.permissions.map((p) => `<span class="chip">${esc(p.replace("android.permission.", ""))}</span>`).join("")}</div>
    <div class="spacer"></div>
    <div class="chips">${a.plugins.map((p) => `<span class="chip accent">${esc(p)}</span>`).join("")}</div></div>`;
}

/* ------------------------------------------------------------------ 탭 2: 복제 */
function cloneHTML() {
  const a = S.p.analysis, c = S.cfg;
  const iconsHave = S.p.icons.length > 0;
  return `
  <div class="card"><h3>새 앱 정체성</h3><p class="hint">패키지명이 다르면 원본과 완전히 별개의 앱으로 설치됩니다. 한 번 배포한 뒤에는 패키지명을 바꾸지 마세요.</p>
    <div class="grid2">
      <label class="field">앱 이름 <small>홈 화면에 표시되는 이름</small>
        <input type="text" data-bind="appName" value="${esc(c.appName)}"></label>
      <label class="field">패키지명 (applicationId) <small>소문자·숫자·밑줄, 점으로 2단계 이상</small>
        <input type="text" class="mono ${PKG_RE.test(c.packageName) ? "" : "invalid"}" data-bind="packageName" value="${esc(c.packageName)}"></label>
      <label class="field">버전 이름 <small>사용자에게 보이는 버전 (예: 1.4.0)</small>
        <input type="text" data-bind="versionName" value="${esc(c.versionName)}"></label>
      <label class="field">버전 코드 <small>업그레이드 때마다 반드시 증가 (원본 ${a.versionCode})</small>
        <input type="number" min="1" data-num="1" data-bind="versionCode" value="${c.versionCode}"></label>
    </div></div>

  <div class="card"><h3>아이콘</h3><p class="hint">정사각형 PNG 한 장이면 ldpi~xxxhdpi 6종을 자동 생성합니다 (512×512 이상 권장).</p>
    <div class="row"><input type="file" id="iconFile" accept="image/png,image/jpeg,image/webp">
      ${iconsHave ? '<button class="btn small" id="iconClear">원본 아이콘으로 되돌리기</button>' : ""}</div>
    <div class="icon-row" id="iconRow">${Object.keys(DENS).map((d) => `<div class="icon-box"><img alt="${d}" src="/api/projects/${S.pid}/icon?d=${d}&token=${TOKEN}&v=${Date.now()}" onerror="this.style.visibility='hidden'">${d}<br>${DENS[d]}px</div>`).join("")}</div>
    <p class="muted" style="margin-top:10px">${iconsHave ? "✓ 새 아이콘이 적용되도록 저장되어 있습니다 (위 미리보기)" : "지금은 원본 아이콘이 그대로 사용됩니다."}</p></div>

  <div class="card"><h3>자동 보정 옵션</h3>
    <label class="toggle"><input type="checkbox" data-bind="stripSplitRequired" ${c.stripSplitRequired ? "checked" : ""}>
      <div><b>스플릿 필수 해제</b><span>Play 번들(AAB)에서 뽑은 base APK 는 isSplitRequired 때문에 단독 설치가 안 됩니다. ${a.splitRequired ? "<b style='color:var(--warn)'>이 APK에 해당합니다 — 켜 두세요.</b>" : "이 APK에는 해당 없음."}</span></div></label>
    <label class="toggle"><input type="checkbox" data-bind="stripStoreMeta" ${c.stripStoreMeta ? "checked" : ""}>
      <div><b>Play 스토어 메타데이터 제거</b><span>com.android.vending.* / com.android.stamp.* 항목 삭제</span></div></label>
    <label class="toggle"><input type="checkbox" data-bind="replaceNameInWww" ${c.replaceNameInWww ? "checked" : ""}>
      <div><b>웹 화면 안의 옛 앱 이름도 새 이름으로 교체</b><span>assets/www 안에서 “${esc(a.label)}” ${a.nameHitsInWww}곳 발견</span></div></label>
    <label class="toggle"><input type="checkbox" data-bind="debuggable" ${c.debuggable ? "checked" : ""}>
      <div><b>디버그 가능(debuggable)</b><span>chrome://inspect 로 WebView 를 디버깅할 때만 켜세요. 배포용 빌드에서는 끄기.</span></div></label>
  </div>

  <div class="card"><h3>권한 정리</h3><p class="hint">체크한 권한은 복제본에서 제거됩니다. 해당 기능(카메라·위치 등)이 필요하면 제거하지 마세요.</p>
    <div class="perm-grid">${a.permissions.map((p) => `<label><input type="checkbox" data-perm="${esc(p)}" ${c.removePermissions.includes(p) ? "checked" : ""}> ${esc(p.replace("android.permission.", ""))}</label>`).join("")}</div></div>`;
}
function bindClone() {
  $$("[data-perm]").forEach((el) => (el.onchange = () => {
    const s = new Set(S.cfg.removePermissions);
    el.checked ? s.add(el.dataset.perm) : s.delete(el.dataset.perm);
    S.cfg.removePermissions = [...s]; markDirty();
  }));
  const f = $("#iconFile"); if (f) f.onchange = () => f.files[0] && makeIcons(f.files[0]);
  const c = $("#iconClear"); if (c) c.onclick = async () => {
    await api("DELETE", `/projects/${S.pid}/icons`); await refreshProject(); render(); toast("원본 아이콘으로 되돌렸습니다");
  };
}
async function makeIcons(file) {
  try {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    if (side < 96) throw new Error("이미지가 너무 작습니다 (최소 96px)");
    const sx = (bmp.width - side) / 2, sy = (bmp.height - side) / 2;
    const pngs = {};
    for (const [d, px] of Object.entries(DENS)) {
      const cv = document.createElement("canvas"); cv.width = cv.height = px;
      const g = cv.getContext("2d"); g.imageSmoothingQuality = "high";
      g.drawImage(bmp, sx, sy, side, side, 0, 0, px, px);
      pngs[d] = cv.toDataURL("image/png");
    }
    await api("POST", `/projects/${S.pid}/icons`, { pngs });
    await refreshProject(); render(); toast("아이콘을 적용했습니다 (빌드 때 반영)");
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------------------ 탭 3: 업그레이드 */
function upgradeHTML() {
  const a = S.p.analysis, c = S.cfg, sw = c.swing;
  const isSwing = a.kind === "swing2app";
  return `
  <div class="card"><h3>버전 올리기</h3><p class="hint">설치된 복제본 위에 덮어쓰려면 <b>같은 키스토어</b>로 서명하고 <b>versionCode 를 반드시 올려야</b> 합니다.</p>
    <div class="row"><span>현재 설정 <b>${esc(c.versionName)}</b> (code ${c.versionCode})</span>
      <button class="btn small" data-bump="patch">패치 +1</button><button class="btn small" data-bump="minor">마이너 +1</button><button class="btn small" data-bump="major">메이저 +1</button></div></div>

  <div class="card"><h3>Swing2App 연결 ${isSwing ? "" : '<span class="chip">감지되지 않음</span>'}</h3>
    <p class="hint">앱의 메뉴·게시판·회원 데이터는 Swing2App 서버가 내려줍니다. 독립된 앱으로 키우려면 Swing2App 에서 새 앱을 만든 뒤 그 값으로 바꾸세요. 비워 두면 원본 값을 그대로 씁니다.</p>
    ${isSwing ? `
    <label class="toggle"><input type="checkbox" data-bind="swing.enabled" ${sw.enabled ? "checked" : ""}><div><b>식별값 패치 사용</b><span>main.min.js 의 swingAppInfo.* 를 아래 값으로 교체</span></div></label>
    <div class="grid2" style="margin-top:6px">
      <label class="field">appId <small>서버 데이터 키 (원본: ${esc(a.swing.appId)})</small><input type="text" class="mono" data-bind="swing.appId" value="${esc(sw.appId)}"></label>
      <label class="field">OneSignal App ID <small>푸시 구독 대상</small><input type="text" class="mono" data-bind="swing.onsAppId" value="${esc(sw.onsAppId)}"></label>
      <label class="field">FCM Sender ID<input type="text" class="mono" data-bind="swing.senderID" value="${esc(sw.senderID)}"></label>
    </div>
    <label class="toggle"><input type="checkbox" data-bind="swing.syncPackage" ${sw.syncPackage ? "checked" : ""}><div><b>packageId/bundleId 를 새 패키지명으로 동기화</b><span>켜 두면 '업데이트 필요' 알림이 원본 앱의 Play 페이지로 연결되는 것을 막습니다.</span></div></label>
    <label class="toggle"><input type="checkbox" data-bind="swing.syncVersion" ${sw.syncVersion ? "checked" : ""}><div><b>versionValue 를 버전 이름과 동기화</b><span>앱 안의 버전 비교값 (swingAppInfo.versionValue)</span></div></label>` : '<p class="muted">이 APK는 Swing2App 구조가 아니므로 해당 없음.</p>'}
  </div>

  <div class="card"><h3>텍스트 치환 규칙</h3><p class="hint">assets/www 의 html·js·css·json 에서 찾아 바꿉니다. 옛 앱 이름 교체는 복제 탭 옵션이 이미 처리합니다. 미리보기로 몇 곳이 바뀌는지 먼저 확인하세요.</p>
    <div id="rules">${c.rules.map(ruleRowHTML).join("")}</div>
    <div class="row"><button class="btn small" id="ruleAdd">＋ 규칙 추가</button><button class="btn small" id="rulePreview">미리보기(바뀌는 곳 세기)</button></div></div>

  <div class="card"><h3>화면 파일 편집기</h3><p class="hint">assets/www 의 파일을 직접 고칩니다. 저장하면 원본은 그대로 두고 '덮어쓰기'로 따로 보관되어 언제든 되돌릴 수 있습니다.
    ${S.p.overlay.length ? `현재 수정된 파일 ${S.p.overlay.length}개.` : ""}</p>
    <div class="editor"><div class="filelist" id="filelist"></div><div id="editorPane">${editorPaneHTML()}</div></div></div>

  <div class="card"><h3>사용자 CSS / JS 주입</h3><p class="hint">main.html 에 마지막으로 삽입됩니다 (head 끝 / body 끝). 서버가 내려주는 화면 위에 덧씌우는 가장 안전한 커스터마이징입니다.</p>
    <div class="grid2"><label class="field">CSS<textarea data-bind="customCss" placeholder=".navbar { background:#4f46e5 }">${esc(c.customCss)}</textarea></label>
      <label class="field">JavaScript<textarea data-bind="customJs" placeholder="document.addEventListener('deviceready', function(){ ... })">${esc(c.customJs)}</textarea></label></div></div>`;
}
function ruleRowHTML(r, i) {
  const res = S.ruleResults[i];
  return `<div class="rule-row" data-rule="${i}">
    <input type="text" placeholder="찾을 내용" value="${esc(r.find)}" data-rf="find">
    <input type="text" placeholder="바꿀 내용" value="${esc(r.replace)}" data-rf="replace">
    <label><input type="checkbox" data-rf="regex" ${r.regex ? "checked" : ""}> 정규식</label>
    <label><input type="checkbox" data-rf="enabled" ${r.enabled ? "checked" : ""}> 사용</label>
    <button class="btn small danger" data-rdel="${i}" aria-label="규칙 삭제">삭제</button></div>
    ${res ? `<div class="rule-result">${res.error ? "⚠ " + esc(res.error) : `${res.total}곳 — ${res.files.map((f) => esc(f.file) + " ×" + f.count).join(", ") || "일치 없음"}`}</div>` : ""}`;
}
function bindUpgrade() {
  $$("[data-bump]").forEach((b) => (b.onclick = async () => {
    if (S.dirty && !(await saveCfg())) return;
    try { const r = await api("POST", `/projects/${S.pid}/bump`, { level: b.dataset.bump }); S.cfg = r.config; S.dirty = false; render(); toast(`버전 ${S.cfg.versionName} (${S.cfg.versionCode})`); }
    catch (e) { toast(e.message, true); }
  }));
  bindUpgrade_rules();
  $("#ruleAdd").onclick = () => { S.cfg.rules.push({ find: "", replace: "", regex: false, enabled: true }); markDirty(); render(); loadDir(S.edit.dir); };
  $("#rulePreview").onclick = async () => {
    try {
      const r = await api("POST", `/projects/${S.pid}/rules/preview`, { rules: S.cfg.rules });
      S.ruleResults = Object.fromEntries(r.results.map((x) => [x.index, x]));
      $("#rules").innerHTML = S.cfg.rules.map(ruleRowHTML).join(""); bindUpgrade_rules();
    } catch (e) { toast(e.message, true); }
  };
  renderFileList();
  bindEditor();
}
function bindUpgrade_rules() { // 미리보기 후 규칙 행만 다시 바인딩
  const rules = $("#rules");
  $$("[data-rule]", rules).forEach((row) => {
    const r = S.cfg.rules[+row.dataset.rule];
    $$("[data-rf]", row).forEach((el) => (el.oninput = el.onchange = () => { r[el.dataset.rf] = el.type === "checkbox" ? el.checked : el.value; markDirty(); }));
  });
  $$("[data-rdel]").forEach((b) => (b.onclick = () => { S.cfg.rules.splice(+b.dataset.rdel, 1); S.ruleResults = {}; markDirty(); render(); }));
}

/* --- 파일 편집기 --- */
async function loadDir(dir) {
  try {
    const r = await api("GET", `/projects/${S.pid}/tree?path=${encodeURIComponent(dir)}`);
    S.edit.dir = r.path; S.edit.items = r.items; renderFileList();
  } catch (e) { toast(e.message, true); }
}
function renderFileList() {
  const el = $("#filelist"); if (!el) return;
  const parent = S.edit.dir.includes("/") ? S.edit.dir.split("/").slice(0, -1).join("/") : "";
  el.innerHTML = `<div class="crumb">/${esc(S.edit.dir)}</div>` +
    (S.edit.dir && S.edit.dir !== "assets" ? `<button class="frow" data-dir="${esc(parent)}">⬆ ..</button>` : "") +
    S.edit.items.map((i) => `<button class="frow ${S.edit.file === i.path ? "sel" : ""}" data-${i.dir ? "dir" : "file"}="${esc(i.path)}">
      <span>${i.dir ? "📁" : i.text ? "📄" : "🖼"} ${esc(i.name)} ${i.modified ? '<span class="mod">●</span>' : ""}</span><small>${i.dir ? "" : fmtSize(i.size)}</small></button>`).join("");
  $$("[data-dir]", el).forEach((b) => (b.onclick = () => loadDir(b.dataset.dir)));
  $$("[data-file]", el).forEach((b) => (b.onclick = () => openFile(b.dataset.file, S.edit.items.find((i) => i.path === b.dataset.file))));
}
function editorPaneHTML() {
  const e = S.edit;
  if (!e.file) return '<p class="muted">왼쪽에서 파일을 선택하세요. 텍스트 파일은 편집, 이미지·기타 파일은 같은 이름으로 교체할 수 있습니다.</p>';
  if (e.binary) return `<div class="editor-bar"><span class="name">${esc(e.file)} ${e.modified ? '<span class="chip warn">교체됨</span>' : ""}</span>
      ${e.modified ? '<button class="btn small" id="edRevert">원본으로 되돌리기</button>' : ""}</div>
    <label class="field">같은 형식의 파일로 교체<input type="file" id="edReplace"></label>`;
  return `<div class="editor-bar"><span class="name">${esc(e.file)} ${e.modified ? '<span class="chip warn">수정됨</span>' : ""}</span>
      <button class="btn small primary" id="edSave">파일 저장</button>
      ${e.modified ? '<button class="btn small" id="edRevert">원본으로 되돌리기</button>' : ""}</div>
    <textarea id="edText" spellcheck="false">${esc(e.text)}</textarea>`;
}
async function openFile(path, item) {
  const e = S.edit;
  try {
    if (item && !item.text) { Object.assign(e, { file: path, binary: true, modified: item.modified, text: "" }); }
    else {
      const r = await api("GET", `/projects/${S.pid}/file?path=${encodeURIComponent(path)}`);
      Object.assign(e, { file: path, binary: false, text: r.text, modified: r.modified });
    }
    $("#editorPane").innerHTML = editorPaneHTML(); renderFileList(); bindEditor();
  } catch (err) { toast(err.message, true); }
}
function bindEditor() {
  const e = S.edit;
  const save = $("#edSave"); if (save) save.onclick = async () => {
    try { const r = await api("PUT", `/projects/${S.pid}/file`, { path: e.file, text: $("#edText").value }); S.p.overlay = r.overlay; e.modified = true; toast("저장했습니다 (빌드에 반영)"); await loadDir(e.dir || S.edit.dir); $("#editorPane").innerHTML = editorPaneHTML(); bindEditor(); }
    catch (err) { toast(err.message, true); }
  };
  const rev = $("#edRevert"); if (rev) rev.onclick = async () => {
    try { const r = await api("DELETE", `/projects/${S.pid}/file?path=${encodeURIComponent(e.file)}`); S.p.overlay = r.overlay; e.modified = false; await openFile(e.file, { text: !e.binary }); await loadDir(S.edit.dir); toast("되돌렸습니다"); }
    catch (err) { toast(err.message, true); }
  };
  const rep = $("#edReplace"); if (rep) rep.onchange = () => {
    const f = rep.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      try { const r = await api("PUT", `/projects/${S.pid}/file`, { path: e.file, b64: String(rd.result).split(",")[1] }); S.p.overlay = r.overlay; e.modified = true; toast("교체했습니다"); await loadDir(S.edit.dir); $("#editorPane").innerHTML = editorPaneHTML(); bindEditor(); }
      catch (err) { toast(err.message, true); }
    };
    rd.readAsDataURL(f);
  };
}

/* ------------------------------------------------------------------ 탭 4: 빌드 */
function buildHTML() {
  const k = S.p.keystore, b = S.build;
  const stepsHTML = (b.steps.length ? b.steps : ["준비", "패치", "리소스·코드 빌드", "v1 서명", "정렬", "v2 서명", "검증"].map((n) => ({ name: n, status: "pending" })))
    .map((s) => `<span class="step ${s.status}">${esc(s.name)}</span>`).join("");
  return `
  <div class="card"><h3>서명 키스토어</h3>
    <p class="hint">업그레이드 APK 는 처음 복제할 때와 <b>같은 키</b>로 서명해야 기존 설치본 위에 설치됩니다. 키를 잃으면 사용자가 앱을 지우고 다시 설치해야 합니다.</p>
    ${k ? `<dl class="kv"><dt>별칭</dt><dd>${esc(k.alias)} ${k.imported ? '<span class="chip">가져옴</span>' : ""}</dd>
      <dt>SHA-1</dt><dd class="mono copy" data-copy="${esc(k.sha1)}">${esc(k.sha1)}</dd>
      <dt>SHA-256</dt><dd class="mono copy" data-copy="${esc(k.sha256)}">${esc(k.sha256)}</dd>
      <dt>카카오 키 해시</dt><dd class="mono copy" data-copy="${esc(k.keyHashKakao)}">${esc(k.keyHashKakao)}</dd>
      <dt>유효기간</dt><dd>${esc(k.valid)}</dd></dl>
      <div class="row" style="margin-top:12px"><a class="btn small" href="/api/projects/${S.pid}/keystore/download?token=${TOKEN}">⬇ 키스토어 백업(.p12)</a>
        <button class="btn small" id="ksSecret">비밀번호 보기</button>
        <button class="btn small danger" id="ksDelete">삭제</button></div>
      <div class="callout" style="margin-top:12px">⚠ 키스토어와 비밀번호를 안전한 곳에 백업하세요. 비밀번호는 이 컴퓨터의 프로젝트 폴더에 평문으로 저장되어 있습니다.</div>`
    : `<p class="muted">아직 없습니다. 첫 빌드 때 자동 생성하거나, 기존 키스토어를 가져오세요.</p>
      <div class="row"><button class="btn small primary" id="ksCreate">새 키 만들기</button><button class="btn small" id="ksImport">기존 키스토어 가져오기</button></div>`}
  </div>

  <div class="card"><h3>빌드</h3><p class="hint">저장된 설정과 편집 내용을 적용해 APK 를 만들고, 서명 후 독립된 검증기로 확인합니다. (보통 20–40초)</p>
    <div class="row"><button class="btn primary" id="btnBuild" ${b.running ? "disabled" : ""}>${b.running ? "빌드 중…" : "▶ 지금 빌드"}</button>
      <span class="muted">${esc(S.cfg.appName)} · ${esc(S.cfg.packageName)} · v${esc(S.cfg.versionName)} (${S.cfg.versionCode})</span></div>
    ${S.dirty ? '<div class="callout" style="margin-top:12px">저장하지 않은 변경이 있습니다. 빌드를 누르면 먼저 저장합니다.</div>' : ""}
    <div class="stepper" id="stepper" style="margin-top:14px">${stepsHTML}</div>
    <div class="log" id="buildLog">${b.lines.map(logLine).join("")}</div>
    ${b.status === "error" ? '<div class="callout bad" style="margin-top:12px">빌드가 실패했습니다. 로그 마지막 줄을 확인하세요.</div>' : ""}
  </div>

  <div class="card"><h3>산출물</h3>
    ${S.p.builds.length ? S.p.builds.map(buildItemHTML).join("") : '<p class="muted">아직 빌드한 APK 가 없습니다.</p>'}
    <div class="callout info" style="margin-top:14px">설치: 휴대폰에서 APK 를 열거나 <code>adb install -r 파일.apk</code>. 원본 앱과 서명이 다르므로 원본 위에 덮어쓰지 않고 별도 앱으로 설치됩니다.</div></div>`;
}
function logLine(l) {
  const cls = /^✗|실패|Exception|ERROR/.test(l) ? "err" : /^✓|^  ✓/.test(l) ? "okl" : "";
  return `<div class="${cls}">${esc(l)}</div>`;
}
function buildItemHTML(b) {
  return `<div class="build-item"><div class="build-top"><div><b>${esc(b.name)}</b><div class="muted">v${esc(b.versionName)} (${b.versionCode}) · ${fmtSize(b.size)} · ${fmtTime(b.built)}</div></div>
    <a class="btn primary small" href="/api/projects/${S.pid}/download/${encodeURIComponent(b.name)}?token=${TOKEN}">⬇ APK 다운로드</a></div>
    <div class="mono muted copy" data-copy="${esc(b.sha256)}" style="word-break:break-all">sha256 ${esc(b.sha256)}</div>
    ${b.verify ? `<div class="checks">${b.verify.checks.map((c) => `<div class="${c.ok ? "y" : "n"}">${c.ok ? "✓" : "✗"} ${esc(c.name)}</div>`).join("")}</div>` : ""}</div>`;
}
function bindBuild() {
  $$("[data-copy]").forEach((el) => (el.onclick = () => { navigator.clipboard?.writeText(el.dataset.copy); toast("복사했습니다"); }));
  const create = $("#ksCreate"); if (create) create.onclick = async () => {
    try { await api("POST", `/projects/${S.pid}/keystore`, { action: "create", cn: S.cfg.appName }); await refreshProject(); render(); toast("키스토어를 만들었습니다"); }
    catch (e) { toast(e.message, true); }
  };
  const imp = $("#ksImport"); if (imp) imp.onclick = () => {
    modal(`<h3>키스토어 가져오기</h3><p class="muted">PKCS12(.p12/.pfx) 또는 JKS(.jks/.keystore)</p>
      <label class="field">파일<input type="file" id="kFile"></label><div class="spacer"></div>
      <div class="grid2"><label class="field">별칭(alias)<input type="text" id="kAlias"></label><label class="field">비밀번호<input type="password" id="kPass"></label></div>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">취소</button><button class="btn primary" id="kGo">가져오기</button></div>`);
    $("#kGo").onclick = () => {
      const f = $("#kFile").files[0]; if (!f) return toast("파일을 선택하세요", true);
      const rd = new FileReader();
      rd.onload = async () => {
        try { await api("POST", `/projects/${S.pid}/keystore`, { action: "import", b64: String(rd.result).split(",")[1], alias: $("#kAlias").value, password: $("#kPass").value }); closeModal(); await refreshProject(); render(); toast("가져왔습니다"); }
        catch (e) { toast(e.message, true); }
      };
      rd.readAsDataURL(f);
    };
  };
  const sec = $("#ksSecret"); if (sec) sec.onclick = async () => {
    try { const r = await api("GET", `/projects/${S.pid}/keystore/secret`); modal(`<h3>키스토어 비밀번호</h3><p>별칭: <code>${esc(r.alias)}</code></p><p>비밀번호: <code class="copy" data-copy="${esc(r.password)}">${esc(r.password)}</code></p><div class="modal-actions"><button class="btn" onclick="closeModal()">닫기</button></div>`); $$("[data-copy]").forEach((el) => (el.onclick = () => { navigator.clipboard?.writeText(el.dataset.copy); toast("복사했습니다"); })); }
    catch (e) { toast(e.message, true); }
  };
  const del = $("#ksDelete"); if (del) del.onclick = async () => {
    if (!confirm("키스토어를 삭제하면 같은 서명으로 업그레이드할 수 없습니다. 백업을 받았나요? 정말 삭제할까요?")) return;
    try { await api("POST", `/projects/${S.pid}/keystore`, { action: "delete" }); await refreshProject(); render(); } catch (e) { toast(e.message, true); }
  };
  const bb = $("#btnBuild"); if (bb) bb.onclick = runBuild;
}

async function runBuild() {
  if (!S.env?.ready) { toast("필수 도구가 준비되지 않았습니다", true); return showEnv(); }
  if (S.dirty && !(await saveCfg())) return;
  const b = S.build;
  Object.assign(b, { running: true, lines: [], steps: [], status: "" });
  S.tab = "build"; render();
  try {
    const { job } = await api("POST", `/projects/${S.pid}/build`);
    const j = await watchJob(job, (u) => {
      b.steps = u.steps;
      const log = $("#buildLog");
      u.lines.forEach((l) => { b.lines.push(l); if (log) log.insertAdjacentHTML("beforeend", logLine(l)); });
      if (log) log.scrollTop = log.scrollHeight;
      const st = $("#stepper"); if (st) st.innerHTML = u.steps.map((s) => `<span class="step ${s.status}">${esc(s.name)}</span>`).join("");
    });
    b.status = j.status;
    if (j.status === "error") toast("빌드 실패", true); else toast("빌드·검증 완료");
  } catch (e) { b.status = "error"; toast(e.message, true); }
  b.running = false;
  await refreshProject(); await loadProjects(); renderSide();
  if (S.tab === "build") render();
}

init();
