# APK Studio — APK 복제 · 업그레이드 대시보드

APK 한 개를 올리면 **이름·패키지명·아이콘을 바꿔 독립된 앱으로 복제**하고, 버전·화면(HTML/CSS/JS)·서버 식별값을 고쳐
**서명된 새 APK로 다시 빌드**합니다. 모든 작업은 내 컴퓨터 안에서만 이루어집니다.

## 실행

필요한 것: **Python 3.9+**, **JDK 11+** (java · keytool · jarsigner)

```bash
cd apk-studio
python3 server.py            # → http://127.0.0.1:8787
```

첫 실행 때 상단의 `● 도구 설치 필요` 를 눌러 **apktool 자동 설치**(Maven Central)를 하거나 `python3 server.py --setup`.
Android SDK(zipalign/apksigner)가 있으면 자동으로 사용하고, 없으면 내장 구현이 대신합니다.

## 사용 순서

1. **새 프로젝트** — APK 업로드(또는 서버 경로 입력) → 해체·분석
2. **개요·점검** — 패키지/권한/서명/서버 연동 구조와 복제 시 주의점 확인
3. **복제 설정** — 앱 이름(`rea`), 패키지명, 버전, 아이콘, 권한 정리, 자동 보정 옵션
4. **업그레이드** — 버전 올리기, Swing2App 식별값, 텍스트 치환 규칙, 파일 편집기, CSS/JS 주입
5. **빌드·배포** — 키스토어 → 빌드 → 독립 검증 → APK 다운로드

> 업그레이드를 설치본 위에 덮어쓰려면 **같은 키스토어**로 서명하고 **versionCode 를 올려야** 합니다.
> 프로젝트마다 키스토어가 한 번만 만들어져 재사용됩니다. 반드시 백업하세요.

## 빌드 파이프라인

`apktool d` → 패치(매니페스트·리소스·www·식별값) → `apktool b` → `jarsigner`(v1) → 4바이트 정렬 → `signer/ApkSignV2.java`(v2 서명)
→ 검증(내장 v2 검증기 + jarsigner + zip 정렬 + CRC, apksigner 가 있으면 교차 검증)

복제 시 자동 처리되는 것
- `package` 및 패키지명이 박힌 권한·provider authority·카테고리 교체 (컴포넌트 클래스 경로는 유지)
- AAB 에서 뽑은 base APK 의 `isSplitRequired` / Play 스플릿·스탬프 메타데이터 제거 (안 그러면 설치 실패)
- 앱 이름(`app_name`), Cordova `config.xml`, 버전, 아이콘(6밀도)

## 복제본에서 따로 확인해야 하는 것 (대시보드 '개요'에도 표시)

- **푸시(FCM/OneSignal)**: 새 패키지명을 Firebase/OneSignal 에 등록해야 안정적으로 동작
- **소셜 로그인·딥링크**: (패키지명 + 서명 키 해시)를 각 개발자 콘솔에 등록 (빌드 탭에 SHA-1/키 해시 표시)
- **인앱 결제**: Play 등록 정보에 묶여 있어 복제본에서는 동작하지 않음
- **서버 연동(Swing2App 등)**: appId 를 그대로 두면 원본과 같은 서버 데이터·계정을 공유

복제·재배포는 본인이 소유했거나 변경 권한이 있는 앱에만 사용하세요.

## 보안

서버는 `127.0.0.1` 에만 바인딩하고, 실행마다 바뀌는 토큰과 Host 검사로 다른 웹사이트의 요청을 막습니다.
키스토어 비밀번호는 `workspace/<프로젝트>/keystore.json` 에 평문 저장됩니다 (`workspace/` 는 git 제외).
