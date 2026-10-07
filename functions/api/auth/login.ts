import { createSession, corsHeadersFor, errorResponse, jsonResponse } from "../../../shared/api";

// 本站页面调用本接口都是同源请求，不需要、也不下发任何跨域许可头。
// 显式处理预检，避免平台默认的 405 响应附带上 Access-Control-Allow-Origin: *。
export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request) });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  try {
    if (!env.DB) {
      return jsonResponse({ error: "数据库未绑定" }, 500, corsHeadersFor(request));
    }

    const body: any = await request.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      return jsonResponse({ error: "请输入邮箱和密码" }, 400, corsHeadersFor(request));
    }

    // 安全：不再自动创建任何默认账号。
    // 旧代码会在"用户表为空"时自动创建一个写死的默认管理员（邮箱与弱口令都硬编码在源码里），
    // 由于本仓库是公开的，等于把后台钥匙挂在门上，现已移除。
    // 另外：只取需要的列，绝不把 password 字段回传给前端。
    const user: any = await env.DB.prepare(
      "SELECT uid, email, name, role, studentId FROM users WHERE email = ? AND password = ?"
    ).bind(email, password).first();

    if (!user) {
      // 不区分"邮箱不存在"和"密码错误"，避免被用来枚举账号
      return jsonResponse({ error: "邮箱或密码错误" }, 401, corsHeadersFor(request));
    }

    // 签发会话令牌：之后所有接口都靠它认人，不再看客户端传来的任何身份参数
    const { token, expiresAt } = await createSession(env, user.uid);

    return jsonResponse({
      token,
      expiresAt,
      user: {
        uid: user.uid,
        email: user.email,
        name: user.name,
        role: user.role,
        studentId: user.studentId ?? null,
      },
    }, 200, corsHeadersFor(request));
  } catch (err) {
    return errorResponse(err, request);
  }
}
