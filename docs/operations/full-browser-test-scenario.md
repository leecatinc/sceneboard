# SceneBoard full browser test scenario

이 문서는 SceneBoard 개발 서버에서 공개 화면, 인증, 사용자 설정, AI 연결, 보드, Scene, Human-in-the-Loop(HITL), 아티팩트, 리비전, 오류 복구까지 한 번에 검증하는 종합 브라우저 시나리오다.

대상 기능은 다음 두 표면을 함께 포함한다.

- 사람이 사용하는 실제 브라우저 UI
- 승인된 SceneBoard 연결을 통해 브라우저 상태를 바꾸는 21개 보호 작업

정적 문구 확인만으로 통과시키지 않는다. 서버 저장 결과, 브라우저 렌더링, 상호작용 결과를 각각 별도 증거로 확인한다.

## 1. 실행 목표

한 번의 실행으로 다음 질문에 답한다.

1. 신규 사용자가 안전하게 가입하고 로그인할 수 있는가?
2. 브라우저 기본 언어와 저장한 언어 설정이 올바르게 적용되는가?
3. 일회용 코드가 정확히 한 연결과 새 보드에만 묶이는가?
4. 이전 페어링이나 이전 보드가 새 연결에 섞이지 않는가?
5. AI 작업이 Scene, HITL, 아티팩트, 리비전으로 실시간 표시되는가?
6. 보드의 보기·탐색·확대·축소·복구 기능이 실제 브라우저에서 동작하는가?
7. 권한 축소, 만료, 연결 해제, 잘못된 입력 같은 실패가 안전하게 처리되는가?
8. 테스트 종료 후 계정 외 테스트 데이터와 연결이 정리되는가?

## 2. 대상 환경과 실행 변수

기본 대상은 개발 서버다.

```text
SCENEBOARD_BASE_URL=https://sceneboard.leecat.co.kr
SCENEBOARD_ARTIFACT_URL=https://sceneboard-artifact.leecat.co.kr
SCENEBOARD_OUTPUT_DIR=/workspace/.tmp/agent/browser-use/sceneboard-full-browser
```

배포 서버 검증 시 URL만 다음 값으로 바꾼다.

```text
SCENEBOARD_BASE_URL=https://sceneboard.dev
SCENEBOARD_ARTIFACT_URL=https://artifact.sceneboard.dev
```

비밀번호, 세션 쿠키, CSRF 토큰, 연결 자격 증명은 시나리오 파일·로그·스크린샷·HTML에 저장하지 않는다. 일반 회귀는 재사용 가능한 전용 QA 계정을 사용하고, 회원가입 검증만 매 실행마다 고유한 테스트 이메일로 분리한다.

## 3. 판정 기준

### PASS

- 모든 필수 시나리오가 기대 결과를 만족한다.
- 브라우저 `pageerror`가 0건이다.
- 의도적으로 발생시킨 4xx를 제외한 console error가 0건이다.
- 현재 브라우저 URL의 `boardId`, API가 반환한 `boardId`, 연결에 승인된 `boardId`가 일치한다.
- 모든 테스트 데이터가 정리되거나 전용 QA 보드에 격리된다.

### FAIL

- 잘못된 보드로 자동 이동한다.
- 성공 응답 없이 UI가 성공 상태로 바뀐다.
- HITL 응답이 저장됐지만 호출자에게 전달되지 않는다.
- Scene이나 아티팩트가 저장됐지만 브라우저가 안전 중단 화면에 머문다.
- 현재 보드와 다른 보드의 Scene, 리비전, 연결 상태가 섞인다.
- 자격 증명, 쿠키, 토큰이 DOM·콘솔·네트워크 URL·아티팩트 런타임에 노출된다.

### BLOCKED

