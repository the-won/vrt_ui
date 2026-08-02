# 컴포넌트 가이드 자동 동기화 — 포터블 템플릿

운영 중인 컴포넌트 소스(스타일·스크립트·마크업 템플릿 등)가 바뀌었을 때, 버튼 클릭 한 번으로 변경 여부를 감지하고
Claude Code가 컴포넌트 가이드 페이지의 예시 마크업을 직접 갱신하게 하는 템플릿입니다.
이 저장소의 "Jenkins 배포" 버튼(`server/deploy-server.js`)과 동일한 구조이되,
git 명령 대신 `claude -p` 헤드리스 실행으로 스킬을 호출합니다.

## 구성

- `.claude/skills/component-guide-sync/SKILL.md` — 가이드 페이지 구조와 갱신 규칙을 Claude에게 알려주는 스킬 정의
- `server/guide-sync-server.js` — 변경 감지(`/api/guide/check`) + 동기화 실행(`/api/guide/sync`) 로컬 서버
- `assets/guide-sync-client.js` — 가이드 페이지에 넣는 버튼/상태 표시 스크립트

## 설치 순서

이 템플릿은 **저장소 루트 기준 `guide/`(가이드 페이지) / `resources/`(운영 리소스)** 폴더
컨벤션을 기본값으로 채워뒀습니다. 실제 프로젝트도 이 구조라면 아래 1·2단계에서 경로를 거의
안 고쳐도 됩니다. 폴더명이 다르면 `SKILL.md`와 `guide-sync-server.js` 양쪽에서 `guide`/`resources`를
실제 이름으로 바꿔주세요.

1. **스킬 복사 및 채우기**
   `.claude/skills/component-guide-sync/` 폴더 전체를 실제 프로젝트 루트에 복사합니다.
   `SKILL.md`의 "가이드 페이지 구조" 절(`<GUIDE_PAGE_STRUCTURE>`)을 실제 `guide/` 폴더의
   구조에 맞게 채워주세요. 이 문서가 정확할수록 Claude가 만드는 예시 품질이 좋아집니다 —
   특히 "사이즈별/스타일별/정렬별 그룹" 부분은 실제 가이드 페이지의 HTML 구조를 보고
   그대로 옮겨 적으세요.

2. **트리거 서버 복사 및 설정**
   `server/guide-sync-server.js`를 실제 프로젝트 아무 위치에나 복사해도 됩니다
   (내부적으로 `git rev-parse --show-toplevel`로 저장소 루트를 알아내므로, 파일이
   저장소 루트에서 몇 단계 떨어져 있는지는 상관없습니다). 복사한 뒤 파일 상단
   "설정" 블록을 확인합니다:
   - `GUIDE_PAGE_PATH` (기본값 `"guide"`): 가이드 페이지 폴더/파일 경로(저장소 루트 기준)
   - `WATCHED_PATHS` (기본값 `["resources"]`): 감지할 리소스 폴더 목록(저장소 루트 기준)
   - `ALLOWED_ORIGINS`: 가이드 페이지를 서빙하는 실제 origin(포트) — 반드시 채워야 함
   - `PORT`: 다른 로컬 서버와 겹치지 않는 포트(기본 4100)

   실행: `node guide-sync-server.js`

3. **가이드 페이지에 버튼 연결**
   `assets/guide-sync-client.js`를 가이드 페이지에 포함하고, 아래 마크업을 추가합니다
   (클래스명은 예시이며 프로젝트의 버튼/상태칩 스타일에 맞게 바꾸세요):
   ```html
   <span id="guide-sync-status"></span>
   <button id="btn-guide-check">가이드 상태 확인</button>
   <button id="btn-guide-sync" disabled>가이드 동기화</button>
   <script src="guide-sync-client.js"></script>
   ```
   `guide-sync-client.js` 상단의 `API_BASE`를 `guide-sync-server.js`의 실제 포트와 맞추고,
   `.stat-chip--danger` / `.stat-chip--success` 클래스가 프로젝트에 없다면 동등한 스타일로
   바꿔주세요(이 템플릿은 이 저장소의 디자인 토큰을 기준으로 만들어졌습니다).

## 사용 흐름

1. "가이드 상태 확인" 클릭 → 마지막 동기화 이후 `WATCHED_PATHS`에 변경이 있었는지 git diff로 확인.
2. 변경이 있으면 "가이드 동기화" 버튼이 활성화됨. 클릭하면 확인창 후 서버가
   `claude -p --permission-mode acceptEdits`로 `component-guide-sync` 스킬을 호출해
   가이드 페이지를 직접 편집.
3. 완료되면 브라우저 콘솔에 Claude가 남긴 변경 요약이 출력됨.
4. **커밋은 자동으로 하지 않습니다.** 반드시 `git diff`로 가이드 페이지 변경 내용을 사람이
   검토한 뒤 직접 커밋하세요.

## 주의사항

- `claude` CLI가 PATH에 있고 로그인/인증된 상태여야 합니다.
- 헤드리스 실행은 `--permission-mode acceptEdits`라 편집 중 사람 승인 없이 바로 파일을 고칩니다.
  `SKILL.md` 규칙이 부정확하면 잘못된 예시가 생길 수 있으니, **처음 몇 번은 결과를 꼼꼼히 검토**하세요.
- 동기화 1회 = 실제 Claude 호출 1회(과금 대상)입니다. 그래서 커밋마다 자동 실행이 아니라
  버튼을 눌렀을 때만 실행되는 구조로 만들었습니다.
- 변경 감지는 "마지막 동기화 커밋 ~ 현재 HEAD" 사이의 **커밋된** 변경만 봅니다.
  아직 커밋하지 않은 로컬 수정은 감지되지 않습니다.
- `server/.guide-sync-state.json`에 마지막 동기화 시점의 커밋 SHA가 저장됩니다.
  이 파일을 지우면 다음 확인에서 `WATCHED_PATHS` 전체를 변경된 것으로 간주합니다.
