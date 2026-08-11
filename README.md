# amano-valet-watch

아마노파크 발렛 예약(`api.amanopark.co.kr`) 잔여 여부를 1분 간격으로 감시해,
목표일이 `false → true`로 바뀌면 텔레그램으로 알려주는 Cloudflare Worker.

## 동작 방식

매 실행마다 순서대로:

1. **카나리아 조회** — 항상 열려 있어야 하는 날짜(`CANARY_DATE`)를 먼저 확인.
   이 API는 실패해도 에러가 아니라 `data:false`를 주기 때문에, 카나리아가 `false`면
   "환경이 막혔거나 카나리아 날짜가 실제로 만석"이라는 뜻으로 보고 그 실행의 목표일
   조회 자체를 건너뛰고 "신뢰 불가" 알림을 보낸다.
2. **목표일 조회** — 카나리아가 정상(`true`)일 때만 일반 발렛(`booking/check`)과
   프리미엄 발렛(`premium/check`)을 조회. (`booking/check`에 `type=PREMIUM`을 주면
   검증 에러 없이 조용히 `false`를 주므로 프리미엄은 반드시 별도 엔드포인트로 확인.)
3. 각 대상의 상태는 Cloudflare KV에 저장하고, `false → true` 전환에서만 알림을
   보낸다. `result.code !== 200`이 연속 `ERROR_THRESHOLD`회 나오면 에러 알림을
   한 번만 보내고(스팸 방지), 복구되면 다시 조용해진다. 응답에 `data` 필드가 없거나
   boolean이 아니면 "구조 변경" 알림을 별도로 보낸다.

## 배포 (GitHub Actions, 터미널 불필요)

`.github/workflows/deploy.yml`이 `main` 브랜치에 push될 때마다(또는 Actions
탭에서 수동 실행 시) 자동으로 Cloudflare Workers에 배포한다. 아래 GitHub
저장소 시크릿(Settings → Secrets and variables → Actions)만 채워두면 된다:

| 시크릿 이름 | 값 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare 대시보드에서 발급한 API 토큰 ("Edit Cloudflare Workers" 템플릿) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 대시보드 우측에 표시되는 계정 ID |
| `TELEGRAM_BOT_TOKEN` | @BotFather가 발급한 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 알림 받을 채팅방 ID |

KV 네임스페이스는 Cloudflare 대시보드(Workers & Pages → KV)에서 미리 만들고,
발급된 ID를 `wrangler.toml`의 `kv_namespaces[0].id`에 채워 커밋해둔다.

로컬 터미널로 배포하고 싶다면 (선택):

```bash
npm install
npx wrangler login
npx wrangler kv namespace create STATE   # id를 wrangler.toml에 채우기
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy
```

배포 후 수동 실행으로 카나리아가 살아있는지 바로 확인 가능 (선택, `DEBUG_TOKEN`
시크릿을 등록한 경우):

```bash
curl "https://<worker-subdomain>.workers.dev/run?token=<DEBUG_TOKEN>"
```

로그는 Cloudflare 대시보드의 Worker → Logs 탭 (또는 `npx wrangler tail`)에서
확인.

## 설정값 (`wrangler.toml` `[vars]`)

| 변수 | 설명 |
|---|---|
| `TARGET_DATE` | 감시할 목표 예약일. 예약 가능 범위는 오늘+60일이므로 그 안이어야 함 |
| `CANARY_DATE` | 항상 열려 있는 것으로 확인된 날짜. **이 날짜가 실제로 만석이 되면 다른 예약 가능일로 교체할 것** — "신뢰 불가" 알림이 오면 그게 신호 |
| `ERROR_THRESHOLD` | 연속 에러 몇 회에서 알림을 보낼지 |
| `API_BASE` / `BOOKING_URL` | API 베이스, 알림에 넣을 예약 페이지 링크 |

Cloudflare Cron Trigger는 `wrangler.toml`의 `[triggers] crons`에서 `"* * * * *"`
(1분 간격)로 설정되어 있음.

## 해외 호스트(Cloudflare) 검증 관련

이 API는 한국 IP에서만 검증되었고, Cloudflare Workers(해외 리전)에서의 동작은
미검증. 배포 후 카나리아가 계속 `true`로 나오면(=신뢰 불가 알림이 안 오면) 이
환경에서 정상 동작하는 것이고, 카나리아가 계속 `false`로 나오면(=신뢰 불가
알림이 반복되면) 이 환경에서는 이 API가 막혀 있다는 뜻이니 한국 IP 환경(예:
한국 리전 서버의 cron/systemd timer)으로 옮겨야 함.
