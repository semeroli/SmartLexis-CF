import {
  corsHeadersFor,
  jsonResponse,
  readAiDiag,
  probeAiChain,
  probeAiStream,
  probeHeartbeat,
  claimAiProbe,
  keyFingerprint,
  sseFrame,
  sseHeaders,
  type AiModelKind,
} from "../../shared/api";

// ─────────────────────────────────────────────────────────────
// 版本探针 + 模型体检（公开、不需要登录）
//
// 普通访问 /api/version
//   看：线上是哪一版、环境变量注入了没有、最近一次 AI 调用停在哪一步。
//
// 加参数 /api/version?probe=1
//   额外做一次**真实体检**：对着候选模型挨个点名，回谁活着、谁报什么错、
//   各花多久。这样线上 AI 出问题时，不用麻烦老师登录传图，一条请求就能
//   分清是「平台侧挂了 / 额度用完了」还是「我们的代码有问题」。
//   · ?probe=1           体检文本链（默认）
//   · ?probe=1&kind=vision  体检视觉链（会真发一张 64×64 白图过去）
//   · ?probe=1&stream=1  流式体检：不设总预算，测「流式下模型多久开始出字、能不能跑完」。
//                        加 &tokens=3000&timeout=60000 可把压力再调大。
//   · ?probe=1&tick=1    心跳探针：只发字节、**不调模型、不花额度**，测「平台允许一个
//                        流式响应活多久」（&seconds=120 可调，上限 120 秒）。
//                        ⚠️ 它必须存在，因为上面两个都是「跑完再一次性返回 JSON」——
//                        那样的响应自己也受同一个上限约束，量不出天花板本身。
//     加 &buffer=1      对照组：同一条代码路径、同样的时长，但过程一个字节都不发、
//                        跑完一次性吐出去。用来证明「活得更久」是"一直在传字节"带来的，
//                        而不是平台恰好变宽松了（那样结论就站不住）。
//   前两种体检有 30 秒冷却（真花额度）；心跳不花额度，所以不设冷却，可以连测。
//
// 有意义的后端改动后，把 BUILD 改掉即可。
// ─────────────────────────────────────────────────────────────
const BUILD = "2026-10-10-heartbeat-json";

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request) });

