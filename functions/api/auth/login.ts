// 安全：本站页面调用本接口都是同源请求，不需要、也不下发任何跨域许可头。
// 显式处理预检，避免平台默认的 405 响应附带上 Access-Control-Allow-Origin: *。
export const onRequestOptions = () => new Response(null, { status: 204 });

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { email, password } = await request.json();

    // 安全：不再自动创建任何默认账号。
    // 旧代码会在"用户表为空"时自动创建一个写死的默认管理员（邮箱与弱口令都硬编码在源码里），
    // 由于本仓库是公开的，等于把后台钥匙挂在门上，现已移除。
    const user = await env.DB.prepare(
      "SELECT * FROM users WHERE email = ? AND password = ?"
    ).bind(email, password).first();

    if (!user) {
      return new Response(JSON.stringify({ error: "邮箱或密码错误" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(user), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
