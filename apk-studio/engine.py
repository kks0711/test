"""APK Studio 엔진 — APK 해체(apktool) → 패치 → 재빌드 → 정렬 → 서명 → 검증.

표준 라이브러리만 사용한다. 외부 도구는 JDK(java/keytool/jarsigner)와 apktool 뿐이다.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import ssl
import struct
import subprocess
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKSPACE = Path(os.environ.get("APK_STUDIO_WORKSPACE", ROOT / "workspace"))
TOOLS = ROOT / "tools"
SIGNER_JAVA = ROOT / "signer" / "ApkSignV2.java"

APKTOOL_VERSION = "3.0.3"
APKTOOL_JAR = TOOLS / f"apktool-cli-{APKTOOL_VERSION}.jar"
APKTOOL_URL = (
    f"https://repo1.maven.org/maven2/org/apktool/apktool-cli/{APKTOOL_VERSION}/"
    f"apktool-cli-{APKTOOL_VERSION}.jar"
)

ANDROID_NS = "http://schemas.android.com/apk/res/android"
DENSITIES = {"ldpi": 36, "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
TEXT_EXT = {".html", ".htm", ".js", ".css", ".json", ".txt", ".less", ".svg", ".xml", ".md"}
EDITABLE_MAX = 4 * 1024 * 1024
NOISE = ("Picked up JAVA_TOOL_OPTIONS", "Picked up _JAVA_OPTIONS")


class StudioError(Exception):
    pass


# ----------------------------------------------------------------------------
# 작업(Job) — 긴 작업을 백그라운드 스레드로 돌리고 로그를 폴링으로 읽는다
# ----------------------------------------------------------------------------
class Job:
    def __init__(self, title: str, steps: list[str] | None = None):
        self.id = secrets.token_hex(6)
        self.title = title
        self.status = "running"  # running | done | error
        self.steps = [{"name": s, "status": "pending"} for s in (steps or [])]
        self.lines: list[str] = []
        self.result: dict | None = None
        self.error: str | None = None
        self.started = time.time()
        self.finished: float | None = None
        self._lock = threading.Lock()

    def log(self, line: str):
        line = line.rstrip("\n")
        if not line or any(n in line for n in NOISE):
            return
        with self._lock:
            self.lines.append(line)

    def step(self, name: str, status: str = "running"):
        with self._lock:
            for s in self.steps:
                if s["name"] == name:
                    s["status"] = status
                elif status == "running" and s["status"] == "running":
                    s["status"] = "done"

    def snapshot(self, since: int = 0) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "title": self.title,
                "status": self.status,
                "steps": [dict(s) for s in self.steps],
                "lines": self.lines[since:],
                "next": len(self.lines),
                "result": self.result,
                "error": self.error,
                "elapsed": round((self.finished or time.time()) - self.started, 1),
            }


JOBS: dict[str, Job] = {}


def start_job(job: Job, fn, *args) -> Job:
    JOBS[job.id] = job

    def runner():
        try:
            job.result = fn(job, *args)
            job.status = "done"
            for s in job.steps:
                if s["status"] in ("running", "pending"):
                    s["status"] = "done"
        except Exception as e:  # noqa: BLE001
            job.status = "error"
            job.error = str(e)
            job.log(f"✗ 실패: {e}")
            for s in job.steps:
                if s["status"] == "running":
                    s["status"] = "error"
        finally:
            job.finished = time.time()

    threading.Thread(target=runner, daemon=True).start()
    return job


def run(cmd: list[str], job: Job | None = None, cwd: Path | None = None, env: dict | None = None,
        quiet_prefixes: tuple[str, ...] = ()) -> tuple[int, str]:
    """명령을 실행하며 출력을 job 로그로 흘린다. (returncode, 전체 출력) 반환."""
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    proc = subprocess.Popen(cmd, cwd=cwd, env=full_env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, errors="replace")
    out, suppressed = [], 0
    assert proc.stdout
    for line in proc.stdout:
        out.append(line)
        if any(n in line for n in NOISE):
            continue
        if quiet_prefixes and line.startswith(quiet_prefixes):
            suppressed += 1
            continue
        if job:
            job.log(line)
    proc.wait()
    if suppressed and job:
        job.log(f"  (반복 경고 {suppressed}건 생략)")
    return proc.returncode, "".join(out)


# ----------------------------------------------------------------------------
# 도구 점검
# ----------------------------------------------------------------------------
def _java_version() -> str | None:
    java = shutil.which("java")
    if not java:
        return None
    try:
        p = subprocess.run([java, "-version"], capture_output=True, text=True, timeout=20)
        text = (p.stderr or p.stdout)
        for line in text.splitlines():
            if "version" in line and not any(n in line for n in NOISE):
                return line.strip()
    except Exception:  # noqa: BLE001
        pass
    return "unknown"


def _sdk_tool(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        base = os.environ.get(var)
        if base:
            cands = sorted(Path(base, "build-tools").glob(f"*/{name}*"), reverse=True)
            if cands:
                return str(cands[0])
    return None


def apktool_cmd() -> list[str]:
    if APKTOOL_JAR.exists():
        return ["java", "-jar", str(APKTOOL_JAR)]
    env_jar = os.environ.get("APKTOOL_JAR")
    if env_jar and Path(env_jar).exists():
        return ["java", "-jar", env_jar]
    exe = shutil.which("apktool")
    if exe:
        return [exe]
    raise StudioError("apktool 이 없습니다. 대시보드의 '환경 점검 → 도구 설치'를 먼저 실행하세요.")


def tools_status() -> dict:
    java = _java_version()
    has_apktool = APKTOOL_JAR.exists() or bool(os.environ.get("APKTOOL_JAR")) or bool(shutil.which("apktool"))
    items = [
        {"key": "java", "label": "Java (JDK 11+)", "ok": bool(java and shutil.which("keytool")),
         "detail": java or "java 없음",
         "fix": "JDK 17 이상 설치 (예: sudo apt install default-jdk / brew install openjdk / Windows: Temurin JDK)"},
        {"key": "jarsigner", "label": "jarsigner (v1 서명)", "ok": bool(shutil.which("jarsigner")),
         "detail": shutil.which("jarsigner") or "없음", "fix": "JRE가 아닌 JDK 를 설치하세요"},
        {"key": "apktool", "label": f"apktool {APKTOOL_VERSION}", "ok": has_apktool,
         "detail": str(APKTOOL_JAR) if APKTOOL_JAR.exists() else ("PATH/APKTOOL_JAR" if has_apktool else "미설치"),
         "fix": "'도구 설치' 버튼으로 Maven Central 에서 자동 다운로드", "installable": True},
        {"key": "zipalign", "label": "zipalign (선택)", "ok": True,
         "detail": _sdk_tool("zipalign") or "내장 파이썬 정렬기 사용",
         "fix": "필요 없음 — 없으면 내장 정렬기가 대신합니다"},
        {"key": "apksigner", "label": "apksigner (선택, 교차 검증용)", "ok": True,
         "detail": _sdk_tool("apksigner") or "없음 — 내장 검증기 사용",
         "fix": "Android SDK build-tools 가 있으면 자동으로 추가 검증에 사용"},
    ]
    required_ok = all(i["ok"] for i in items if i["key"] in ("java", "jarsigner", "apktool"))
    return {"ready": required_ok, "items": items, "workspace": str(WORKSPACE)}


def install_tools(job: Job) -> dict:
    TOOLS.mkdir(parents=True, exist_ok=True)
    if APKTOOL_JAR.exists():
        job.log(f"apktool 이미 설치됨: {APKTOOL_JAR}")
        return {"installed": True}
    job.log(f"apktool {APKTOOL_VERSION} 다운로드: {APKTOOL_URL}")
    tmp = APKTOOL_JAR.with_suffix(".part")
    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(APKTOOL_URL, timeout=120, context=ctx) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
    except Exception as e:  # noqa: BLE001
        job.log(f"urllib 실패({e}) → curl 로 재시도")
        curl = shutil.which("curl")
        if not curl:
            raise StudioError(f"다운로드 실패: {e}")
        rc, _ = run([curl, "-fsSL", "-o", str(tmp), APKTOOL_URL], job)
        if rc != 0:
            raise StudioError("curl 다운로드 실패")
    if tmp.stat().st_size < 1_000_000:
        tmp.unlink(missing_ok=True)
        raise StudioError("다운로드한 파일이 비정상적으로 작습니다")
    tmp.rename(APKTOOL_JAR)
    job.log(f"✓ 설치 완료 ({APKTOOL_JAR.stat().st_size // 1024} KB)")
    return {"installed": True}


# ----------------------------------------------------------------------------
# 프로젝트 저장소
# ----------------------------------------------------------------------------
def default_config() -> dict:
    return {
        "appName": "rea",
        "packageName": "com.rea.app",
        "versionName": "",
        "versionCode": 0,
        "stripSplitRequired": True,
        "stripStoreMeta": True,
        "removePermissions": [],
        "debuggable": False,
        "replaceNameInWww": True,
        "swing": {"enabled": True, "syncPackage": True, "syncVersion": True,
                  "appId": "", "onsAppId": "", "senderID": ""},
        "rules": [],
        "customCss": "",
        "customJs": "",
    }


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "app"


def pdir(pid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9\-]{3,40}", pid or ""):
        raise StudioError("잘못된 프로젝트 ID")
    p = WORKSPACE / pid
    if not p.is_dir():
        raise StudioError("프로젝트를 찾을 수 없습니다")
    return p


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def list_projects() -> list[dict]:
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    out = []
    for d in sorted(WORKSPACE.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = read_json(d / "meta.json")
        if meta:
            cfg = read_json(d / "config.json", {})
            out.append({**meta, "appName": cfg.get("appName"), "packageName": cfg.get("packageName"),
                        "decoded": (d / "decoded" / "AndroidManifest.xml").exists(),
                        "builds": len(list((d / "out").glob("*.apk"))) if (d / "out").exists() else 0})
    return out


def create_project(source: Path, display_name: str, copy_config_from: str | None = None) -> tuple[str, Job]:
    if not zipfile.is_zipfile(source):
        raise StudioError("올바른 APK(zip) 파일이 아닙니다")
    with zipfile.ZipFile(source) as z:
        if "AndroidManifest.xml" not in z.namelist():
            raise StudioError("AndroidManifest.xml 이 없습니다 — APK가 아닌 것 같습니다 (AAB/XAPK는 base APK만 지원)")
    pid = f"{_slug(Path(display_name).stem)[:20]}-{secrets.token_hex(3)}"
    d = WORKSPACE / pid
    d.mkdir(parents=True)
    shutil.copyfile(source, d / "source.apk")
    sha = hashlib.sha256((d / "source.apk").read_bytes()).hexdigest()
    write_json(d / "meta.json", {"id": pid, "sourceName": display_name, "created": int(time.time()),
                                 "sourceSha256": sha, "sourceSize": (d / "source.apk").stat().st_size})
    cfg = default_config()
    if copy_config_from:
        prev = read_json(pdir(copy_config_from) / "config.json")
        if prev:
            cfg.update(prev)
    write_json(d / "config.json", cfg)
    job = start_job(Job("APK 해체·분석", ["해체", "분석"]), _decode_job, pid)
    return pid, job


def _decode_job(job: Job, pid: str) -> dict:
    d = pdir(pid)
    job.step("해체")
    job.log(f"apktool d → {d / 'decoded'}")
    shutil.rmtree(d / "decoded", ignore_errors=True)
    rc, out = run(apktool_cmd() + ["d", "-f", "-o", str(d / "decoded"), str(d / "source.apk")], job,
                  quiet_prefixes=("W: Unresolved resource reference",))
    if rc != 0 or not (d / "decoded" / "AndroidManifest.xml").exists():
        raise StudioError("apktool 해체 실패 — 위 로그를 확인하세요")
    job.step("분석")
    analysis = analyze(pid)
    write_json(d / "analysis.json", analysis)
    cfg = read_json(d / "config.json", default_config())
    # 처음 분석한 값으로 빈 칸 채우기
    cfg["versionName"] = cfg.get("versionName") or analysis["versionName"]
    cfg["versionCode"] = cfg.get("versionCode") or analysis["versionCode"]
    sw = analysis.get("swing") or {}
    for k in ("appId", "onsAppId", "senderID"):
        cfg["swing"][k] = cfg["swing"].get(k) or sw.get(k, "")
    write_json(d / "config.json", cfg)
    job.log(f"✓ 분석 완료: {analysis['label']} ({analysis['package']}) v{analysis['versionName']}")
    return {"project": pid}


def delete_project(pid: str):
    shutil.rmtree(pdir(pid))


# ----------------------------------------------------------------------------
# 분석
# ----------------------------------------------------------------------------
def _strings(decoded: Path) -> dict[str, str]:
    p = decoded / "res" / "values" / "strings.xml"
    out = {}
    if p.exists():
        try:
            for el in ET.parse(p).getroot().iter("string"):
                out[el.get("name")] = "".join(el.itertext())
        except ET.ParseError:
            pass
    return out


def _a(name: str) -> str:
    return "{%s}%s" % (ANDROID_NS, name)


def analyze(pid: str) -> dict:
    d = pdir(pid)
    dec = d / "decoded"
    root = ET.parse(dec / "AndroidManifest.xml").getroot()
    app = root.find("application")
    pkg = root.get("package", "")
    strings = _strings(dec)
    label = (app.get(_a("label")) if app is not None else "") or ""
    if label.startswith("@string/"):
        label = strings.get(label[8:], label)

    yml = (dec / "apktool.yml").read_text(encoding="utf-8")

    def yml_val(key):
        m = re.search(rf"^\s*{key}:\s*'?([^'\n]+)'?\s*$", yml, re.M)
        return m.group(1).strip() if m else ""

    perms = sorted({e.get(_a("name")) for e in root.findall("uses-permission") if e.get(_a("name"))})
    metas = [m.get(_a("name")) for m in app.iter("meta-data")] if app is not None else []
    comps = {t: len(app.findall(t)) if app is not None else 0 for t in ("activity", "service", "receiver", "provider")}

    www = dec / "assets" / "www"
    plugins = sorted(p.name for p in (www / "plugins").iterdir()) if (www / "plugins").is_dir() else []
    main_js = www / "build" / "main.min.js"
    swing = {}
    if main_js.exists():
        txt = main_js.read_text(encoding="utf-8", errors="replace")
        for key in ("appId", "onsAppId", "senderID", "versionValue", "packageId", "bundleId",
                    "engineVersionValue", "productType"):
            m = re.search(rf'swingAppInfo\.{key}="([^"]*)"', txt)
            if m:
                swing[key] = m.group(1)
    kind = "native"
    if www.is_dir():
        kind = "cordova"
    if swing.get("appId"):
        kind = "swing2app"

    # 서명 인증서
    cert = {}
    try:
        p = subprocess.run(["keytool", "-printcert", "-jarfile", str(d / "source.apk")],
                           capture_output=True, text=True, timeout=60)
        txt = p.stdout
        m = re.search(r"Owner: (.+)", txt)
        cert["owner"] = m.group(1).strip() if m else ""
        m = re.search(r"SHA256: ([0-9A-F:]+)", txt)
        cert["sha256"] = m.group(1) if m else ""
        m = re.search(r"Valid from: (.+)", txt)
        cert["valid"] = m.group(1).strip() if m else ""
    except Exception:  # noqa: BLE001
        pass

    icons = {dn: (dec / "res" / f"mipmap-{dn}" / "ic_launcher.png").exists() for dn in DENSITIES}
    old_name_hits = 0
    if www.is_dir() and label:
        for f in www.rglob("*"):
            if f.suffix in {".html", ".js", ".json"} and f.is_file() and f.stat().st_size < EDITABLE_MAX:
                old_name_hits += f.read_text(encoding="utf-8", errors="ignore").count(label)

    a = {
        "label": label or pkg, "package": pkg, "kind": kind,
        "versionName": yml_val("versionName"), "versionCode": int(yml_val("versionCode") or 0),
        "minSdk": yml_val("minSdkVersion"), "targetSdk": yml_val("targetSdkVersion"),
        "permissions": perms, "components": comps, "plugins": plugins, "swing": swing,
        "cert": cert, "icons": icons, "size": (d / "source.apk").stat().st_size,
        "sha256": read_json(d / "meta.json", {}).get("sourceSha256", ""),
        "splitRequired": bool(app is not None and app.get(_a("isSplitRequired")) == "true"),
        "hasStoreMeta": any(m and (m.startswith("com.android.vending.") or m.startswith("com.android.stamp.")) for m in metas),
        "firebase": any("firebase" in (m or "") for m in metas) or (dec / "res" / "values" / "strings.xml").read_text(
            encoding="utf-8", errors="ignore").find("google_app_id") >= 0,
        "hasOneSignal": bool(app is not None and any("onesignal" in (c.get(_a("name")) or "") for c in app.iter())),
        "nameHitsInWww": old_name_hits,
    }
    a["risks"] = risk_report(a)
    return a


def risk_report(a: dict) -> list[dict]:
    r = []

    def add(level, title, detail):
        r.append({"level": level, "title": title, "detail": detail})

    if a["splitRequired"]:
        add("fix", "원본은 '스플릿 필수' APK입니다",
            "AndroidManifest 에 isSplitRequired=true 가 있어 이 APK만 설치하면 실패합니다. "
            "복제 시 자동으로 제거합니다 (옵션 '스플릿 필수 해제').")
    if a["hasStoreMeta"]:
        add("fix", "Play 스토어 배포용 메타데이터가 들어 있습니다",
            "com.android.vending.* / com.android.stamp.* 항목은 복제본에서 의미가 없어 제거를 권장합니다.")
    add("info", "서명이 달라집니다",
        "복제본은 새 키로 서명됩니다. 원본 앱과 별개의 앱으로 나란히 설치되며, 원본 위에 덮어쓰기 업데이트는 되지 않습니다. "
        "이후 '업그레이드'가 설치되려면 항상 같은 키스토어로 서명하고 versionCode 를 올려야 합니다 — 키스토어를 꼭 백업하세요.")
    if a["kind"] == "swing2app":
        sw = a["swing"]
        add("warn", "Swing2App 서버와 연결된 앱입니다",
            f"메뉴·게시판·회원 정보는 Swing2App 서버(appId {sw.get('appId', '?')})에서 내려옵니다. "
            "appId 를 그대로 두면 복제본은 원본과 같은 데이터를 보여주고 같은 서버 계정을 공유합니다. "
            "독립된 앱으로 키우려면 Swing2App 에서 새 앱을 만든 뒤 appId/onsAppId/senderID 를 '업그레이드' 탭에서 바꾸세요.")
        add("warn", "앱 내 www 파일이 서버 핫업데이트로 덮어써질 수 있습니다",
            "index.html 은 contentsync 로 받아 둔 경로(path)가 있으면 그쪽을 먼저 로드합니다. "
            "로컬에서 수정한 화면이 사라지면 Swing2App 쪽 설정/콘텐츠 동기화를 확인하세요.")
    if a["hasOneSignal"] or a["firebase"]:
        add("warn", "푸시 알림(FCM/OneSignal)은 패키지명에 묶여 있습니다",
            "패키지명이 바뀌면 원래 Firebase 프로젝트의 google-services 설정과 맞지 않습니다. "
            "새 패키지명을 Firebase 콘솔에 앱으로 등록하고(필요시 SHA-1 포함) OneSignal 설정도 갱신해야 푸시가 안정적으로 옵니다.")
    plugs = set(a["plugins"])
    if "cordova-plugin-purchase" in plugs:
        add("warn", "인앱 결제 플러그인이 포함되어 있습니다",
            "Google Play 결제는 패키지명·서명키·Play Console 등록에 묶여 있어 복제본에서는 동작하지 않습니다.")
    if True:
        add("info", "소셜 로그인 키 해시 / 딥링크",
            "카카오·페이스북·라인 등 로그인은 (패키지명 + 서명 키 해시)를 각 개발자 콘솔에 등록해야 동작합니다. "
            "빌드 탭의 SHA-1 / SHA-256 지문과 키 해시를 사용하세요.")
    add("info", "권리 확인",
        "복제·재배포는 본인이 소유했거나 변경 권한이 있는 앱에만 사용하세요. "
        "원본의 서버 키·로고·콘텐츠를 그대로 가져가는 복제본은 상표/저작권/약관 문제가 될 수 있습니다.")
    return r


# ----------------------------------------------------------------------------
# 설정 / 파일 편집
# ----------------------------------------------------------------------------
PKG_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")


def validate_config(cfg: dict) -> dict:
    base = default_config()
    base.update({k: v for k, v in cfg.items() if k in base})
    sw = default_config()["swing"]
    sw.update(cfg.get("swing") or {})
    base["swing"] = sw
    if not str(base["appName"]).strip():
        raise StudioError("앱 이름이 비어 있습니다")
    if not PKG_RE.match(str(base["packageName"])):
        raise StudioError("패키지명 형식이 올바르지 않습니다 (예: com.rea.app — 소문자/숫자/_ 와 점 2단계 이상)")
    try:
        base["versionCode"] = int(base["versionCode"])
    except (TypeError, ValueError):
        raise StudioError("versionCode 는 정수여야 합니다")
    if base["versionCode"] < 1 or base["versionCode"] > 2_100_000_000:
        raise StudioError("versionCode 범위 오류")
    if not re.fullmatch(r"[0-9A-Za-z._+\-]{1,30}", str(base["versionName"]).strip()):
        raise StudioError("versionName 은 영문/숫자/점/하이픈만 사용할 수 있습니다 (예: 1.4.0)")
    base["versionName"] = str(base["versionName"]).strip()
    rules = []
    for r in base.get("rules") or []:
        if not str(r.get("find", "")):
            continue
        rule = {"find": str(r["find"]), "replace": str(r.get("replace", "")),
                "regex": bool(r.get("regex")), "enabled": r.get("enabled", True) is not False}
        if rule["regex"]:
            try:
                re.compile(rule["find"])
            except re.error as e:
                raise StudioError(f"정규식 오류 ({rule['find']}): {e}")
        rules.append(rule)
    base["rules"] = rules
    base["removePermissions"] = [str(p) for p in base.get("removePermissions") or []]
    return base


def get_config(pid: str) -> dict:
    return read_json(pdir(pid) / "config.json", default_config())


def save_config(pid: str, cfg: dict) -> dict:
    clean = validate_config(cfg)
    write_json(pdir(pid) / "config.json", clean)
    return clean


def _safe_rel(d: Path, rel: str, base: str = "decoded") -> Path:
    rel = (rel or "").lstrip("/")
    root = (d / base).resolve()
    p = (root / rel).resolve()
    if root != p and root not in p.parents:
        raise StudioError("경로가 허용 범위를 벗어났습니다")
    return p


def tree(pid: str, rel: str) -> dict:
    d = pdir(pid)
    base = _safe_rel(d, rel)
    ov = d / "overlay"
    if not base.is_dir():
        raise StudioError("폴더가 아닙니다")
    items = []
    for c in sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        relp = str(c.relative_to(d / "decoded")).replace(os.sep, "/")
        items.append({"name": c.name, "path": relp, "dir": c.is_dir(),
                      "size": c.stat().st_size if c.is_file() else None,
                      "text": c.suffix.lower() in TEXT_EXT,
                      "modified": (ov / relp).exists()})
    return {"path": str(base.relative_to(d / "decoded")).replace(os.sep, "/") if base != (d / "decoded").resolve() else "",
            "items": items}


def read_file(pid: str, rel: str) -> dict:
    d = pdir(pid)
    src = _safe_rel(d, rel)
    ov = _safe_rel(d, rel, "overlay")
    use = ov if ov.exists() else src
    if not use.is_file():
        raise StudioError("파일이 없습니다")
    if use.stat().st_size > EDITABLE_MAX:
        raise StudioError("4MB 를 넘는 파일은 편집기에서 열 수 없습니다")
    if use.suffix.lower() not in TEXT_EXT:
        raise StudioError("텍스트 파일만 편집할 수 있습니다 (이미지는 '파일 교체' 사용)")
    return {"path": rel, "text": use.read_text(encoding="utf-8", errors="replace"),
            "modified": ov.exists(), "size": use.stat().st_size}


def write_file(pid: str, rel: str, text: str | None = None, b64: str | None = None):
    d = pdir(pid)
    src = _safe_rel(d, rel)
    if not src.exists():
        raise StudioError("원본에 없는 파일은 교체할 수 없습니다 (새 파일 추가는 지원하지 않음)")
    if src.parts[-1] == "AndroidManifest.xml" or str(src).endswith("apktool.yml"):
        raise StudioError("매니페스트/apktool.yml 은 '복제' 탭의 옵션으로만 바꿀 수 있습니다")
    ov = _safe_rel(d, rel, "overlay")
    ov.parent.mkdir(parents=True, exist_ok=True)
    if b64 is not None:
        ov.write_bytes(base64.b64decode(b64))
    else:
        ov.write_text(text or "", encoding="utf-8", newline="")


def revert_file(pid: str, rel: str):
    ov = _safe_rel(pdir(pid), rel, "overlay")
    if ov.exists():
        ov.unlink()


def overlay_list(pid: str) -> list[str]:
    ov = pdir(pid) / "overlay"
    if not ov.exists():
        return []
    return sorted(str(p.relative_to(ov)).replace(os.sep, "/") for p in ov.rglob("*") if p.is_file())


def save_icons(pid: str, pngs: dict[str, str]):
    d = pdir(pid) / "icons"
    d.mkdir(exist_ok=True)
    for dens, b64 in pngs.items():
        if dens not in DENSITIES:
            raise StudioError(f"알 수 없는 밀도: {dens}")
        raw = base64.b64decode(b64.split(",", 1)[-1])
        if raw[:8] != b"\x89PNG\r\n\x1a\n":
            raise StudioError("PNG 가 아닙니다")
        (d / f"{dens}.png").write_bytes(raw)


def clear_icons(pid: str):
    shutil.rmtree(pdir(pid) / "icons", ignore_errors=True)


def icon_status(pid: str) -> list[str]:
    d = pdir(pid) / "icons"
    return sorted(p.stem for p in d.glob("*.png")) if d.exists() else []


def _text_files(www: Path):
    for f in www.rglob("*"):
        if f.is_file() and f.suffix.lower() in TEXT_EXT and f.stat().st_size <= 6 * 1024 * 1024:
            yield f


def _apply_rule(rule: dict, text: str) -> tuple[str, int]:
    if rule["regex"]:
        return re.subn(rule["find"], rule["replace"], text)
    n = text.count(rule["find"])
    return (text.replace(rule["find"], rule["replace"]) if n else text), n


def preview_rules(pid: str, rules: list[dict]) -> list[dict]:
    d = pdir(pid)
    www = d / "decoded" / "assets" / "www"
    ov = d / "overlay" / "assets" / "www"
    out = []
    for i, r in enumerate(rules):
        rule = {"find": str(r.get("find", "")), "replace": str(r.get("replace", "")), "regex": bool(r.get("regex"))}
        if not rule["find"]:
            out.append({"index": i, "total": 0, "files": []})
            continue
        if rule["regex"]:
            try:
                re.compile(rule["find"])
            except re.error as e:
                out.append({"index": i, "error": str(e), "total": 0, "files": []})
                continue
        total, files = 0, []
        for f in _text_files(www):
            rel = f.relative_to(www)
            use = ov / rel if (ov / rel).exists() else f
            _, n = _apply_rule(rule, use.read_text(encoding="utf-8", errors="ignore"))
            if n:
                total += n
                files.append({"file": str(rel).replace(os.sep, "/"), "count": n})
        out.append({"index": i, "total": total, "files": files[:30]})
    return out


# ----------------------------------------------------------------------------
# 패치 (작업 디렉터리에 적용)
# ----------------------------------------------------------------------------
def _aapt_escape(s: str) -> str:
    s = s.replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"')
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if s[:1] in ("@", "?"):
        s = "\\" + s
    return s


CLASS_ATTRS = {_a("parentActivityName"), _a("targetActivity"), _a("manageSpaceActivity")}
COMPONENT_TAGS = {"activity", "activity-alias", "service", "receiver", "provider", "application", "instrumentation"}
STORE_META = ("com.android.vending.", "com.android.stamp.")


def patch_manifest(path: Path, cfg: dict, old_pkg: str, log) -> None:
    ET.register_namespace("android", ANDROID_NS)
    ET.register_namespace("tools", "http://schemas.android.com/tools")
    ET.register_namespace("dist", "http://schemas.android.com/apk/distribution")
    tree = ET.parse(path)
    root = tree.getroot()
    new_pkg = cfg["packageName"]
    root.set("package", new_pkg)
    log(f"  package: {old_pkg} → {new_pkg}")

    changed = 0
    for el in root.iter():
        for k, v in list(el.attrib.items()):
            if old_pkg not in v or k == "package":
                continue
            if k == _a("name") and el.tag in COMPONENT_TAGS:
                continue  # 클래스 경로는 그대로 (스말리 코드가 옛 패키지 경로에 있음)
            if k in CLASS_ATTRS:
                continue
            el.set(k, v.replace(old_pkg, new_pkg))
            changed += 1
    log(f"  패키지명이 박힌 권한/authority/카테고리 {changed}곳 교체 (컴포넌트 클래스명은 유지)")

    app = root.find("application")
    if cfg.get("stripSplitRequired"):
        for el in (root, app):
            if el is None:
                continue
            for k in ("isSplitRequired", "requiredSplitTypes", "splitTypes"):
                if _a(k) in el.attrib:
                    del el.attrib[_a(k)]
                    log(f"  제거: {k}")
        if root.get("split") is not None:
            del root.attrib["split"]
    if cfg.get("stripStoreMeta") and app is not None:
        for m in list(app.findall("meta-data")):
            n = m.get(_a("name")) or ""
            if n.startswith(STORE_META):
                app.remove(m)
                log(f"  제거: meta-data {n}")
    removed = set(cfg.get("removePermissions") or [])
    if removed:
        for tag in ("uses-permission", "uses-permission-sdk-23"):
            for p in list(root.findall(tag)):
                if p.get(_a("name")) in removed:
                    root.remove(p)
                    log(f"  권한 제거: {p.get(_a('name'))}")
    if app is not None:
        if cfg.get("debuggable"):
            app.set(_a("debuggable"), "true")
        elif _a("debuggable") in app.attrib:
            del app.attrib[_a("debuggable")]
    tree.write(path, encoding="utf-8", xml_declaration=True)


def patch_yml(path: Path, cfg: dict, log) -> None:
    txt = path.read_text(encoding="utf-8")
    # apktool 3 의 자체 YAML 리더는 따옴표 없는 값만 읽는다
    txt, n1 = re.subn(r"^(\s*versionCode:).*$", rf"\1 {cfg['versionCode']}", txt, flags=re.M)
    txt, n2 = re.subn(r"^(\s*versionName:).*$", rf"\1 {cfg['versionName']}", txt, flags=re.M)
    if not (n1 and n2):
        raise StudioError("apktool.yml 에서 versionInfo 를 찾지 못했습니다")
    path.write_text(txt, encoding="utf-8")
    log(f"  version: {cfg['versionName']} ({cfg['versionCode']})")


def patch_strings(work: Path, cfg: dict, log) -> None:
    p = work / "res" / "values" / "strings.xml"
    txt = p.read_text(encoding="utf-8")
    new, n = re.subn(r'(<string name="app_name"[^>]*>).*?(</string>)',
                     lambda m: m.group(1) + _aapt_escape(cfg["appName"]) + m.group(2), txt, flags=re.S)
    if not n:
        raise StudioError("strings.xml 에서 app_name 을 찾지 못했습니다")
    p.write_text(new, encoding="utf-8")
    log(f"  app_name → {cfg['appName']}")
    for extra in (work / "res").glob("values-*/strings.xml"):
        t = extra.read_text(encoding="utf-8")
        t2, k = re.subn(r'(<string name="app_name"[^>]*>).*?(</string>)',
                        lambda m: m.group(1) + _aapt_escape(cfg["appName"]) + m.group(2), t, flags=re.S)
        if k:
            extra.write_text(t2, encoding="utf-8")
            log(f"  app_name → {extra.parent.name}")


def patch_config_xml(work: Path, cfg: dict, old_pkg: str, log) -> None:
    for p in (work / "res").glob("xml*/config.xml"):
        t = p.read_text(encoding="utf-8")
        t = t.replace(f'<widget id="{old_pkg}"', f'<widget id="{cfg["packageName"]}"')
        t = re.sub(r'(<widget id="[^"]*" version=")[^"]*(")', lambda m: m.group(1) + cfg["versionName"] + m.group(2), t, count=1)
        p.write_text(t, encoding="utf-8")
    log("  Cordova config.xml widget id/version 갱신")


def patch_swing(work: Path, cfg: dict, analysis: dict, log) -> None:
    js = work / "assets" / "www" / "build" / "main.min.js"
    if not js.exists() or not cfg["swing"].get("enabled") or analysis["kind"] != "swing2app":
        return
    txt = js.read_text(encoding="utf-8")
    sw = cfg["swing"]
    sets = {"appId": sw.get("appId"), "onsAppId": sw.get("onsAppId"), "senderID": sw.get("senderID")}
    if sw.get("syncPackage"):
        sets["packageId"] = cfg["packageName"]
        sets["bundleId"] = cfg["packageName"]
    if sw.get("syncVersion"):
        sets["versionValue"] = cfg["versionName"]
    for k, v in sets.items():
        if v is None or v == "":
            continue
        txt, n = re.subn(rf'(swingAppInfo\.{k}=")[^"]*(")', lambda m, v=v: m.group(1) + str(v).replace('"', '') + m.group(2), txt)
        if n:
            log(f"  swingAppInfo.{k} = {v}")
    js.write_text(txt, encoding="utf-8")


def patch_www(work: Path, cfg: dict, analysis: dict, log) -> None:
    www = work / "assets" / "www"
    if not www.is_dir():
        return
    rules = [r for r in cfg["rules"] if r["enabled"]]
    old = analysis.get("label") or ""
    if cfg.get("replaceNameInWww") and old and old != cfg["appName"]:
        rules = [{"find": old, "replace": cfg["appName"], "regex": False, "enabled": True}] + rules
    for r in rules:
        total = 0
        for f in _text_files(www):
            t = f.read_text(encoding="utf-8", errors="surrogateescape")
            t2, n = _apply_rule(r, t)
            if n:
                f.write_text(t2, encoding="utf-8", errors="surrogateescape")
                total += n
        log(f"  규칙 '{r['find'][:40]}' → '{r['replace'][:40]}' : {total}건")

    main = www / "main.html"
    if main.exists():
        t = main.read_text(encoding="utf-8")
        if cfg.get("customCss", "").strip():
            block = f'<style id="studio_custom_css">\n{cfg["customCss"]}\n</style>\n'
            t = t.replace("</head>", block + "</head>", 1) if "</head>" in t else t + block
            log("  사용자 CSS 주입")
        if cfg.get("customJs", "").strip():
            block = f'<script id="studio_custom_js">\n{cfg["customJs"]}\n</script>\n'
            t = t.replace("</body>", block + "</body>", 1) if "</body>" in t else t + block
            log("  사용자 JS 주입")
        main.write_text(t, encoding="utf-8")


def apply_overlay(pdir_: Path, work: Path, log) -> None:
    ov = pdir_ / "overlay"
    if ov.exists():
        for f in ov.rglob("*"):
            if f.is_file():
                rel = f.relative_to(ov)
                dst = work / rel
                if dst.exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(f, dst)
                    log(f"  편집 반영: {str(rel).replace(os.sep, '/')}")
    ic = pdir_ / "icons"
    if ic.exists():
        for f in ic.glob("*.png"):
            dst = work / "res" / f"mipmap-{f.stem}" / "ic_launcher.png"
            if dst.exists():
                shutil.copyfile(f, dst)
                log(f"  아이콘 교체: mipmap-{f.stem}")


# ----------------------------------------------------------------------------
# 정렬(zipalign) — 시스템 zipalign 이 없을 때의 내장 구현
# ----------------------------------------------------------------------------
def align_zip(src: Path, dst: Path, alignment: int = 4) -> None:
    """STORED 항목의 데이터 시작 위치를 alignment 바이트 경계에 맞춘다."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w") as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            ni = zipfile.ZipInfo(info.filename, info.date_time)
            ni.compress_type = info.compress_type
            ni.external_attr = info.external_attr
            ni.create_system = info.create_system
            if info.is_dir():
                zout.writestr(ni, b"")
                continue
            if info.compress_type == zipfile.ZIP_STORED:
                name_len = len(ni.filename.encode("utf-8") if any(ord(c) > 127 for c in ni.filename) else ni.filename.encode("ascii"))
                header_end = zout.fp.tell() + 30 + name_len
                pad = (-header_end) % alignment
                if pad:
                    if pad < 4:
                        pad += alignment
                    ni.extra = struct.pack("<HH", 0xD935, pad - 4) + b"\x00" * (pad - 4)
            zout.writestr(ni, data)


