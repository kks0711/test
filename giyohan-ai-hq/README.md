# 기요한 AI 대표실 (giyohan-ai-hq)

Claude Code + Notion MCP + Subagents + Agent Teams 구조로 만든
SEE-IT / 더리버처치 통합 AI 대표실이다.

```
기요한 한마디
↓
Claude Code 대표실 Lead Agent
↓
Notion MCP로 SEE-IT / 더리버 데이터 조회
↓
필요한 하위 직원 Agent 자동 호출
↓
직원별 결과 수합
↓
위험검수 Agent 검토
↓
대표 브리핑 + Action Item 후보 생성
↓
기요한 승인 후 Notion 반영
```

## 폴더 구조

```
giyohan-ai-hq/
├─ CLAUDE.md                     # 대표실 총괄 지침 (Lead Agent 운영규정)
├─ .mcp.json                     # Notion MCP 연결 설정
├─ settings.example.json         # Agent Teams 활성화 예시 (~/.claude/settings.json 에 병합)
├─ .claude/
│  ├─ agents/                    # 직원 Agent 10명
│  │  ├─ seeit-ops-lead.md               # SEE-IT 운영실장
│  │  ├─ seeit-meeting-action.md         # 회의·Action 전환
│  │  ├─ seeit-unification-education.md  # 통일교육 콘텐츠
│  │  ├─ seeit-prayer-report.md          # 후원보고·기도편지
│  │  ├─ seeit-risk-auditor.md           # 위험검수
│  │  ├─ river-sunday-ops.md             # 주일운영
│  │  ├─ river-sermon-education.md       # 설교·교육
│  │  ├─ river-pastoral-followup.md      # 목양·후속연락
│  │  ├─ river-finance-docs.md           # 회계·자료정리
│  │  └─ river-rhythm-auditor.md         # 반복점검
│  ├─ commands/                  # 슬래시 커맨드 4개
│  │  ├─ seeit-today.md          # /seeit-today
│  │  ├─ river-sunday.md         # /river-sunday
│  │  ├─ meeting-to-action.md    # /meeting-to-action
│  │  └─ weekly-risk-check.md    # /weekly-risk-check
│  └─ skills/                    # 직원 스킬 11개
│     ├─ kiyohan-core/                   # 요청 복원·대표 판단 분리·구조화
│     ├─ kiyohan-source-grounding/       # 원자료 근거 분리
│     ├─ kiyohan-execution-action/       # 담당·기한·다음 행동·완료증거 실행화
│     ├─ kiyohan-structure-writing/      # 카톡/노션 붙여넣기형 최종 문장
│     ├─ kiyohan-risk-audit/             # 오류·누락·충돌 검수
│     ├─ kiyohan-rhythm-ops/             # 반복점검·운영 리듬
│     ├─ kiyohan-unification-education/  # 통일교육·북한인권
│     ├─ kiyohan-prayer-report/          # 기도편지·후원보고
│     ├─ kiyohan-sermon-education/       # 설교·어린이예배·가정예배 변환
│     ├─ kiyohan-pastoral-followup/      # 목양 후속·카톡 초안
│     └─ kiyohan-finance-docs/           # 회계 원자료·수입지출
├─ kiyohan_ability_allocation.md # 기요한 능력 배분표 (직원별 장착 스킬 기준)
└─ outputs/                      # Notion 원자료 덤프·직원 결과물 저장소
```

## 직원별 장착 스킬

각 직원 Agent의 frontmatter `skills:`에 능력 배분표대로 장착되어 있다.

| 직원 | 장착 스킬 |
|---|---|
| seeit-ops-lead | core, source-grounding, execution-action, rhythm-ops, risk-audit |
| seeit-meeting-action | core, source-grounding, execution-action, structure-writing, risk-audit |
| seeit-unification-education | core, source-grounding, structure-writing, unification-education, risk-audit |
| seeit-prayer-report | core, source-grounding, structure-writing, prayer-report, risk-audit |
| seeit-risk-auditor | source-grounding, risk-audit, execution-action |
| river-sunday-ops | core, source-grounding, rhythm-ops, structure-writing, risk-audit |
| river-sermon-education | core, source-grounding, structure-writing, sermon-education, risk-audit |
| river-pastoral-followup | core, source-grounding, pastoral-followup, structure-writing, risk-audit |
| river-finance-docs | source-grounding, finance-docs, risk-audit, execution-action |
| river-rhythm-auditor | core, source-grounding, rhythm-ops, risk-audit, execution-action |

