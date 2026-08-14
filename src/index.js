// 이 워커는 아무 체크 로직도 갖지 않는다. Cron으로 깨어나서 GitHub Actions
// workflow_dispatch를 호출하는 초침 역할만 한다. 실제 예약 체크 + 텔레그램
// 알림은 .github/workflows/check.yml (scripts/check.mjs) 쪽에서 처리한다.

async function triggerCheck(env) {
  const resp = await fetch(
    "https://api.github.com/repos/hyeokinro/agent-icnvalet/actions/workflows/check.yml/dispatches",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Cloudflare-Worker",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );
  return resp.status;
}

export default {
  async scheduled(event, env, ctx) {
    const status = await triggerCheck(env);
    console.log(`GitHub dispatch: ${status}`);
  },
  async fetch(request, env) {
    const status = await triggerCheck(env);
    return new Response(`GitHub dispatch: ${status}`, { status: 200 });
  },
};
