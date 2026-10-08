import {
  AuthError,
  corsHeadersFor,
  createSession,
  destroyAllSessions,
  errorResponse,
  jsonResponse,
  requireUser,
} from "../../../shared/api";

// 修改密码：必须是已登录用户，且要能报出原密码。
// 身份只从令牌来（requireUser），前端传什么都不作数。
export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request) });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  try {
    if (!env.DB) return jsonResponse({ error: "数据库未绑定" }, 500, corsHeadersFor(request));

    const me = await requireUser(env, request);

    const body: any = await request.json().catch(() => ({}));
    const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    if (!oldPassword || !newPassword) throw new AuthError(400, "请填写原密码和新密码");
    if (newPassword.length < 6) throw new AuthError(400, "新密码至少 6 位");
    if (newPassword === oldPassword) throw new AuthError(400, "新密码不能和原密码一样");

    const row: any = await env.DB.prepare("SELECT password FROM users WHERE uid = ?")
      .bind(me.uid)
      .first();
    if (!row) throw new AuthError(404, "账号不存在，请重新登录");
    if (String(row.password) !== oldPassword) throw new AuthError(400, "原密码不正确");

    await env.DB.prepare("UPDATE users SET password = ? WHERE uid = ?")
      .bind(newPassword, me.uid)
      .run();

    // 关键一步：改完密码，先把该账号**所有设备**上的登录状态作废（万一密码是被人偷走的，
    // 对方的令牌必须立刻失效），再单独给当前这台设备签一张新令牌 ——
    // 这样自己不用重新登录，但别人都被踢下线。
    await destroyAllSessions(env, me.uid);
    const { token, expiresAt } = await createSession(env, me.uid);

    return jsonResponse(
      {
        ok: true,
        token,
        expiresAt,
        message: "密码已修改，其它设备上的登录已失效",
      },
      200,
      corsHeadersFor(request)
    );
  } catch (err) {
    return errorResponse(err, request);
  }
}