## 1. 초기 세팅

이 폴더에서 Claude Code를 시작한다.

```bash
cd giyohan-ai-hq
claude
```

Notion MCP는 `.mcp.json`에 이미 정의되어 있어 프로젝트를 열면 자동 인식된다.
수동으로 추가하려면:

```bash
claude mcp add --transport http notion https://mcp.notion.com/mcp
```

Claude Code 안에서 인증 상태 확인:

```
/mcp
```

Claude.ai에 이미 Notion connector를 붙여둔 경우, Claude Code가 claude.ai
계정 인증을 통해 해당 connector를 가져올 수 있다.

## 2. Agent Teams 켜기 (2단계, 실험 기능)

`~/.claude/settings.json`에 `settings.example.json` 내용을 병합한다.

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "teammateMode": "in-process"
}
```

실험 기능이므로 처음에는 Subagents 중심으로 안정화하고,
그다음 Agent Teams를 켜는 순서를 권장한다.
Agent Teams는 병렬 연구·검토·독립 작업에 강하고,
순차·의존성 큰 작업에는 Subagents가 더 적합하다.

## 3. 사용법

### 슬래시 커맨드

```
/seeit-today        # SEE-IT 오늘 운영 브리핑
/river-sunday       # 더리버처치 주일 운영판
/meeting-to-action  # 회의록 → 실행 전환
/weekly-risk-check  # 주간 통합 위험 점검
```

### 자연어 한마디

```
씨잇 오늘 돌려.
더리버 주일 돌려.
회의록 실행으로 내려.
기도편지 준비해.
위험 점검해.
```

CLAUDE.md의 "한마디 명령 해석" 규정에 따라 Lead Agent가
Notion 조회 → 직원 Agent 호출 → 위험검수 → 대표 브리핑 순으로 처리한다.

### Agent Teams 버전 (직원들이 동시에 움직이는 구조)

SEE-IT:

```
씨잇 오늘 운영을 돌려.

teammates를 다음 이름으로 생성해:
1. 운영실장: seeit-ops-lead agent type 사용
2. 회의실행: seeit-meeting-action agent type 사용
3. 위험검수: seeit-risk-auditor agent type 사용

운영실장은 SEE-IT 운영 허브와 Action Item을 보고 대표 브리핑을 작성한다.
회의실행은 최근 회의록을 실행 단위로 전환한다.
위험검수는 두 결과를 검토해 오류, 누락, 충돌, 근거 부족을 잡는다.

세 직원이 끝나면 Lead가 최종 보고서로 통합한다.
대표 승인 전에는 Notion에 쓰지 않는다.
```

더리버처치:

```
더리버 주일 운영을 돌려.

teammates를 다음 이름으로 생성해:
1. 주일운영: river-sunday-ops agent type 사용
2. 설교교육: river-sermon-education agent type 사용
3. 반복점검: river-rhythm-auditor agent type 사용

주일운영은 이번 주 주일예배 준비 상태를 확인한다.
설교교육은 설교·어린이예배·가정예배 연결을 확인한다.
반복점검은 금요일·토요일·주일 후·월말 기준으로 빠진 것을 잡는다.

세 직원이 끝나면 Lead가 최종 주일 운영판으로 통합한다.
대표 승인 전에는 Notion에 쓰지 않는다.
```

## 4. 절대 원칙 요약

1. Notion은 원자료다. 추정으로 사실을 만들지 않는다.
2. 이름, 날짜, 장소, 인원, 금액, 담당자는 임의 변경 금지.
3. 근거 없는 내용은 "근거 없음" 또는 "확인 필요" 표시.
4. 노션 쓰기 작업은 대표 승인 전에는 하지 않는다.
5. 목양·관계 판단은 "목회자 확인 필요"로 멈춘다.

## 5. 고도화 로드맵

```
1단계: Claude Code + Notion MCP + Subagents          (현재, 이 저장소)
2단계: Agent Teams로 실제 직원단처럼 병렬 실행         (settings.example.json 적용)
3단계: Claude Agent SDK + Telegram + Notion API로
       상시 대기형 대표실 구축
```

3단계 완전형 구조:

```
Telegram 입력
↓
Python 서버
↓
Claude Agent SDK
↓
대표실 Lead Agent
↓
Notion MCP / Notion API 조회
↓
직원 Agent 병렬 실행
↓
검수 Agent 실행
↓
대표 승인 메시지
↓
승인 시 Notion Action Item 생성
```