def check_aligned(apk: Path, alignment: int = 4) -> list[str]:
    bad = []
    with zipfile.ZipFile(apk) as z, open(apk, "rb") as f:
        for info in z.infolist():
            if info.compress_type != zipfile.ZIP_STORED or info.is_dir():
                continue
            f.seek(info.header_offset)
            hdr = f.read(30)
            n, m = struct.unpack("<HH", hdr[26:30])
            if (info.header_offset + 30 + n + m) % alignment:
                bad.append(info.filename)
    return bad


# ----------------------------------------------------------------------------
# 키스토어
# ----------------------------------------------------------------------------
def keystore_info(pid: str) -> dict | None:
    d = pdir(pid)
    meta = read_json(d / "keystore.json")
    if not meta or not (d / "keystore.p12").exists():
        return None
    out = {"alias": meta["alias"], "dname": meta.get("dname", ""), "created": meta.get("created"), "imported": meta.get("imported", False)}
    rc, txt = run(["keytool", "-list", "-v", "-keystore", str(d / "keystore.p12"), "-storetype", "PKCS12",
                   "-storepass:env", "KS_PASS", "-alias", meta["alias"]], env={"KS_PASS": meta["password"]})
    for key, pat in (("sha1", r"SHA1: ([0-9A-F:]+)"), ("sha256", r"SHA256: ([0-9A-F:]+)"), ("valid", r"Valid from: (.+)")):
        m = re.search(pat, txt)
        out[key] = m.group(1).strip() if m else ""
    sha1 = out.get("sha1", "")
    if sha1:
        out["keyHashKakao"] = base64.b64encode(bytes.fromhex(sha1.replace(":", ""))).decode()
    return out


