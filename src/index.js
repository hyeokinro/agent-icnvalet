// Amano 발렛 예약 잔여 감시 워커. 상태 저장 없이 매 실행이 독립적으로 동작:
// 예약이 열려 있는 동안은 매 실행마다 계속 알림을 보낸다 (요청에 따른 단순화).
//
// 함정 노트 (스펙 참고):
// - booking/check 의 type 은 실질적으로 BASIC만 인식한다. 프리미엄 확인은
//   반드시 premium/check 를 별도로 호출해야 한다 (booking/check?type=PREMIUM
//   은 조용히 data:false 를 준다).
// - 이 API는 실패를 에러가 아니라 data:false 로 준다. 그래서 카나리아
//   (항상 열려 있어야 하는 날짜) 를 매번 같이 조회해서, false 가 나오면
//   "만석" 이 아니라 "신뢰 불가"(환경 차단 또는 카나리아 자체가 만석)로
//   처리하고 목표일 결과를 버린다.

async function callApi(env, path, params) {
  const url = new URL(env.API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    let json = null;
    let parseError = false;
    try {
      json = await res.json();
    } catch {
      parseError = true;
    }
    return { httpOk: res.ok, status: res.status, json, parseError };
  } catch (err) {
    return { httpOk: false, status: 0, json: null, parseError: true, networkError: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function evaluate(resp) {
  if (!resp.httpOk || resp.parseError || !resp.json) {
    return { status: "error", detail: resp.networkError || `HTTP ${resp.status}` };
  }
  const code = resp.json.result && resp.json.result.code;
  if (code !== 200) {
    return { status: "error", detail: (resp.json.result && resp.json.result.message) || `code=${code}` };
  }
  if (typeof resp.json.data !== "boolean") {
    return { status: "schema_broken" };
  }
  return { status: "ok", data: resp.json.data };
}

async function sendTelegram(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) {
      console.error("telegram sendMessage failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("telegram sendMessage threw", err);
  }
}

export async function run(env) {
  const canaryResp = await callApi(env, "/web/setting/booking/check", {
    date: env.CANARY_DATE,
    type: "BASIC",
  });
  const canaryEval = evaluate(canaryResp);
  const canaryLabel = `카나리아(${env.CANARY_DATE})`;

  if (canaryEval.status === "error") {
    await sendTelegram(env, `🔴 ${canaryLabel} API 오류: ${canaryEval.detail}`);
    return;
  }
  if (canaryEval.status === "schema_broken") {
    await sendTelegram(env, `🟠 ${canaryLabel} 응답 구조 변경 감지: data 필드가 없거나 boolean이 아닙니다.`);
    return;
  }
  if (canaryEval.data === false) {
    await sendTelegram(
      env,
      `⚠️ 신뢰 불가: ${canaryLabel} 결과가 false입니다.\n` +
        `환경이 차단되었거나 카나리아 날짜가 실제로 만석이 된 것일 수 있습니다.\n` +
        `만석이 맞다면 CANARY_DATE를 다른 예약 가능일로 교체하세요.\n` +
        `이번 실행의 목표일 결과는 폐기합니다.`
    );
    return;
  }

  const targets = [
    {
      label: `일반발렛(${env.TARGET_DATE})`,
      call: () => callApi(env, "/web/setting/booking/check", { date: env.TARGET_DATE, type: "BASIC" }),
    },
    {
      label: `프리미엄발렛(${env.TARGET_DATE})`,
      call: () => callApi(env, "/web/setting/premium/check", { date: env.TARGET_DATE }),
    },
  ];

  for (const target of targets) {
    const ev = evaluate(await target.call());

    if (ev.status === "error") {
      await sendTelegram(env, `🔴 ${target.label} API 오류: ${ev.detail}`);
      continue;
    }
    if (ev.status === "schema_broken") {
      await sendTelegram(env, `🟠 ${target.label} 응답 구조 변경 감지: data 필드가 없거나 boolean이 아닙니다.`);
      continue;
    }
    if (ev.data === true) {
      await sendTelegram(env, `🚗 ${target.label} 예약 가능!\n예약: ${env.BOOKING_URL}`);
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      if (!env.DEBUG_TOKEN || url.searchParams.get("token") !== env.DEBUG_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      await run(env);
      return new Response("ok");
    }
    return new Response("amano valet watch worker", { status: 200 });
  },
};