- 이메일 수신, CAPTCHA, 외부 계정 승인처럼 사람의 입력이 필요한 단계가 제공되지 않았다.
- 개발 서버 구성요소가 내려가 있어 기능 판정 자체가 불가능하다.
- 테스트 계정 또는 승인 권한이 준비되지 않았다.

## 4. 공통 안전 규칙

1. Headless Chromium을 기본으로 사용한다.
2. 실제 이메일 발송, 비밀번호 변경, 연결 해제, 보드 삭제 직전에는 해당 케이스가 명시적으로 승인된 테스트 데이터인지 확인한다.
3. 각 mutation은 고유한 `idempotencyKey`와 직전에 읽은 `expectedRevisionId`를 사용한다.
4. mutation 실패 후 다른 transport로 전환하거나 새 식별자를 임의 생성하지 않는다.
5. `REVISION_CONFLICT`는 최신 head를 다시 읽은 뒤 의도를 재평가한다. 맹목적으로 재시도하지 않는다.
6. 아티팩트 게시 성공과 브라우저 렌더링 성공을 별도로 기록한다.
7. HITL은 실제 `open` 요청과 브라우저 카드가 모두 확인돼야 사람에게 보였다고 판정한다.
8. 테스트 산출물은 `/workspace/.tmp/agent/browser-use/` 아래에만 저장한다.
9. 파괴적 정리는 마지막 단계에서만 수행한다.

## 5. 실행 전 점검

| ID | 작업 | 기대 결과 |
|---|---|---|
| PRE-01 | 앱 루트와 artifact `/healthz`, `/runner` 요청 | 최종 앱 200, artifact health 200, runner 200 |
| PRE-02 | PM2 또는 배포 상태 확인 | Next, Nest, MCP, artifact runtime이 모두 healthy |
| PRE-03 | 브라우저 환경 doctor 실행 | Playwright와 Chromium 실행 가능 |
| PRE-04 | 새 브라우저 context 생성 | 기존 쿠키·localStorage·sessionStorage 없음 |
| PRE-05 | console, pageerror, requestfailed 수집기 설치 | 민감정보를 제외한 오류 증거 수집 가능 |
| PRE-06 | 테스트 실행 ID 생성 | 계정, 연결, 보드, idempotency key가 실행 간 충돌하지 않음 |

## 6. Phase A — 공개 페이지와 다국어

| ID | 작업 | 기대 결과 |
|---|---|---|
| PUB-01 | 로그아웃 상태로 `/` 접속 | 로그인 또는 보드 목록으로 안전하게 리다이렉트 |
| PUB-02 | `/login`, `/signup`, `/integrations/codex` 직접 접속 | 각 페이지가 200으로 렌더링되고 깨진 번들 요청 없음 |
| PUB-03 | 브라우저 언어를 한국어로 설정한 새 context 접속 | 저장 언어가 없으면 한국어가 기본 선택됨 |
| PUB-04 | 영어, 한국어, 일본어, 중국어 간체·번체, 스페인어, 프랑스어, 독일어, 포르투갈어, 러시아어 선택 | 주요 내비게이션과 폼 문구가 선택 언어로 변경됨 |
| PUB-05 | 한국어 선택 후 페이지 새로고침과 새 탭 열기 | 저장한 언어가 브라우저 기본 언어보다 우선함 |
| PUB-06 | 저장 언어를 제거한 새 context에서 지역 언어 확인 | `pt-BR`, `zh-CN`, `zh-TW`가 올바른 지원 언어로 매핑됨 |
| PUB-07 | Codex 설치 페이지의 복사 버튼과 ZIP 링크 사용 | 복사 상태가 표시되고 ZIP이 200, 비어 있지 않음 |
| PUB-08 | 설치 ZIP 내부 검사 | 플러그인 manifest, MCP launcher, skill, API fallback, `demo-showcase` 존재 |

## 7. Phase B — 회원가입, 이메일 인증, 로그인