def create_keystore(pid: str, cn: str, org: str = "", validity_days: int = 10000) -> dict:
    d = pdir(pid)
    if (d / "keystore.p12").exists():
        raise StudioError("이미 키스토어가 있습니다 — 새로 만들면 기존 설치본을 업그레이드할 수 없게 됩니다. 먼저 삭제하세요.")
    pw = secrets.token_urlsafe(18)
    alias = "studio"
    dname = f"CN={cn.replace(',', ' ')}" + (f", O={org.replace(',', ' ')}" if org else "")
    rc, out = run(["keytool", "-genkeypair", "-storetype", "PKCS12", "-keystore", str(d / "keystore.p12"),
                   "-alias", alias, "-storepass:env", "KS_PASS", "-keypass:env", "KS_PASS", "-keyalg", "RSA",
                   "-keysize", "2048", "-validity", str(validity_days), "-dname", dname], env={"KS_PASS": pw})
    if rc != 0:
        raise StudioError("keytool 실패: " + out[-400:])
    write_json(d / "keystore.json", {"alias": alias, "password": pw, "dname": dname, "created": int(time.time())})
    os.chmod(d / "keystore.json", 0o600)
    return keystore_info(pid) or {}


def import_keystore(pid: str, b64: str, alias: str, password: str) -> dict:
    d = pdir(pid)
    raw = base64.b64decode(b64)
    tmp = d / "import.tmp"
    tmp.write_bytes(raw)
    try:
        ok = False
        for stype in ("PKCS12", "JKS"):
            rc, _ = run(["keytool", "-list", "-keystore", str(tmp), "-storetype", stype, "-storepass:env", "KS_PASS"],
                        env={"KS_PASS": password})
            if rc == 0:
                ok = True
                break
        if not ok:
            raise StudioError("키스토어를 열 수 없습니다 (비밀번호/형식 확인)")
        dst = d / "keystore.p12"
        dst.unlink(missing_ok=True)
        if stype == "PKCS12":
            shutil.copyfile(tmp, dst)
        else:
            rc, out = run(["keytool", "-importkeystore", "-srckeystore", str(tmp), "-srcstoretype", "JKS",
                           "-destkeystore", str(dst), "-deststoretype", "PKCS12", "-srcstorepass:env", "KS_PASS",
                           "-deststorepass:env", "KS_PASS", "-srckeypass:env", "KS_PASS", "-destkeypass:env", "KS_PASS",
                           "-srcalias", alias], env={"KS_PASS": password})
            if rc != 0:
                raise StudioError("JKS → PKCS12 변환 실패: " + out[-300:])
        write_json(d / "keystore.json", {"alias": alias, "password": password, "created": int(time.time()), "imported": True})
        os.chmod(d / "keystore.json", 0o600)
    finally:
        tmp.unlink(missing_ok=True)
    return keystore_info(pid) or {}


