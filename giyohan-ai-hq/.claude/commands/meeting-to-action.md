---
description: 회의록을 결정·보류·위임·질문·Action Item으로 전환하고 위험검수까지 수행
---

입력된 회의록을 실행 단위로 전환하라.

절차:
1. 회의록에서 결정사항, 보류사항, 위임사항, 질문사항을 분리하라.
2. seeit-meeting-action을 호출하라.
3. 실행 누락과 담당자·기한·완료증거 누락을 seeit-risk-auditor로 검수하라.
4. Action Item 후보를 만들되, 대표 승인 전에는 Notion에 쓰지 말라.

최종 출력:
- 결정사항
- 보류사항
- 위임사항
- 질문사항
- 새 Action Item 후보
- 대표 판단 필요
