# CONFIG — 커밋/푸시 대상 매핑

> 커밋/푸시 요청 시 이 파일을 참고해 대상 폴더/리모트를 확인한다.
> **결정(2026-07-17)**: MCP, NestJS, Next.js는 각각 독립 Git 저장소로 관리한다.
> 세 서브폴더는 `main` 브랜치로 로컬 초기화하고 아래 GitHub 저장소를 `origin`으로 사용한다.
> 루트 저장소는 세 폴더를 ignore하고 인덱스에서 분리한다. 커밋과 push는 별도 요청 전까지 수행하지 않는다.

## 🏆 해커톤 제출용 repo (모노레포)

- **제출은 모노레포 1개로 한다** → **https://github.com/leecatinc/sceneboard.git** (private, 사용자 생성 완료, 2026-07-18).
- OpenAI Build Week 제출 폼은 저장소 URL 1개만 받으므로, 개발 모노레포(`/workspace/lc/leecat-board`) 전체를 이 `sceneboard` repo에 push해 제출한다.
- 제출 시 private + `testing@devpost.com`·`build-week-event@openai.com` 초대. README에 monorepo 실행법 + Codex/GPT-5.6 활용 서술 + `/feedback` Codex Session ID.
- 아래 서브폴더별 분리 repo는 **배포(k8s) 편의용**이며 제출물이 아니다.

## GitHub 저장소 — 배포용 분리 repo (leecatinc)

| 서브프로젝트 폴더 | GitHub repo | 배포 브랜치 |
|---|---|---|
| `leecat-board-mcp` | https://github.com/leecatinc/leecat-board-mcp.git | (로컬 stdio, 미배포) |
| `leecat-board-nestjs` | https://github.com/leecatinc/leecat-board-nestjs.git | `release` (배포됨) |
| `leecat-board-nextjs` | https://github.com/leecatinc/leecat-board-nextjs.git | `release` (배포됨) |
| `leecat-board-artifact-runtime` | https://github.com/leecatinc/leecat-board-artifact-runtime.git | `release` (배포 진행) |

- 배포는 `release` 브랜치를 clone → ext_files 주입 → `yarn build` → pm2. 각 repo는 공용 `packages/`를 vendor한 자립 구조.
- `leecat-board-proto`: 별도 자체 `.git` 보유 (로컬 디자인 baseline).

## 저장소 운영 상태

- 구조: 서브폴더별 독립 저장소 3개.
- 기본 브랜치: `main`.
- 각 저장소는 자체 `.gitignore`를 소유한다.
- 루트의 공용 `packages/`, 인증·기획 자료, npm workspace 개발 구성은 현재 별도 분리 과제다. 세 앱의 독립 설치·빌드를 위해서는 공용 패키지 배포 또는 저장소 재배치가 추가로 필요하다.
- 초기 커밋과 push는 아직 수행하지 않는다.

## SceneBoard QA 계정

- 용도: 회원가입·로그인·MCP/브라우저 회귀 테스트에 재사용하는 격리 개발 계정.
- 이메일: `sceneboard.qa.1784267483.9975a9@example.com`
- 자격 증명: `/home/leecat/.local/state/sceneboard-qa/account.json` (`0600`). 비밀번호를 이 저장소나 로그에 복사하지 않는다.
- 보드·grant 식별자: `/home/leecat/.local/state/sceneboard-qa/state.json` (`0600`).
- MCP 프로필: `skill-qa`; credential 파일은 `/home/leecat/.local/state/leecat-board/credentials/skill-qa/credential.json` (`0600`).
- 테스트 시 기존 계정을 우선 재사용하고, 이메일 인증 재검증이 명시적으로 필요할 때만 별도 계정을 만든다.