회원가입 이메일 발송은 외부 상태 변경이므로 승인된 개발용 주소에서만 실행한다. 일반 반복 회귀에서는 이미 인증된 QA 계정으로 `AUTH-07`부터 진행한다.

| ID | 작업 | 기대 결과 |
|---|---|---|
| AUTH-01 | 잘못된 이메일로 인증 코드 요청 | 로컬화된 검증 오류, 계정 생성 없음 |
| AUTH-02 | 고유 테스트 이메일로 인증 코드 요청 | Gmail 발송 성공 또는 승인된 개발 DB 확인 경로로 코드 확보 |
| AUTH-03 | 틀린 코드 입력 | 계정·세션 생성 없이 안전한 오류 |
| AUTH-04 | 올바른 코드 입력 | 이메일 인증 완료 상태로 전환 |
| AUTH-05 | 9자 비밀번호와 72 UTF-8 byte 초과 비밀번호 입력 | 생성 차단, 정책 안내 표시 |
| AUTH-06 | 유효한 10자 이상 비밀번호로 가입 | 계정 생성 후 인증된 세션으로 이동 |
| AUTH-07 | 로그아웃 후 틀린 비밀번호 로그인 | 사용자 존재 여부를 노출하지 않는 동일 오류 |
| AUTH-08 | 올바른 비밀번호 로그인 | 보드 목록으로 이동, 새로고침 후 세션 유지 |
| AUTH-09 | 같은 계정으로 두 탭 동시 로그인/새로고침 | 세션 단일 갱신, 무한 renew 또는 로그아웃 루프 없음 |
| AUTH-10 | 보호 URL을 로그아웃 context에서 직접 접속 | 세션이나 보드 데이터 노출 없이 로그인으로 이동 |

## 8. Phase C — 사용자 메뉴와 설정

| ID | 작업 | 기대 결과 |
|---|---|---|
| SET-01 | 우측 상단 사용자 영역 열기 | 이메일, 사용자 설정, 비밀번호 변경, 로그아웃만 표시 |
| SET-02 | 사용자 설정 열기 | 페이지 이동 없이 모달 표시 |
| SET-03 | 언어 변경 후 닫기·새로고침 | 선택 언어 유지, 모달 focus 복원 |
| SET-04 | 비밀번호 변경 열기 | 페이지 이동 없이 모달 표시 |
| SET-05 | 틀린 현재 비밀번호 제출 | 비밀번호·세션 변경 없음, 안전한 오류 |
| SET-06 | 동일한 새 비밀번호 또는 정책 미달 값 제출 | 변경 차단 |
| SET-07 | 승인된 QA 계정에서 유효한 비밀번호 변경 | 현재 브라우저 유지, 다른 세션·연결은 계약대로 해제 |
| SET-08 | 새 비밀번호로 재로그인 | 성공; 이전 비밀번호는 실패 |
| SET-09 | 로그아웃 | 보호 데이터 제거, 로그인 화면 이동, 뒤로 가기로 보드 노출 없음 |

비밀번호 변경을 실행하지 않는 일반 회귀에서는 `SET-07`과 `SET-08`을 `NOT RUN — destructive account test`로 명확히 기록한다.

## 9. Phase D — AI 연결 코드와 페어링

이 Phase는 이전 연결을 모두 제거한 상태와, 기존 연결이 남아 있는 상태에서 각각 한 번 실행한다.

