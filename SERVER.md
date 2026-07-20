# SERVER — SceneBoard 서버 운영/재시작 런북

> 서버 재시작·상태 확인 요청 시 이 파일을 먼저 읽고 파악한 뒤 실행한다.
> **비밀값(토큰/비밀번호/API키)은 이 파일에 기록하지 않는다** — 위치(파일 경로)만 가리킨다.
> 마지막 갱신: 2026-07-19.

SceneBoard는 **두 개의 독립 환경**으로 운영된다.

| 구분 | 개발/스테이징 | 릴리즈/배포(프로덕션) |
|---|---|---|
| 실행 방식 | **로컬 pm2** (이 박스) | **Rancher k8s** (leecat-c1-s1) |
| 프록시 | docker `nginx-proxy` (host network) | k8s nginx ingress |
| 앱/API | `https://sceneboard.leecat.co.kr` | `https://sceneboard.dev` |
| Artifact Runtime | `https://sceneboard-artifact.leecat.co.kr` | `https://artifact.sceneboard.dev` |
| APP_ENV | staging(artifact) / development(nestjs, 아래 주의) | production |
| 코드 소스 | 로컬 워크트리 `/workspace/lc/leecat-board` | 각 repo `release` 브랜치 clone |

---

## 1. 개발/스테이징 — 로컬 pm2 (`sceneboard.leecat.co.kr`)

- **호스트**: 이 박스 (공개 IP `58.124.27.115`). `/volume1/DockerShare`는 NAS(`49.247.13.48`) NFS 마운트.
- **pm2 프로세스** (`pm2 list`로 확인):
  | 프로세스 | 내부 포트 | 역할 |
  |---|---|---|
  | `sceneboard-nextjs` | 3410 | Next.js 웹 (`npm run start` = next start) |
  | `sceneboard-nestjs` | 3411 | NestJS API |
  | `sceneboard-artifact-runtime` | 3412 | 격리 아티팩트 런타임 (launcher 경유) |
  | `sceneboard-mcp` | — | 로컬 stdio MCP (리스닝 포트 없음) |
- **프록시**: docker `nginx-proxy` 컨테이너. 설정 `/volume1/DockerShare/nginx-proxy/conf/conf.d/*.leecat.co.kr.conf`. 리로드 `docker exec nginx-proxy nginx -s reload` (변경 전 `docker exec nginx-proxy nginx -t`).
- **TLS**: 와일드카드 `*.leecat.co.kr` 인증서 `/volume1/ssl/leecat.co.kr/` (certbot DNS-01 자동갱신, cron `renew-ssl.sh`). 새 서브도메인은 이 인증서로 커버됨(추가 발급 불필요).
- **DNS**: Cloudflare `leecat.co.kr` zone. 서브도메인 = CNAME → `dkdkdkdkg2.iptime.org`(proxied off). 토큰: `/volume1/DockerShare/nginx-proxy/certbot/cloudflare-leecat.ini`. ※ `sceneboard-artifact.leecat.co.kr` CNAME 이미 생성됨.

### 개발 재시작 절차
```
pm2 restart sceneboard-nextjs            # 웹
pm2 restart sceneboard-nestjs            # API
pm2 restart sceneboard-artifact-runtime  # 아티팩트 런타임
pm2 save                                 # 재부팅 지속
```
- **artifact-runtime**은 launcher(`packages/artifact-runtime/deploy/launch-dev-runtime.sh`, ecosystem `deploy/pm2.dev.config.cjs`)가 **매 기동 fresh evidence(15분 만료) 재생성** 후 서버를 exec한다. 그냥 `pm2 restart`만 해도 evidence가 새로 생성되므로 안전. 코드 변경 시 먼저 `npm run build:runtime --workspace @leecat-board/artifact-runtime`.
- **nextjs**는 `NEXT_PUBLIC_*`가 **빌드타임 주입**이라, 공개 origin 값을 바꾸면 재빌드 필요:
  ```
  cd leecat-board-nextjs
  NEXT_PUBLIC_BOARD_API_URL=https://sceneboard.leecat.co.kr \
  NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN=https://sceneboard-artifact.leecat.co.kr \
  NODE_ENV=production npm run build --workspace leecat-board-nextjs
  pm2 restart sceneboard-nextjs
  ```
  빌드 후 `.next`에 옛 값 잔존 없는지, CSP `frame-src`에 artifact origin 포함되는지 확인.

