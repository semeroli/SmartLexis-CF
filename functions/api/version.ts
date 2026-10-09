import { corsHeadersFor, jsonResponse } from "../../shared/api";

// ─────────────────────────────────────────────────────────────
// 版本探针（公开、不需要登录、不读写任何数据）
//
// 为什么要这个东西：
//   2026-10-08 修完阅卷后，王老师反馈「设了 Key 还是不行」。当时无法判断是
//   「代码没部署上去」还是「环境变量没生效」——
//     · 静态资源响应头里没有部署时间（Cloudflare 剥掉了 last-modified）
//     · 前端产物没变，HTML 也看不出新旧
//   只能靠猜。加了这个接口，一条请求就能定死：线上到底是哪一版、
//   环境变量到底注入了没有。
//
// 有意义的后端改动后，把 BUILD 改掉即可。
// ─────────────────────────────────────────────────────────────
const BUILD = "2026-10-09-ai-vision-fix";

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request) });

export function onRequestGet(context: any) {
  const env = context?.env || {};

  // 只回报「配了没有」，绝不回值本身
  const keys = String(env.MODELSCOPE_API_KEY || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  return jsonResponse(
    {
      build: BUILD,
      checks: {
        MODELSCOPE_API_KEY: keys.length ? `已配置（${keys.length} 个）` : "❌ 未配置",
        MODELSCOPE_VISION_MODEL: env.MODELSCOPE_VISION_MODEL || "（未设，用内置候选链）",
        MODELSCOPE_TEXT_MODEL: env.MODELSCOPE_TEXT_MODEL || "（未设，用内置候选链）",
        MODELSCOPE_ENDPOINT: env.MODELSCOPE_ENDPOINT || "（未设，用魔搭默认）",
        GEMINI_API_KEY: env.GEMINI_API_KEY ? "已配置" : "❌ 未配置",
        D1_DB: env.DB ? "已绑定" : "❌ 未绑定",
      },
    },
    200,
    corsHeadersFor(context.request)
  );
}
