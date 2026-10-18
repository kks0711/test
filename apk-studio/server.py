#!/usr/bin/env python3
"""APK Studio 로컬 서버 — `python3 server.py` 후 http://127.0.0.1:8787 접속.

- 표준 라이브러리만 사용한다.
- 127.0.0.1 에만 바인딩하고, 실행할 때마다 새로 만드는 토큰과 Host 검사로
  다른 웹사이트가 이 API 를 호출하지 못하게 막는다.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import secrets
import shutil
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import engine as E

WEB = Path(__file__).resolve().parent / "web"
TOKEN = secrets.token_urlsafe(24)
MAX_UPLOAD = 400 * 1024 * 1024
PORT = 8787


class Handler(BaseHTTPRequestHandler):
    server_version = "ApkStudio/1.0"

    # -- 공통 -----------------------------------------------------------
    def log_message(self, fmt, *args):  # 조용히
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("127.0.0.1", "localhost", "[::1]")

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, code: int = 200):
        self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _err(self, msg: str, code: int = 400):
        self._json({"ok": False, "error": msg}, code)

    def _body_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 64 * 1024 * 1024:
            raise E.StudioError("요청이 너무 큽니다")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise E.StudioError("JSON 형식 오류")

    def _authorized(self, query: dict) -> bool:
        tok = self.headers.get("X-Studio-Token") or (query.get("token") or [""])[0]
        return secrets.compare_digest(tok, TOKEN)

    # -- 라우팅 ---------------------------------------------------------
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str):
        if not self._host_ok():
            return self._err("허용되지 않은 Host", 403)
        u = urlparse(self.path)
        path, query = u.path, parse_qs(u.query)
        try:
            if not path.startswith("/api/"):
                return self._static(path) if method == "GET" else self._err("not found", 404)
            if not self._authorized(query):
                return self._err("인증 토큰이 올바르지 않습니다 (페이지를 새로고침하세요)", 403)
            self._api(method, path, query)
        except E.StudioError as e:
            self._err(str(e))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._err(f"서버 오류: {e}", 500)

    def _static(self, path: str):
        if path in ("/", "/index.html"):
            html = (WEB / "index.html").read_text(encoding="utf-8").replace("__STUDIO_TOKEN__", TOKEN)
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        f = (WEB / unquote(path).lstrip("/")).resolve()
        if WEB.resolve() not in f.parents or not f.is_file():
            return self._err("not found", 404)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, f.read_bytes(), ctype)

    # -- API ------------------------------------------------------------
    def _api(self, method: str, path: str, query: dict):
        seg = [s for s in path.split("/") if s][1:]  # 'api' 제거
        q1 = lambda k, d="": (query.get(k) or [d])[0]  # noqa: E731

        if seg == ["env"] and method == "GET":
            return self._json({"ok": True, **E.tools_status()})
        if seg == ["env", "install"] and method == "POST":
            job = E.start_job(E.Job("도구 설치"), E.install_tools)
            return self._json({"ok": True, "job": job.id})
        if len(seg) == 2 and seg[0] == "jobs" and method == "GET":
            job = E.JOBS.get(seg[1])
            if not job:
                return self._err("작업을 찾을 수 없습니다", 404)
            return self._json({"ok": True, **job.snapshot(int(q1("since", "0") or 0))})

        if seg == ["projects"] and method == "GET":
            return self._json({"ok": True, "projects": E.list_projects()})
        if seg == ["projects", "upload"] and method == "POST":
            return self._upload(q1("name", "upload.apk"), q1("copyFrom") or None)
        if seg == ["projects", "import"] and method == "POST":
            b = self._body_json()
            p = Path(str(b.get("path", ""))).expanduser()
            if p.suffix.lower() != ".apk" or not p.is_file():
                raise E.StudioError("존재하는 .apk 파일 경로가 아닙니다")
            pid, job = E.create_project(p, b.get("name") or p.name, b.get("copyFrom") or None)
            return self._json({"ok": True, "id": pid, "job": job.id})

        if len(seg) >= 2 and seg[0] == "projects":
            return self._project_api(method, seg[1], seg[2:], query, q1)
        return self._err("알 수 없는 API", 404)

    def _upload(self, name: str, copy_from: str | None):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_UPLOAD:
            raise E.StudioError("업로드 크기가 올바르지 않습니다 (최대 400MB)")
        with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as tmp:
            left = n
            while left:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                tmp.write(chunk)
                left -= len(chunk)
        tmp_path = Path(tmp.name)
        try:
            if left:
                raise E.StudioError("업로드가 중간에 끊겼습니다")
            pid, job = E.create_project(tmp_path, Path(name).name or "upload.apk", copy_from)
        finally:
            tmp_path.unlink(missing_ok=True)
        self._json({"ok": True, "id": pid, "job": job.id})

    def _project_api(self, method, pid, rest, query, q1):
        if not rest:
            if method == "GET":
                d = E.pdir(pid)
                return self._json({
                    "ok": True,
                    "meta": E.read_json(d / "meta.json"),
                    "analysis": E.read_json(d / "analysis.json"),
                    "config": E.get_config(pid),
                    "builds": E.list_builds(pid),
                    "keystore": E.keystore_info(pid),
                    "overlay": E.overlay_list(pid),
                    "icons": E.icon_status(pid),
                    "decoded": (d / "decoded" / "AndroidManifest.xml").exists(),
                })
            if method == "DELETE":
                E.delete_project(pid)
                return self._json({"ok": True})

        key = rest[0] if rest else ""
        if key == "config" and method == "PUT":
            return self._json({"ok": True, "config": E.save_config(pid, self._body_json())})
        if key == "bump" and method == "POST":
            return self._json({"ok": True, "config": E.bump_version(pid, self._body_json().get("level", "patch"))})
        if key == "tree" and method == "GET":
            return self._json({"ok": True, **E.tree(pid, q1("path"))})
        if key == "file":
            if method == "GET":
                return self._json({"ok": True, **E.read_file(pid, q1("path"))})
            if method == "PUT":
                b = self._body_json()
                E.write_file(pid, b.get("path", ""), b.get("text"), b.get("b64"))
                return self._json({"ok": True, "overlay": E.overlay_list(pid)})
            if method == "DELETE":
                E.revert_file(pid, q1("path"))
                return self._json({"ok": True, "overlay": E.overlay_list(pid)})
        if key == "icons":
            if method == "POST":
                E.save_icons(pid, self._body_json().get("pngs", {}))
                return self._json({"ok": True, "icons": E.icon_status(pid)})
            if method == "DELETE":
                E.clear_icons(pid)
                return self._json({"ok": True, "icons": []})
        if key == "icon" and method == "GET":
            f = E.pdir(pid) / "icons" / f"{re.sub(r'[^a-z]', '', q1('d', 'xxxhdpi'))}.png"
            if not f.is_file():
                f = E.pdir(pid) / "decoded" / "res" / f"mipmap-{re.sub(r'[^a-z]', '', q1('d', 'xxxhdpi'))}" / "ic_launcher.png"
            if not f.is_file():
                return self._err("아이콘 없음", 404)
            return self._send(200, f.read_bytes(), "image/png")
        if key == "rules" and rest[1:] == ["preview"] and method == "POST":
            return self._json({"ok": True, "results": E.preview_rules(pid, self._body_json().get("rules", []))})
        if key == "build" and method == "POST":
            job = E.start_build(pid)
            return self._json({"ok": True, "job": job.id})
        if key == "keystore":
            if method == "POST":
                b = self._body_json()
                act = b.get("action")
                if act == "create":
                    E.create_keystore(pid, b.get("cn") or "APK Studio", b.get("org") or "")
                elif act == "import":
                    E.import_keystore(pid, b.get("b64", ""), b.get("alias", ""), b.get("password", ""))
                elif act == "delete":
                    E.delete_keystore(pid)
                else:
                    raise E.StudioError("알 수 없는 동작")
                return self._json({"ok": True, "keystore": E.keystore_info(pid)})
            if rest[1:] == ["secret"] and method == "GET":
                ks = E.read_json(E.pdir(pid) / "keystore.json")
                if not ks:
                    raise E.StudioError("키스토어가 없습니다")
                return self._json({"ok": True, "alias": ks["alias"], "password": ks["password"]})
            if rest[1:] == ["download"] and method == "GET":
                f = E.pdir(pid) / "keystore.p12"
                if not f.is_file():
                    raise E.StudioError("키스토어가 없습니다")
                return self._send(200, f.read_bytes(), "application/octet-stream",
                                  {"Content-Disposition": f'attachment; filename="{pid}-keystore.p12"'})
        if key == "download" and len(rest) == 2 and method == "GET":
            f = E.build_path(pid, rest[1])
            return self._stream_file(f)
        return self._err("알 수 없는 API", 404)

    def _stream_file(self, f: Path):
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.android.package-archive")
        self.send_header("Content-Length", str(f.stat().st_size))
        self.send_header("Content-Disposition", f'attachment; filename="{f.name}"')
        self.end_headers()
        with open(f, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)


def main():
    global PORT
    ap = argparse.ArgumentParser(description="APK Studio — APK 복제·업그레이드 대시보드")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--setup", action="store_true", help="apktool 만 설치하고 종료")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    PORT = args.port
    E.WORKSPACE.mkdir(parents=True, exist_ok=True)

    if args.setup:
        job = E.Job("도구 설치")
        E.install_tools(job)
        print("\n".join(job.snapshot()["lines"]))
        return

    st = E.tools_status()
    for it in st["items"]:
        mark = "✓" if it["ok"] else "✗"
        print(f"  {mark} {it['label']}: {it['detail']}")
    if not st["ready"]:
        print("\n필수 도구가 부족합니다. 대시보드 상단의 '도구 설치' 또는 `python3 server.py --setup` 을 사용하세요.")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"\nAPK Studio  →  http://127.0.0.1:{PORT}   (종료: Ctrl+C)")
    print(f"작업 폴더: {E.WORKSPACE}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
