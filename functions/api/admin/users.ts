import {
  AuthError,
  corsHeadersFor,
  errorResponse,
  jsonResponse,
  requireRole,
} from "../../../shared/api";

// 用户管理接口：原先**完全没有鉴权**——任何人访问 /api/admin/users 就能拿到全部账号清单，
// 带上 ?uid= 还能直接删号。现在只有管理员（令牌里 role=admin）能进。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "GET, DELETE, OPTIONS") });

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "GET, DELETE, OPTIONS");
  try {
    await requireRole(env, request, ["admin"]);

    const { results } = await env.DB.prepare(
      "SELECT uid, email, name, role, studentId, createdAt FROM users"
    ).all();

    return jsonResponse(results || [], 200, cors);
  } catch (err) {
    return errorResponse(err, request);
  }
}

export async function onRequestDelete(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "GET, DELETE, OPTIONS");
  try {
    const admin = await requireRole(env, request, ["admin"]);

    const url = new URL(request.url);
    const uid = url.searchParams.get("uid");

    if (!uid) throw new AuthError(400, "缺少 uid");

    // 防止管理员把自己删掉（删掉后就再也进不来后台了）
    if (uid === admin.uid) throw new AuthError(400, "不能删除当前登录的账号");

    await env.DB.prepare("DELETE FROM users WHERE uid = ?").bind(uid).run();
    // 顺手清掉该用户的会话，避免"人删了但令牌还在"
    try {
      await env.DB.prepare("DELETE FROM sessions WHERE uid = ?").bind(uid).run();
    } catch (_) {}

    return jsonResponse({ success: true }, 200, cors);
  } catch (err) {
    return errorResponse(err, request);
  }
}