export async function onRequestGet(context: any) {
  const env = context?.env || {};
  const url = new URL(context.request.url);

  // 只回报「配了没有」，绝不回值本身
  const keys = String(env.MODELSCOPE_API_KEY || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  // 密钥指纹：让用户能在自己电脑上对同一个 Key 算同一个指纹，一比就知道
  // 「线上跑的到底是不是我手上这把」。只给 8 位哈希，反推不出 Key。
  let keyFp = "（未配置）";
  if (keys.length) {
    try {
      const fp = await keyFingerprint(keys[0]);
      keyFp = `${fp}（长度 ${keys[0].length}）`;
    } catch (_) {
      keyFp = "（指纹计算失败）";
    }
  }

  // 最近一次 AI 调用的"行车记录"。phase 停在 started 就说明中途被平台掐断了。
  let lastAiCall: any = null;
  try {
    lastAiCall = await readAiDiag(env);
  } catch (_) {}

  const base = {
    build: BUILD,
    checks: {
      MODELSCOPE_API_KEY: keys.length ? `已配置（${keys.length} 个）` : "❌ 未配置",
      MODELSCOPE_API_KEY_指纹: keyFp,
      MODELSCOPE_VISION_MODEL: env.MODELSCOPE_VISION_MODEL || "（未设，用内置候选链）",
      MODELSCOPE_TEXT_MODEL: env.MODELSCOPE_TEXT_MODEL || "（未设，用内置候选链）",
      MODELSCOPE_ENDPOINT: env.MODELSCOPE_ENDPOINT || "（未设，用魔搭默认）",
      GEMINI_API_KEY: env.GEMINI_API_KEY ? "已配置" : "❌ 未配置",
      D1_DB: env.DB ? "已绑定" : "❌ 未绑定",
    },
    lastAiCall,
  };

  const noStore = { ...corsHeadersFor(context.request), "Cache-Control": "no-store" };

  if (url.searchParams.get("probe") !== "1") {
    return jsonResponse(base, 200, noStore);
  }

  // ?probe=1&tick=1 → 心跳探针：只发字节、不调模型、不花额度，
  // 专门量「平台允许一个流式响应活多久」。别的探针都是跑完再一次性返回，
  // 那样的响应自己就受同一个上限约束，量不出天花板本身。
  // 它不花额度，所以**不设冷却**，可以连测。
  if (url.searchParams.get("tick") === "1") {
    const rawSec = Number(url.searchParams.get("seconds") || "");
    const sec = Number.isFinite(rawSec) && rawSec > 0 ? Math.min(Math.round(rawSec), 120) : 60;

    // &json=1 → **真·非流式对照组**：什么都不发，干等到时间够，再一次性返回普通 JSON。
    // 这是唯一能和"当初被掐断那种请求"对得上的形状 ——
    // 上面的 buffered 虽然也不发字节，但响应头仍是 text/event-stream、机身仍是流，
    // 拿它当对照会把「Content-Type / 响应是不是流」这个变量漏掉。
    if (url.searchParams.get("json") === "1") {
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, sec * 1000));
      return jsonResponse(
        {
          mode: "json（真·非流式）",
          seconds: sec,
          note: "没被平台掐断才可能看到这一行",
          serverElapsedMs: Date.now() - t0,
        },
        200,
        noStore
      );
    }

    return probeHeartbeat({
      seconds: sec,
      // &buffer=1 → 半对照：头和机身都还是流，但过程一个字节都不发。
      buffered: url.searchParams.get("buffer") === "1",
    });
  }

  const kind: AiModelKind = url.searchParams.get("kind") === "vision" ? "vision" : "text";

  // 可选：换个提示词、更长的长度、更长的单模型超时、指定要试的模型
  // （默认那 32 字只够它说半句"思考过程"，看不出最终答案长什么样）
  const rawTokens = Number(url.searchParams.get("tokens") || "");
  const maxTokens = Number.isFinite(rawTokens) && rawTokens > 0 ? rawTokens : undefined;
  const prompt = url.searchParams.get("say") || undefined;
  const rawTimeout = Number(url.searchParams.get("timeout") || "");
  const perModelTimeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= 1000 ? Math.min(rawTimeout, 25000) : undefined;
  const models = url.searchParams.get("models") || undefined;

  const gate = await claimAiProbe(env, 30000);
  if (!gate.ok) {
    return jsonResponse(
      {
        ...base,
        probe: {
          kind,
          skipped: true,
          retryAfterSec: gate.retryAfterSec,
          hint: `体检有 30 秒冷却，请等 ${gate.retryAfterSec} 秒后再试`,
        },
      },
      200,
      noStore
    );
  }

  let probe: any;
  try {
    // ?stream=1 → 改做**流式**体检：它不设总预算，专门用来测
    // 「流式响应到底能在平台活多久」。这决定了长产出接口（作文升格）能不能一次做完。
    if (url.searchParams.get("stream") === "1") {
      const rawStreamTimeout = Number(url.searchParams.get("timeout") || "");
      const streamTimeout =
        Number.isFinite(rawStreamTimeout) && rawStreamTimeout >= 5000
          ? Math.min(rawStreamTimeout, 60000)
          : undefined;
      probe = await probeAiStream(env, kind, {
        maxTokens,
        prompt,
        perModelTimeoutMs: streamTimeout,
        models,
      });
    } else {
      probe = await probeAiChain(env, kind, { maxTokens, prompt, perModelTimeoutMs, models });
    }
  } catch (e: any) {
    probe = { kind, error: String(e?.message || e).slice(0, 300) };
  }

  return jsonResponse({ ...base, probe }, 200, noStore);
}
