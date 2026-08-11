// Amano 발렛 예약 잔여 감시 워커.
//
// 함정 노트 (스펙 참고):
// - booking/check 의 type 은 실질적으로 BASIC만 인식한다. 프리미엄 확인은
//   반드시 premium/check 를 별도로 호출해야 한다 (booking/check?type=PREMIUM
//   은 조용히 data:false 를 준다).
// - 이 API는 실패를 에러가 아니라 data:false 로 준다. 그래서 카나리아
//   (항상 열려 있어야 하는 날짜) 를 매번 같이 조회해서, false 가 나오면
//   "만석" 이 아니라 "신뢰 불가"(환경 차단 또는 카나리아 자체가 만석)로
//   처리하고 목표일 결과를 버린다.

const KV_KEY = "state";

function defaultState() {
  return {
    canary: {
      consecutiveErrors: 0,
      errorAlerted: false,
      schemaBroken: false,
      untrustworthyAlerted: false,
    },
    general: {
      consecutiveErrors: 0,
      errorAlerted: false,
      schemaBroken: false,
      available: null,
    },
    premium: {
      consecutiveErrors: 0,
      errorAlerted: false,
      schemaBroken: false,
      available: null,
    },
  };
}

async function loadState(kv) {
  const raw = await kv.get(KV_KEY);
  const defaults = defaultState();
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    return {
      canary: { ...defaults.canary, ...parsed.canary },
      general: { ...defaults.general, ...parsed.general },
      premium: { ...defaults.premium, ...parsed.premium },
    };
  } catch {
    return defaults;
  }
}

async function saveState(kv, state) {
  await kv.put(KV_KEY, JSON.stringify(state));
}

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

// Edge-triggered: alert once when error count crosses the threshold, then
// stay quiet until it recovers (handled by resetError) so a stuck outage
// doesn't spam a message every minute.
async function handleError(entry, ev, env, label) {
  entry.consecutiveErrors = (entry.consecutiveErrors || 0) + 1;
  const threshold = Number(env.ERROR_THRESHOLD || 3);
  if (entry.consecutiveErrors >= threshold && !entry.errorAlerted) {
    await sendTelegram(env, `🔴 ${label} API 오류 ${entry.consecutiveErrors}회 연속\n마지막 에러: ${ev.detail}`);
    entry.errorAlerted = true;
  }
}

function resetError(entry) {
  entry.consecutiveErrors = 0;
  entry.errorAlerted = false;
}

async function handleSchemaBroken(entry, env, label) {
  if (!entry.schemaBroken) {
    await sendTelegram(
      env,
      `🟠 ${label} 응답 구조 변경 감지: data 필드가 없거나 boolean이 아닙니다.\n감시기 코드 점검이 필요합니다.`
    );
    entry.schemaBroken = true;
  }
}

export async function run(env) {
  const state = await loadState(env.STATE);

  const canaryResp = await callApi(env, "/web/setting/booking/check", {
    date: env.CANARY_DATE,
    type: "BASIC",
  });
  const canaryEval = evaluate(canaryResp);
  const canaryLabel = `카나리아(${env.CANARY_DATE})`;

  if (canaryEval.status === "error") {
    await handleError(state.canary, canaryEval, env, canaryLabel);
    await saveState(env.STATE, state);
    return;
  }
  resetError(state.canary);

  if (canaryEval.status === "schema_broken") {
    await handleSchemaBroken(state.canary, env, canaryLabel);
    await saveState(env.STATE, state);
    return;
  }
  state.canary.schemaBroken = false;

  if (canaryEval.data === false) {
    if (!state.canary.untrustworthyAlerted) {
      await sendTelegram(
        env,
        `⚠️ 신뢰 불가: ${canaryLabel} 결과가 false입니다.\n` +
          `환경이 차단되었거나 카나리아 날짜가 실제로 만석이 된 것일 수 있습니다.\n` +
          `만석이 맞다면 CANARY_DATE를 다른 예약 가능일로 교체하세요.\n` +
          `이번 실행의 목표일 결과는 폐기합니다.`
      );
      state.canary.untrustworthyAlerted = true;
    }
    await saveState(env.STATE, state);
    return;
  }
  if (state.canary.untrustworthyAlerted) {
    await sendTelegram(env, `✅ ${canaryLabel} 정상 복구 (data:true). 감시를 재개합니다.`);
  }
  state.canary.untrustworthyAlerted = false;

  const targets = [
    {
      key: "general",
      label: `일반발렛(${env.TARGET_DATE})`,
      call: () => callApi(env, "/web/setting/booking/check", { date: env.TARGET_DATE, type: "BASIC" }),
    },
    {
      key: "premium",
      label: `프리미엄발렛(${env.TARGET_DATE})`,
      call: () => callApi(env, "/web/setting/premium/check", { date: env.TARGET_DATE }),
    },
  ];

  for (const target of targets) {
    const entry = state[target.key];
    const ev = evaluate(await target.call());

    if (ev.status === "error") {
      await handleError(entry, ev, env, target.label);
      continue;
    }
    resetError(entry);

    if (ev.status === "schema_broken") {
      await handleSchemaBroken(entry, env, target.label);
      continue;
    }
    entry.schemaBroken = false;

    // null (unknown, first run) never triggers an alert — only an observed
    // false -> true transition does.
    if (ev.data === true && entry.available === false) {
      await sendTelegram(env, `🚗 ${target.label} 예약 가능해졌습니다! (false → true)\n예약: ${env.BOOKING_URL}`);
    }
    entry.available = ev.data;
  }

  await saveState(env.STATE, state);
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