| ID | 작업 | 기대 결과 |
|---|---|---|
| PAIR-01 | 탑바 `연결 코드 만들기` 클릭 | 모달 안에 `SB-XXXXXX-XXXXXX` 형식 코드 표시 |
| PAIR-02 | 코드 복사 | `클립보드에 복사되었습니다` 토스트 표시 |
| PAIR-03 | 모달 닫기 후 다시 열기 | 아직 유효한 코드 상태가 계약대로 유지되거나 명확히 갱신됨 |
| PAIR-04 | 코드를 사용하지 않고 `코드 취소` | 코드가 취소되고 이후 claim 불가 |
| PAIR-05 | 새 코드로 공식 MCP 또는 API fallback pair | pending 요청이 브라우저에 한 줄로 나타나고 상세 모달 자동 표시 |
| PAIR-06 | 전체 범위 확인 | 7개 scope와 `board.create`, `board.archive`가 모두 표시됨 |
| PAIR-07 | `새 보드` 기본 선택 상태로 승인 | 승인 시점에만 보드 생성, 반환된 정확한 `boardId`로 이동 |
| PAIR-08 | 브라우저 URL·API 결과·grant 보드 목록 비교 | 세 값이 동일하고 기존 보드는 포함되지 않음 |
| PAIR-09 | 기존 보드 선택 검색 | 제목 검색 가능, 선택한 정확한 보드에만 연결 |
| PAIR-10 | 보드 없이 session 연결 후 `board_create` | 반환된 새 보드가 같은 grant에 원자적으로 추가됨 |
| PAIR-11 | 요청 거부 | credential 발급 없음, 요청 terminal 상태가 denied |
| PAIR-12 | 요청 코드 취소 | 승인 불가, 코드가 목록에서 terminal 처리됨 |
| PAIR-13 | 승인된 클라이언트 자격 증명 교체 | 기존 자격 증명 무효, 새 자격 증명만 동작 |
| PAIR-14 | 승인된 클라이언트 연결 해제 | 보호 작업이 `UNAUTHENTICATED` 또는 `FORBIDDEN`으로 안전하게 실패 |
| PAIR-15 | 기존 연결이 있는 상태에서 새 페어링 | 새 연결이 이전 연결의 보드 ID를 상속하지 않음 |

`PAIR-07`, `PAIR-08`, `PAIR-15`는 이전 보드 혼선 회귀의 필수 게이트다.

## 10. Phase E — 보드 목록과 보드 수명 주기

| ID | 작업 | 기대 결과 |
|---|---|---|
| BOARD-01 | 보드가 없는 계정에서 목록 열기 | 명확한 빈 상태, 오류 문구 없음 |
| BOARD-02 | `board_create`로 QA 보드 생성 | 목록에 즉시 추가되고 반환된 ID가 사용됨 |
| BOARD-03 | 보드 목록 또는 AI 연결 화면에서 AI가 새 보드 생성 | 새 보드 페이지로 자동 이동 |
| BOARD-04 | 다른 보드 상세를 보고 있을 때 AI가 새 보드 생성 | 현재 보드에 머물며 예기치 않은 강제 이동 없음 |
| BOARD-05 | 보드 제목 연필 버튼으로 수정 | 저장 후 헤더·목록·새로고침 결과 일치 |
| BOARD-06 | 두 개 이상 보드 생성 후 전환 | 각 보드의 Scene, 리비전, 연결 상태가 섞이지 않음 |
| BOARD-07 | 보드 삭제 버튼 클릭 후 취소 | 보드 유지 |
| BOARD-08 | 확인 모달에서 삭제 승인 | archive 처리 후 목록으로 이동, 직접 URL은 노출 없이 not found/unavailable |
| BOARD-09 | AI가 현재 보드를 archive | 현재 브라우저가 보드 목록으로 이동 |
| BOARD-10 | `board_list`의 includeArchived 분기 | false에서는 숨김, true에서는 archive 상태로만 조회 |

## 11. Phase F — 연결 상태와 권한