### ⚠️ 개발 nestjs APP_ENV 주의
- 현재 `sceneboard-nestjs`는 `APP_ENV=development`. **staging으로 바꾸면 부팅 실패 위험**:
  1. `main.ts`가 staging/production에서 heavy DB 인증 게이트 요구(미인증 시 throw) — AMD-06 경량 스코프라 통과 안 됨.
  2. 쿠키가 `lcb_session`→`__Host-lcb_session`(Secure)으로 바뀌어 **기존 세션 무효화**.
- artifact-runtime은 nestjs 프로세스 env와 무관하게 자체 staging 설정으로 동작하므로, nestjs는 development 유지.

---

## 2. 릴리즈/배포 — Rancher k8s (`sceneboard.dev`)

- **서버**: `leecat-c1-s1` (ssh 등록됨, **root 계정 사용 가능** `ssh root@leecat-c1-s1`). RKE1 클러스터. 공개 ingress IP `49.247.13.48`(= NFS/DB/Redis 서버 겸용).
- **k8s Deployment** (namespace `default`):
  | Deployment | 포트 | GitHub repo (release 브랜치 clone) |
  |---|---|---|
  | `leecat-board-nestjs` | 3411 | `leecatinc/leecat-board-nestjs` |
  | `leecat-board-nextjs` | 3410 | `leecatinc/leecat-board-nextjs` |
  | `leecat-board-artifact-runtime` | 3412 | `leecatinc/leecat-board-artifact-runtime` |
  | (mcp 미배포 — 로컬 stdio) | — | — |
- **배포 메커니즘**: 이미지 `dkdk0/node-server` + `/startup.sh`가 `release` 브랜치 clone → `/volume1/DockerShare/leecat-board-<svc>/ext_files/*` 덮어쓰기 복사 → pod 시작 직후 **가장 먼저 `/volume1/DockerShare/leecat-board-<svc>/extra_commands.sh` 실행**(내용 = `cd ~/leecat-board-<svc> && yarn install --production=false && yarn build`) → pm2. 앱 env는 `envFrom` k8s secret `leecat-board-<svc>-config`. NFS `/volume1/DockerShare/leecat-board-<svc>` → `/storage`. 추가 git pull 등이 필요하면 `extra_commands.sh`에 넣으면 됨.
- **⚠️ vendored 공용 패키지 주의**: 각 release repo는 공용 `packages/`(board-schema/board-ui/board-sdk/artifact-runtime 등)를 **브랜치에 커밋된 형태로 vendor**한다(ext_files 아님, 모노레포 `main` 서브폴더엔 `packages/` 없음). 앱 코드가 참조하는 새 심볼이 vendored 패키지에 없으면 `yarn build`가 TS 에러로 실패하고, readiness probe가 없어 재시작 시 정상 pod가 빌드 실패 pod로 교체돼 **사이트가 502로 내려간다**(저장 이미지 없어 rollback 불가, release가 빌드돼야 복구). 앱 변경 push 시 공용 패키지도 함께 re-vendor해야 함. 복구법은 §2.1.
- **Ingress**: `sceneboard.dev`(`/`=next, `/api`=nest) + `artifact.sceneboard.dev`(=artifact). nginx class, TLS secret `sceneboard.dev`(와일드카드 `*.sceneboard.dev`).
- **DNS**: Cloudflare `sceneboard.dev` zone(Leecat.inc 계정), A → `49.247.13.48`(proxied off).

### 2.1 release 빌드 실패(502) 복구
1. 어느 서비스가 실패했는지: `ssh root@leecat-c1-s1 "$K logs -n default deploy/leecat-board-<svc> --tail=40"` — `error TS####` / `Failed to compile` 확인.
2. 원인 대부분 = vendored 공용 패키지 stale. 로컬 모노레포엔 심볼이 있는지 대조(`grep -rn <심볼> packages/<pkg>/src`).
3. 수정: 서브폴더 repo에서 `git worktree add <tmp> origin/release` → 모노레포 `packages/<pkg>/{src,test}`를 worktree의 같은 경로로 `rsync -a --delete`(node_modules/dist 제외) → `git add -A packages/ && git commit && git push origin HEAD:release`.
4. `kubectl rollout restart deployment/leecat-board-<svc>` 후 도메인 200 복귀 확인. worktree는 `git worktree remove --force <tmp>`로 정리.