def delete_keystore(pid: str):
    d = pdir(pid)
    for n in ("keystore.p12", "keystore.json"):
        (d / n).unlink(missing_ok=True)


# ----------------------------------------------------------------------------
# 빌드
# ----------------------------------------------------------------------------
BUILD_STEPS = ["준비", "패치", "리소스·코드 빌드", "v1 서명", "정렬", "v2 서명", "검증"]


def start_build(pid: str) -> Job:
    d = pdir(pid)
    if not (d / "decoded" / "AndroidManifest.xml").exists():
        raise StudioError("아직 해체가 끝나지 않았습니다")
    if any(j.status == "running" and j.title.startswith("빌드:" + pid) for j in JOBS.values()):
        raise StudioError("이미 빌드가 진행 중입니다")
    cfg = validate_config(get_config(pid))
    write_json(d / "config.json", cfg)
    return start_job(Job(f"빌드:{pid}", BUILD_STEPS), _build_job, pid, cfg)


def _file_sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _build_job(job: Job, pid: str, cfg: dict) -> dict:
    d = pdir(pid)
    analysis = read_json(d / "analysis.json") or analyze(pid)
    old_pkg = analysis["package"]
    work_root = d / "build"
    shutil.rmtree(work_root, ignore_errors=True)
    work = work_root / "work"
    log = job.log

    job.step("준비")
    log("작업 디렉터리 복사 (decoded → build/work)")
    shutil.copytree(d / "decoded", work)
    if not (d / "keystore.p12").exists():
        log("키스토어가 없어 새로 생성합니다")
        create_keystore(pid, cfg["appName"])
    ks = read_json(d / "keystore.json")

    job.step("패치")
    log("AndroidManifest.xml")
    patch_manifest(work / "AndroidManifest.xml", cfg, old_pkg, log)
    log("apktool.yml")
    patch_yml(work / "apktool.yml", cfg, log)
    log("strings.xml")
    patch_strings(work, cfg, log)
    patch_config_xml(work, cfg, old_pkg, log)
    log("사용자 편집 / 아이콘")
    apply_overlay(d, work, log)
    log("www 규칙 · 주입")
    patch_www(work, cfg, analysis, log)
    log("Swing2App 식별값")
    patch_swing(work, cfg, analysis, log)

    job.step("리소스·코드 빌드")
    unsigned = work_root / "unsigned.apk"
    rc, out = run(apktool_cmd() + ["b", "-o", str(unsigned), str(work)], job)
    if rc != 0 or not unsigned.exists():
        raise StudioError("apktool 빌드 실패 — 로그를 확인하세요")

    env = {"KS_PASS": ks["password"]}
    job.step("v1 서명")
    v1 = work_root / "v1.apk"
    rc, out = run(["jarsigner", "-keystore", str(d / "keystore.p12"), "-storetype", "PKCS12", "-storepass:env", "KS_PASS",
                   "-sigalg", "SHA256withRSA", "-digestalg", "SHA-256", "-sigfile", "CERT", "-signedjar", str(v1),
                   str(unsigned), ks["alias"]], env=env, quiet_prefixes=("Warning", "The signer", "  "))
    if rc != 0 or not v1.exists():
        raise StudioError("jarsigner 실패: " + out[-300:])

    job.step("정렬")
    aligned = work_root / "aligned.apk"
    zipalign = _sdk_tool("zipalign")
    if zipalign:
        rc, out = run([zipalign, "-f", "-p", "4", str(v1), str(aligned)], job)
        if rc != 0:
            raise StudioError("zipalign 실패: " + out[-300:])
        log("zipalign 사용")
    else:
        align_zip(v1, aligned)
        log("내장 정렬기 사용")
    bad = check_aligned(aligned)
    if bad:
        raise StudioError(f"정렬 검사 실패: {bad[:3]}")
    log("✓ STORED 항목 4바이트 정렬 확인 (resources.arsc 포함)")

    job.step("v2 서명")
    ver = re.sub(r"[^0-9A-Za-z._-]", "", cfg["versionName"]) or "0"
    final = d / "out" / f"{_slug(cfg['appName'])}-{ver}-{cfg['versionCode']}-signed.apk"
    final.parent.mkdir(exist_ok=True)
    rc, out = run(["java", str(SIGNER_JAVA), "sign", str(aligned), str(final), str(d / "keystore.p12"), ks["alias"]],
                  job, env=env)
    if rc != 0 or not final.exists():
        raise StudioError("v2 서명 실패: " + out[-300:])

    job.step("검증")
    report = verify_apk(final, job)
    if not report["ok"]:
        raise StudioError("서명 검증 실패 — 산출물을 사용하지 마세요")
    info = apk_summary(final, cfg, old_pkg)
    info.update({"verify": report, "name": final.name, "sha256": _file_sha256(final), "size": final.stat().st_size,
                 "built": int(time.time())})
    builds = read_json(d / "builds.json", [])
    builds = [b for b in builds if b["name"] != final.name]
    builds.insert(0, {k: info[k] for k in ("name", "sha256", "size", "built", "versionName", "versionCode", "package", "label", "verify")})
    write_json(d / "builds.json", builds)
    shutil.rmtree(work_root, ignore_errors=True)
    log(f"✓ 완료: {final.name}")
    return info


