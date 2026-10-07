import { corsHeadersFor, destroySession, errorResponse, jsonResponse } from "../../../shared/api";

// 退出登录：把服务端这条会话删掉。
// 只清浏览器本地是没用的——令牌还在有效期内就能继续用，必须服务端作废。
export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request) });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  try {
    await destroySession(env, request);
    return jsonResponse({ success: true }, 200, corsHeadersFor(request));
  } catch (err) {
    return errorResponse(err, request);
  }
}
