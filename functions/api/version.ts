import {
  corsHeadersFor,
  jsonResponse,
  readAiDiag,
  probeAiChain,
  claimAiProbe,
  keyFingerprint,
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
//   体检有 30 秒冷却 —— 它真花额度，不能放任连点。
//
// 有意义的后端改动后，把 BUILD 改掉即可。
// ─────────────────────────────────────────────────────────────
const BUILD = "2026-10-10-probe-verbose";

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

  const kind: AiModelKind = url.searchParams.get("kind") === "vision" ? "vision" : "text";

  // 可选：换个提示词和更长的长度，看看模型在**真实长度**下返回什么形状
  // （默认那 32 字只够它说半句"思考过程"，看不出最终答案长什么样）
  const rawTokens = Number(url.searchParams.get("tokens") || "");
  const maxTokens = Number.isFinite(rawTokens) && rawTokens > 0 ? rawTokens : undefined;
  const prompt = url.searchParams.get("say") || undefined;

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
    probe = await probeAiChain(env, kind, { maxTokens, prompt });
  } catch (e: any) {
    probe = { kind, error: String(e?.message || e).slice(0, 300) };
  }

  return jsonResponse({ ...base, probe }, 200, noStore);
}
