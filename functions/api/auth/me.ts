import { corsHeadersFor, errorResponse, jsonResponse, requireUser } from "../../../shared/api";

// 用途：前端刷新页面时用它确认"本地存的令牌还算不算数"，并从服务端取回当前身份。
// 这样即使有人手工往 localStorage 里塞一个假 user 对象，也拿不到任何数据。
export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request) });

export async function onRequestGet(context: any) {
  const { request, env } = context;
  try {
    if (!env.DB) return jsonResponse({ error: "数据库未绑定" }, 500, corsHeadersFor(request));
    const user = await requireUser(env, request);
    return jsonResponse({ user }, 200, corsHeadersFor(request));
  } catch (err) {
    return errorResponse(err, request);
  }
}