| ID | 작업 | 기대 결과 |
|---|---|---|
| GRANT-01 | `board_connection_status`에 null 대상 사용 | 인증 상태만 확인하고 보드를 임의 선택하지 않음 |
| GRANT-02 | 명시적 보드 대상으로 상태 조회 | exact board와 승인 scope 표시 |
| GRANT-03 | `board_capabilities_get` | UI 상태 사이드바와 서버 capability가 일치 |
| GRANT-04 | read-only 연결로 읽기 | 조회 성공 |
| GRANT-05 | read-only 연결로 mutation | `FORBIDDEN`, Scene 변경 없음 |
| GRANT-06 | artifact 권한 없이 게시 | `FORBIDDEN`, immutable artifact 생성 없음 |
| GRANT-07 | board.create 미승인 상태로 생성 | `FORBIDDEN`, 기존 보드 영향 없음 |
| GRANT-08 | 연결 해제 직후 열린 보드 관찰 | AI presence가 제거되고 사람 세션은 유지 |

## 12. Phase G — Scene 표시와 실시간 갱신

각 항목은 mutation 성공과 브라우저 렌더링을 따로 판정한다.

| ID | 작업 | 기대 결과 |
|---|---|---|
| SCENE-01 | 새 보드 첫 진입 | 오류 문구 없이 의도된 빈 캔버스 표시 |
| SCENE-02 | `board_scene_replace`로 markdown, code, status 배치 | 한 revision에 완성된 Scene 렌더링 |
| SCENE-03 | table, chart, map, drawing, progress 배치 | 각 trusted node가 의미를 보존하며 렌더링 |
| SCENE-04 | split, grid, tabs, canvas 레이아웃 배치 | 배치가 겹치거나 화면 밖으로 사라지지 않음 |
| SCENE-05 | `board_scene_patch`로 텍스트·탭 일부 변경 | 나머지 NodeId와 콘텐츠 유지 |
| SCENE-06 | 같은 mutation을 동일 key로 재전송 | byte-identical replay만 허용, 중복 revision 없음 |
| SCENE-07 | 같은 key에 다른 payload 사용 | `IDEMPOTENCY_KEY_REUSED`, Scene 변경 없음 |
| SCENE-08 | stale expectedRevisionId 사용 | `REVISION_CONFLICT`, 새 head 보존 |
| SCENE-09 | `board_scene_clear` | 빈 캔버스가 새 restorable revision으로 남음 |
| SCENE-10 | 연결된 상태에서 3회 연속 실시간 갱신 | 새로고침 없이 sequence와 revision 증가 |
| SCENE-11 | SSE 연결을 잠깐 끊었다 복원 | 자동 재연결 후 latest head 수렴, 중복 Scene 없음 |
| SCENE-12 | 브라우저 새로고침 | 같은 보드와 live head 복원, chunk/MIME/CORS 오류 없음 |
| SCENE-13 | 두 탭에서 같은 보드 관찰 | 한 탭의 변경이 다른 탭에 일관되게 반영 |

## 13. Phase H — HITL 전체 유형과 수명 주기

각 요청은 먼저 서버에서 `open`, 다음으로 브라우저 decision tray 또는 inline card 렌더링을 확인한다.

| ID | 작업 | 기대 결과 |
|---|---|---|
| HITL-01 | `info` 요청 생성 | 사람이 내용을 확인하고 허용된 응답 형태로 완료 |
| HITL-02 | 단일 `choice` 요청 생성 | 한 옵션만 선택 가능, exact option ID 전달 |
| HITL-03 | 복수 `choice` 요청 생성 | min/max selection 검증, 범위 밖 제출 차단 |
| HITL-04 | `form` 요청 생성 | 필수·선택 필드와 입력 검증 동작 |
| HITL-05 | `confirmation` 요청 생성 후 confirm | `confirmed:true` 전달 |
| HITL-06 | confirmation의 cancel 선택 | `confirmed:false` 전달; 요청 cancel과 혼동하지 않음 |
| HITL-07 | Scene에 명시적 `content.hitl` 노드 없이 요청 | 자동 decision tray에서 카드 표시 |
| HITL-08 | exact request ID로 inline card 배치 | 중복 응답 카드 없이 지정 위치 표시 |
| HITL-09 | 브라우저 응답 후 bounded wait | 호출자가 `answered`와 exact response를 수신 |
| HITL-10 | 응답 완료 후 새로고침 | answered 기록 유지, 다시 제출 불가 |
| HITL-11 | 이미 answered 요청에 재응답 | `HITL_RESPONSE_CONFLICT`, 기존 응답 유지 |
| HITL-12 | 알려지지 않은 request ID 조회 | `HITL_REQUEST_NOT_FOUND`, 보드 안전 유지 |
| HITL-13 | 만료 시간이 짧은 테스트 요청 대기 | `expired`, 응답 컨트롤 비활성화 |
| HITL-14 | 서버 내부 lifecycle 경로로 cancel/supersede 시험 | browser terminal 표현은 정확하되 모델용 임의 cancel 도구는 노출되지 않음 |
| HITL-15 | history 화면에서 과거 open 카드 확인 | 과거 revision에서는 응답 컨트롤이 숨겨짐 |