def verify_apk(apk: Path, job: Job | None = None) -> dict:
    log = job.log if job else (lambda *_: None)
    checks = []

    def add(name, ok, detail=""):
        checks.append({"name": name, "ok": ok, "detail": detail})
        log(("  ✓ " if ok else "  ✗ ") + name + (f" — {detail}" if detail else ""))

    rc, out = run(["java", str(SIGNER_JAVA), "verify", str(apk)])
    kv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    add("APK Signature v2 (내장 검증기: 다이제스트 + RSA 서명 재계산)", kv.get("v2.verified") == "true",
        kv.get("cert.sha256", ""))
    rc, out = run(["jarsigner", "-verify", str(apk)])
    add("v1(JAR) 서명 (jarsigner -verify)", "jar verified" in out, "")
    bad = check_aligned(apk)
    add("zip 정렬 (STORED 4바이트)", not bad, f"불량 {len(bad)}개" if bad else "")
    ext = _sdk_tool("apksigner")
    if ext:
        rc, out = run([ext, "verify", "-v", str(apk)])
        add("apksigner verify (Android SDK 교차 검증)", rc == 0 and "Verified using v2 scheme (APK Signature Scheme v2): true" in out)
    with zipfile.ZipFile(apk) as z:
        add("zip 무결성(CRC)", z.testzip() is None)
    return {"ok": all(c["ok"] for c in checks), "checks": checks,
            "certSha256": kv.get("cert.sha256", "")}