### kubectl 접근 (노드에 kubectl 바이너리 없음)
`bitnami/kubectl` 도커 이미지 + cluster CA로 발급한 admin kubeconfig를 쓴다 (kubeconfig `/tmp/admin.kubeconfig` on leecat-c1-s1, cluster CA `/etc/kubernetes/ssl/kube-ca*.pem`). 발급이 없으면 재발급:
```
ssh root@leecat-c1-s1 '
  cd /tmp
  SRV=$(grep -m1 server: /etc/kubernetes/ssl/kubecfg-kube-controller-manager.yaml | awk "{print \$2}")
  [ -f admin.pem ] || { openssl genrsa -out admin-key.pem 2048;
    openssl req -new -key admin-key.pem -out admin.csr -subj "/CN=kube-admin/O=system:masters";
    openssl x509 -req -in admin.csr -CA /etc/kubernetes/ssl/kube-ca.pem -CAkey /etc/kubernetes/ssl/kube-ca-key.pem -CAcreateserial -out admin.pem -days 365; }
  printf "apiVersion: v1\nkind: Config\nclusters:\n- cluster: {certificate-authority: /etc/kubernetes/ssl/kube-ca.pem, server: %s}\n  name: local\ncontexts:\n- context: {cluster: local, user: admin}\n  name: admin\ncurrent-context: admin\nusers:\n- name: admin\n  user: {client-certificate: /tmp/admin.pem, client-key: /tmp/admin-key.pem}\n" "$SRV" > /tmp/admin.kubeconfig'
```
kubectl 실행 별칭 (이후 명령에서 `$K` 사용):
```
K="docker run --rm -u 0 --network host -v /etc/kubernetes/ssl:/etc/kubernetes/ssl:ro -v /tmp:/tmp:ro bitnami/kubectl:latest --kubeconfig=/tmp/admin.kubeconfig"
ssh root@leecat-c1-s1 "$K get deploy -n default | grep leecat-board"
```

### 릴리즈 재시작 절차 (새 release 반영)
```
# 갱신된 서비스만 재시작. pod 재생성 → 새 release clone + rebuild.
ssh root@leecat-c1-s1 "$K rollout restart deployment/leecat-board-nestjs -n default"
ssh root@leecat-c1-s1 "$K rollout restart deployment/leecat-board-nextjs -n default"
ssh root@leecat-c1-s1 "$K rollout restart deployment/leecat-board-artifact-runtime -n default"
```
- **주의**: readiness probe가 없어 새 pod가 즉시 Ready로 표시되지만 실제로는 clone+build(수분) 중이라 그동안 짧은 미서빙 구간이 있다. 빌드 완료까지 도메인으로 실서빙 복귀 확인:
  ```
  curl -s -o /dev/null -w "%{http_code}\n" https://sceneboard.dev/api/v1/auth/csrf   # nestjs
  curl -s -o /dev/null -w "%{http_code}\n" https://sceneboard.dev/login              # nextjs
  curl -s -o /dev/null -w "%{http_code}\n" https://artifact.sceneboard.dev/healthz    # artifact
  ```
- 어떤 release가 갱신됐는지: `gh api repos/leecatinc/leecat-board-<svc>/commits/release --jq '.commit.message'` — 변경된 서비스만 재시작.

---

## 3. 상태 점검 빠른 명령
```
# 개발
pm2 list | grep sceneboard
curl -s -o /dev/null -w "%{http_code}\n" https://sceneboard.leecat.co.kr/boards
curl -s -o /dev/null -w "%{http_code}\n" https://sceneboard-artifact.leecat.co.kr/healthz
# 릴리즈
ssh root@leecat-c1-s1 "$K get pod -n default | grep leecat-board"
curl -s -o /dev/null -w "%{http_code}\n" https://sceneboard.dev/login
curl -s -o /dev/null -w "%{http_code}\n" https://artifact.sceneboard.dev/healthz
```

## 4. 비밀값 위치 (값 아님, 포인터만)
- 개발 nginx TLS: `/volume1/ssl/leecat.co.kr/`, Cloudflare 토큰: `/volume1/DockerShare/nginx-proxy/certbot/cloudflare-leecat.ini`.
- 릴리즈 k8s 앱 secret: `leecat-board-<svc>-config`(k8s Opaque, `envFrom`). git PAT·DB·Redis 비밀은 이 secret 내부(출력 금지).
- MySQL/Redis(릴리즈): `49.247.13.48` (자격은 `../doitqa` 참조). 롤백·비밀 출력 금지 규칙 준수.