## 14. Phase I — 아티팩트와 격리 런타임

| ID | 작업 | 기대 결과 |
|---|---|---|
| ART-01 | 승인된 closed template 게시 | immutable `artifactId/versionId`, runtime `ready` |
| ART-02 | exact artifact 노드를 Scene에 배치 | `.artifact-host.artifact-active`, iframe 1개 |
| ART-03 | 2D Canvas drawing animation | 선이 단계적으로 나타나고 완료 후 안정 상태 |
| ART-04 | colored illustration | 이전 outline revision 보존, 색상 결과 렌더링 |
| ART-05 | 3D paper diorama | pointer 이동에 depth/tilt 반응, 외부 네트워크 없음 |
| ART-06 | interactive prototype | 클릭 시 상태 전환, reset/replay 동작 |
| ART-07 | data story | 차트와 결론이 한 화면에 보이고 replay 동작 |
| ART-08 | incident simulation | healthy → failure → recovery 상태 전환 |
| ART-09 | code-review visual | review/final 단계와 사용자 선택 결과 표시 |
| ART-10 | Fit height | 세로 공간을 채우고 세로 잘림 없음 |
| ART-11 | Fit width | 가로 폭에 맞고 의도치 않은 가로 잘림 없음 |
| ART-12 | Actual size에서 wheel | cursor 중심 확대·축소, 페이지 전체 스크롤 대신 캔버스 조작 |
| ART-13 | Actual size에서 middle-button drag | 캔버스 좌표 이동 |
| ART-14 | Reset view | zoom과 pan이 초기값으로 복원 |
| ART-15 | Stop rendering | 우측 상태 영역에서 런타임 중지, Scene 참조는 유지 |
| ART-16 | 과거 revision과 Latest 이동 | 각 immutable version이 정확히 다시 렌더링 |
| ART-17 | artifact runtime 도메인 검사 | app cookie·Authorization·Referer가 전달되지 않음 |
| ART-18 | sandbox/CSP 검사 | `allow-scripts` 외 권한이 임의 추가되지 않고 외부 script 차단 |
| ART-19 | 잘못된 artifact 식별자 | 안전한 fallback, 자격 증명·payload 노출 없음 |
| ART-20 | 승인되지 않은 capability 요청 | `CAPABILITY_DENIED`, 자동 승인 없음 |

## 15. Phase J — 리비전과 시간 이동