def apk_summary(apk: Path, cfg: dict, old_pkg: str) -> dict:
    return {"package": cfg["packageName"], "oldPackage": old_pkg, "label": cfg["appName"],
            "versionName": cfg["versionName"], "versionCode": cfg["versionCode"]}


def list_builds(pid: str) -> list[dict]:
    d = pdir(pid)
    builds = read_json(d / "builds.json", [])
    return [b for b in builds if (d / "out" / b["name"]).exists()]


def build_path(pid: str, name: str) -> Path:
    p = (pdir(pid) / "out" / Path(name).name)
    if not p.is_file():
        raise StudioError("빌드 산출물이 없습니다")
    return p


def bump_version(pid: str, level: str) -> dict:
    cfg = get_config(pid)
    cfg["versionCode"] = int(cfg["versionCode"]) + 1
    parts = str(cfg["versionName"]).split(".")
    nums = []
    for x in parts:
        m = re.match(r"\d+", x)
        nums.append(int(m.group()) if m else 0)
    while len(nums) < 3:
        nums.append(0)
    idx = {"major": 0, "minor": 1, "patch": 2}.get(level, 2)
    if len(str(cfg["versionName"]).split(".")) == 2 and level == "patch":
        idx = 1  # '1.3' 처럼 두 자리면 minor 를 올린다
    nums[idx] += 1
    for j in range(idx + 1, len(nums)):
        nums[j] = 0
    keep = max(len(parts), idx + 1)
    cfg["versionName"] = ".".join(str(n) for n in nums[:keep])
    return save_config(pid, cfg)
