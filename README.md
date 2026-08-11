# amano-valet-watch

아마노파크 발렛 예약(`api.amanopark.co.kr`) 잔여 여부를 감시해, 예약이
가능해지면 텔레그램으로 알려준다.

## 구조

Cloudflare Worker는 10분마다 깨어나서 **아무 체크도 하지 않고** GitHub
Actions의 `check.yml` 워크플로우를 `workflow_dispatch`로 깨우기만 한다
(`src/index.js`). 실제 예약 체크와 텔레그램 발송은 GitHub Actions 쪽
(`scripts/check.mjs`)에서 처리한다.

```
Cloudflare Cron (10분) → GitHub Actions workflow_dispatch → scripts/check.mjs → 텔레그램
```

Cloudflare를 "초침"으로만 쓰는 이유: GitHub Actions 자체 스케줄(`schedule:`)은
최소 간격이 5분이고 지연도 흔한데, Cloudflare Cron Trigger는 더 촘촘하고
안정적으로 GitHub Actions를 깨울 수 있다. 대신 실제 로직·시크릿(텔레그램
토큰 등)은 전부 GitHub Actions 쪽에 있어서 코드를 고칠 때마다 Cloudflare에
재배포할 필요가 없다 — `scripts/check.mjs`나 `check.yml`의 `TARGET_DATE` 같은
값을 고치고 GitHub에 push만 하면 다음 실행부터 바로 적용된다.

## 동작 방식 (`scripts/check.mjs`)

상태를 저장하지 않는 단순한 방식. 실행마다:

1. **카나리아 조회** — 항상 열려 있어야 하는 날짜(`CANARY_DATE`)를 먼저 확인.
   이 API는 실패해도 에러가 아니라 `data:false`를 주기 때문에, 카나리아가 `false`면
   "환경이 막혔거나 카나리아 날짜가 실제로 만석"이라는 뜻으로 보고 그 실행의 목표일
   조회 자체를 건너뛰고 "신뢰 불가" 알림을 보낸다.
2. **목표일 조회** — 카나리아가 정상(`true`)일 때만 일반 발렛(`booking/check`)과
   프리미엄 발렛(`premium/check`)을 조회. (`booking/check`에 `type=PREMIUM`을 주면
   검증 에러 없이 조용히 `false`를 주므로 프리미엄은 반드시 별도 엔드포인트로 확인.)
3. 예약 가능(`data:true`)이면 그때마다 텔레그램 알림을 보낸다. 상태를 기억하지
   않으므로 **열려 있는 동안은 실행될 때마다 계속 알림이 온다**. API 에러나
   응답 구조 변경도 발생할 때마다 바로 알린다.

## 설정

### GitHub 저장소 시크릿 (Settings → Secrets and variables → Actions)

| 이름 | 용도 | 값 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `check.yml`이 알림 보낼 때 사용 | @BotFather가 발급한 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 알림 받을 채팅방 | `8772754228` |
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`이 Worker 배포할 때 사용 | Cloudflare 대시보드에서 발급 ("Edit Cloudflare Workers" 템플릿) |
| `CLOUDFLARE_ACCOUNT_ID` | 위와 동일 | Cloudflare 대시보드 우측에 표시되는 계정 ID |
| `DISPATCH_PAT` | Worker가 GitHub Actions를 깨울 때 쓰는 토큰 | GitHub Personal Access Token (아래 참고) |

**`DISPATCH_PAT` 만들기**: GitHub 우측 상단 프로필 → Settings → Developer
settings → Personal access tokens → Fine-grained tokens → Generate new token.
Repository access는 이 저장소(`agent-icnvalet`)만 선택하고, Permissions에서
**Actions: Read and write** 권한을 준다.

### `TARGET_DATE` / `CANARY_DATE` 바꾸기

`.github/workflows/check.yml`의 `env:` 값을 고쳐서 push하면 된다 (Cloudflare
재배포 불필요). 예약 가능 범위는 오늘+60일이므로 `TARGET_DATE`는 그 안이어야
함. `CANARY_DATE`는 항상 열려 있는 것으로 확인된 날짜여야 하며, **실제로
만석이 되면 다른 날짜로 교체할 것** — "신뢰 불가" 알림이 오면 그 신호.

## 배포

`main` 브랜치에 `src/`나 `wrangler.toml`이 바뀌어 push되면(또는 Actions 탭에서
수동 실행 시) `.github/workflows/deploy.yml`이 Cloudflare Worker를 자동
배포한다. 최초 1회는 위 시크릿 5개를 모두 등록한 뒤 Actions 탭에서
**Deploy Worker** 워크플로우를 수동 실행(Run workflow)하면 된다.

이 브랜치가 아직 `main`에 머지되기 전이라면, `wrangler.toml`의 `GITHUB_REF`
값이 이 브랜치 이름으로 되어 있다 — 머지 후에는 `"main"`으로 바꿔야
Worker가 올바른 브랜치의 `check.yml`을 깨운다.

로컬 터미널로 배포하고 싶다면 (선택):

```bash
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN   # DISPATCH_PAT과 같은 값
npx wrangler deploy
```

수동으로 한 번 깨워보고 싶다면 배포된 Worker URL에 그냥 접속(GET)하면 된다
— `fetch` 핸들러도 동일하게 GitHub Actions를 깨운다. (이 URL은 인증 없이
누구나 호출 가능하니, 알고 있는 사람이 스팸성으로 반복 실행시킬 수 있다는
점은 감안할 것.)

## 해외 호스트(Cloudflare) 검증 관련

이 API는 한국 IP에서만 검증되었다. `scripts/check.mjs`는 GitHub Actions의
`ubuntu-latest` 러너(해외 IP)에서 실행되므로, 카나리아가 계속 `false`로
나오며 "신뢰 불가" 알림이 반복되면 이 실행 환경에서 API가 막혀 있다는
뜻이다. 그 경우 `check.yml`의 러너를 한국 리전 self-hosted runner로 바꾸거나,
한국 IP 서버의 cron/systemd timer로 옮겨야 한다.