| ID | 작업 | 기대 결과 |
|---|---|---|
| HIST-01 | 최소 4개 의미 있는 revision 생성 | history newest-first, 번호와 ID 유일 |
| HIST-02 | `Previous`, `Next`, `Latest` 버튼 사용 | historical/live 상태 라벨과 버튼 활성 상태 정확 |
| HIST-03 | 좌·우 방향키로 이동 | 입력 요소 밖에서만 revision 이동 |
| HIST-04 | PageUp·PageDown으로 이동 | revision 이동, 페이지 전체 스크롤과 충돌 없음 |
| HIST-05 | history 상태에서 live mutation 발생 | 현재 pinned revision 유지, Latest 가능 상태 표시 |
| HIST-06 | Latest 선택 | 최신 head로 수렴하고 live tracking 재개 |
| HIST-07 | `board_history_get` | 브라우저가 표시한 revision과 exact scene 일치 |
| HIST-08 | 과거 revision restore 승인 | 과거 scene이 새 head로 copy-forward, 과거 기록 불변 |
| HIST-09 | 복원 후 Previous | 복원 이전 head와 원본 과거 revision 모두 조회 가능 |
| HIST-10 | 존재하지 않는 revision 조회 | `REVISION_NOT_FOUND`, 현재 화면 안전 유지 |

## 16. Phase K — 반응형·접근성·브라우저 복원력

| ID | 작업 | 기대 결과 |
|---|---|---|
| UX-01 | 1440x900, 1180x900, 760x900 실행 | 주요 기능 접근 가능, 모달이 viewport 밖으로 탈출하지 않음 |
| UX-02 | 브라우저 200% zoom | 기능 손실 없이 reflow 또는 내부 스크롤 |
| UX-03 | keyboard-only 탐색 | visible focus, 논리적 순서, modal focus trap/restore |
| UX-04 | `prefers-reduced-motion` | 의미는 유지하고 장식 animation 감소 |
| UX-05 | forced colors | 텍스트·버튼·선택 상태 구분 가능 |
| UX-06 | 긴 이메일·긴 보드 제목 | 탑바와 카드 overflow가 레이아웃을 깨지 않음 |
| UX-07 | 모달 Escape와 닫기 버튼 | 저장·취소 의미가 분리되고 파괴적 코드 취소와 혼동 없음 |
| UX-08 | 느린 네트워크 | loading 상태 표시, 중복 mutation 없음 |
| UX-09 | offline 후 online | 안전한 재시도와 session/SSE 복구 |
| UX-10 | stale Next chunk를 가정한 강제 새로고침 | MIME 오류 없이 현재 빌드 자산 로드 |

## 17. Phase L — 오류 계약과 보안 회귀

의도적인 오류는 별도 context 또는 API 테스트 클라이언트에서 실행해 정상 화면의 console 기준과 섞지 않는다.

| ID | 작업 | 기대 결과 |
|---|---|---|
| ERR-01 | 잘못된 session/credential | 401과 `UNAUTHENTICATED`, request correlation 유지 |
| ERR-02 | 유효하지만 권한 없는 보드 ID | `FORBIDDEN` 또는 비노출 not found, 타 보드 존재 정보 최소화 |
| ERR-03 | malformed payload | `INVALID_PAYLOAD`, stack·DB 정보 노출 없음 |
| ERR-04 | stale revision mutation | `REVISION_CONFLICT`, 자동 rebase 없음 |
| ERR-05 | mutation 응답을 네트워크에서 끊은 뒤 같은 key 조회 | durable state를 읽어 판정, 중복 mutation 없음 |
| ERR-06 | API 일시 5xx | 화면은 안전 중단/재시도 상태, 다른 transport로 자동 전환 없음 |
| ERR-07 | CORS 허용 origin과 비허용 origin 비교 | 개발 앱 origin만 허용, 임의 origin 차단 |
| ERR-08 | artifact iframe request headers 검사 | 세션 쿠키·CSRF·Authorization·referrer 없음 |
| ERR-09 | DOM·console·저장 HTML secret scan | 비밀번호·코드·credential·cookie 원문 없음 |
| ERR-10 | 새로고침 중 열린 HITL·artifact 업데이트 | `durable HITL/artifact event has no stable target` 오류 없음 |
| ERR-11 | 빈 보드와 clear 직후 화면 | `Scene unavailable` 오류 대신 의도된 빈 화면 |
| ERR-12 | 아티팩트 상한 도달 직전 테스트 | 허용 범위 내 성공, 초과 시 `LIMIT_EXCEEDED`와 기존 상태 보존 |

