import {
  AuthError,
  corsHeadersFor,
  ensureResetTable,
  errorResponse,
  jsonResponse,
} from "../../../shared/api";

// 忘记密码 —— 提交重置申请。
//
// 这个接口**不需要登录**（忘记密码的人本来就登不进去），所以它是少数几个匿名可调的接口之一。
// 安全上靠两件事兜底：
//   ① 必须同时报对「邮箱」和「注册时填的姓名」，光知道邮箱提交不了；
//   ② 提交只是排队，**真正改密码只有管理员批准才会发生**，所以即使被乱提交也拿不到账号。
export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request) });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request);
  try {
    if (!env.DB) return jsonResponse({ error: "数据库未绑定" }, 500, cors);

    const body: any = await request.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!email || !name) throw new AuthError(400, "请填写邮箱和姓名");

    const user: any = await env.DB.prepare(
      "SELECT uid, name, role FROM users WHERE email = ?"
    )
      .bind(email)
      .first();

    // 邮箱没注册过就直接说清楚 —— 否则老师打错一个字，申请会静悄悄消失，
    // 他以为提交成功了，其实谁都没收到。（本项目注册接口本来也会提示"未找到该学号"，
    // 口径是一致的：宁可说清楚，也不要让人卡在这里。）
    if (!user) throw new AuthError(404, "这个邮箱没有注册过，请核对后再试");

    if (String(user.name || "").trim() !== name) {
      throw new AuthError(
        400,
        "姓名和注册时填的不一致，请核对后再试；如果确实想不起来，请直接找管理员"
      );
    }

    await ensureResetTable(env);

    // 同一个邮箱只允许有一条待处理申请：老师连点几次不会刷屏管理员的列表
    const pending: any = await env.DB.prepare(
      "SELECT id, created_at FROM password_reset_requests WHERE email = ? AND status = 'pending' LIMIT 1"
    )
      .bind(email)
      .first();

    if (pending) {
      return jsonResponse(
        {
          ok: true,
          duplicate: true,
          message: "您已经提交过申请了，请耐心等待管理员处理（无需重复提交）",
        },
        200,
        cors
      );
    }

    await env.DB.prepare(
      "INSERT INTO password_reset_requests (email, name) VALUES (?, ?)"
    )
      .bind(email, name)
      .run();

    return jsonResponse(
      {
        ok: true,
        duplicate: false,
        message: "申请已提交。请直接联系管理员，由管理员为您重置密码。",
      },
      200,
      cors
    );
  } catch (err) {
    return errorResponse(err, request);
  }
}
