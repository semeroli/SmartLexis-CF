// ─────────────────────────────────────────────────────────────
// 根路径 `/` → 落地页，应用本身在 `/app`
//
// 之前落地页放在 `/welcome`，而 `/` 直接是登录页 —— 等于没人看得到它，
// 宣传物料白做。所以把 `/` 让给落地页（对外第一眼），应用迁到 `/app`。
//
// 为什么用 Function 而不是把 dist/index.html 换掉：
//   · 换 dist 要加构建后处理脚本，且 `npm run dev` 与本地预览会跟着变形；
//   · 这个文件只在命中 `/` 时执行，其余请求一律 next()，零影响、删掉即回滚。
//
// ⚠️ CF Pages 会把 `/welcome.html` 308 到 `/welcome`，所以先取干净地址；
//    万一取不到（构建环境差异），再退回带后缀的；都不行就 next() 交出应用页 ——
//    宁可首页回到旧行为，也绝不能 500。
// ─────────────────────────────────────────────────────────────

async function serveLanding(context: any): Promise<Response | null> {
  const assets = context?.env?.ASSETS;
  if (!assets || typeof assets.fetch !== "function") return null;

  const origin = new URL(context.request.url).origin;
  for (const path of ["/welcome", "/welcome.html"]) {
    try {
      const res = await assets.fetch(new Request(origin + path, context.request));
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/html")) continue;
      const body = await res.text();
      // 兜底判断：别把一个空壳或错误页当成落地页发出去
      if (body.length < 5000) continue;
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // 落地页会随版本更新，但又不想每次都回源 —— 让 CDN 缓存 5 分钟即可
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch (_) {
      // 继续试下一个
    }
  }
  return null;
}

export const onRequest = async (context: any) => {
  const method = (context?.request?.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return context.next();

  const url = new URL(context.request.url);
  // 只接管根路径。其它路径（含 /app、/assets、/api）原样放行。
  if (url.pathname !== "/" && url.pathname !== "/index.html") return context.next();

  const landing = await serveLanding(context);
  if (landing) {
    if (method === "HEAD") return new Response(null, { status: 200, headers: landing.headers });
    return landing;
  }
  return context.next();
};