## 18. Phase M — 정리와 종료

| ID | 작업 | 기대 결과 |
|---|---|---|
| CLEAN-01 | 열린 HITL 요청 확인 | answered 또는 의도된 terminal 상태, open 잔류 없음 |
| CLEAN-02 | 테스트 artifact rendering 중지 | runtime resource 정리, 브라우저 멈춤 없음 |
| CLEAN-03 | 테스트 연결 revoke | 보호 자격 증명 무효화 |
| CLEAN-04 | 테스트 보드 archive | 보드 목록에서 제거, 다른 사용자 보드 영향 없음 |
| CLEAN-05 | 로그아웃 및 context 종료 | cookie, storage, cache, service worker 잔류 없음 |
| CLEAN-06 | 최종 health 확인 | 앱과 artifact runtime 정상 |

회원가입 전용 계정 삭제 기능은 현재 사용자 UI 계약에 없으므로 자동화하지 않는다. 고유 테스트 계정의 보존·정리는 운영 정책에 따라 별도 처리한다.

## 19. 자동화 구조 권장안

전체 테스트는 한 개의 거대한 함수보다 다음 suite로 분리한다.

```text
browser-full/
  00-preflight
  01-public-locale
  02-auth-settings
  03-pairing-grants
  04-board-lifecycle
  05-scene-live
  06-hitl
  07-artifacts
  08-history
  09-responsive-accessibility
  10-errors-security
  11-cleanup
```

각 suite는 다음 JSON을 남긴다.

```json
{
  "caseId": "PAIR-08",
  "status": "PASS",
  "startedAt": "ISO-8601",
  "durationMs": 0,
  "browserUrl": "redacted-safe-url",
  "boardId": "public-board-id",
  "expectedRevisionId": "public-revision-id-or-null",
  "observedRevisionId": "public-revision-id-or-null",
  "consoleErrorCount": 0,
  "pageErrorCount": 0,
  "evidence": ["relative-sanitized-path"],
  "cleanup": "PASS"
}
```

실패하면 첫 오류를 보존하고, 후속 mutation suite를 중단한 뒤 read-only 진단과 안전한 cleanup만 수행한다.

## 20. 전체 보호 작업 커버리지

아래 21개 작업이 최소 한 번 성공 경로를 거쳐야 전체 기능 PASS다.

```text
board_list
board_connection_status
board_get
board_create
board_archive
board_capabilities_get
board_scene_get
board_scene_replace
board_scene_patch
board_scene_clear
board_artifact_get
board_artifact_put
board_artifact_stop
board_history_list
board_history_get
board_history_restore
board_interaction_request
board_interaction_status
board_interaction_respond
board_pair_request
board_pair_status
```

MCP가 없는 환경에서는 공식 API fallback으로 동일 기능을 별도 실행한다. MCP 호출이 인증·권한·충돌·서버 오류로 실패한 경우 fallback으로 바꿔 재시도하지 않는다.

## 21. 실행 완료 보고서

최종 보고에는 다음을 반드시 포함한다.

- 대상 URL, 브라우저 버전, viewport, 실행 ID
- PASS/FAIL/BLOCKED/NOT RUN 개수
- 페어링으로 생성·선택된 exact board ID
- 이전 보드 혼선 여부
- 각 HITL 유형의 terminal 상태와 응답 전달 여부
- 각 artifact의 immutable ready 여부와 browser active 여부
- revision 생성·history 이동·restore 결과
- console/page/request 오류 요약
- 보안 누출 검사 결과
- cleanup 결과
- 재현 가능한 첫 실패와 수정 후 재실행 결과

모든 케이스가 끝난 뒤에도 앱이 healthy이고, 전용 QA 데이터 외 사용자 데이터가 변경되지 않았을 때만 전체 PASS로 판정한다.
