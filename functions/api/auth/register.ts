import { createSession, corsHeadersFor, errorResponse, jsonResponse } from "../../../shared/api";

// 本站页面调用本接口都是同源请求，不需要、也不下发任何跨域许可头。
// 显式处理预检，避免平台默认的 405 响应附带上 Access-Control-Allow-Origin: *。
export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request) });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request);
  try {
    if (!env.DB) {
      return jsonResponse({ error: "数据库未绑定" }, 500, cors);
    }

    const payload: any = await request.json().catch(() => ({}));
    const { email, password, name, studentId } = payload;

    if (!email || !password || !name) {
      return jsonResponse({ error: "请填写邮箱、密码和姓名" }, 400, cors);
    }
    if (String(password).length < 6) {
      return jsonResponse({ error: "密码至少 6 位" }, 400, cors);
    }

    // 安全加固：注册角色由服务端强制白名单，禁止客户端自封管理员(admin)。
    // 旧代码直接信任前端传来的 role，任何人 POST {"role":"admin"} 即可创建管理员账号。
    const role: string = payload.role === "teacher" ? "teacher" : "student";

    // 确保表存在
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        uid TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        password TEXT,
        name TEXT,
        role TEXT,
        studentId TEXT,
        createdAt DATETIME
      )
    `).run();

    // 如果是学生，验证学号和姓名是否匹配老师导入的数据
    if (role === 'student' && studentId) {
      const trimmedId = String(studentId).trim();
      const trimmedName = String(name).trim();

      // 检查该学号是否已被其他用户注册
      const existingUser = await env.DB.prepare(
        "SELECT uid FROM users WHERE studentId = ?"
      ).bind(trimmedId).first();
      if (existingUser) {
        return jsonResponse({ error: "该学号已被注册，请直接登录或联系老师" }, 400, cors);
      }

      // 检查老师是否导入了该学号
      const scoreRecord: any = await env.DB.prepare(
        "SELECT name FROM student_scores WHERE student_id = ?"
      ).bind(trimmedId).first();

      if (!scoreRecord) {
        return jsonResponse({ error: "系统中未找到该学号，请联系老师确认是否已导入名单" }, 400, cors);
      }

      // 如果导入了数据，姓名必须匹配 (忽略首尾空格)
      if (String(scoreRecord.name || "").trim() !== trimmedName) {
        return jsonResponse({ error: "学号与姓名不匹配，请核对老师导入的信息" }, 400, cors);
      }
    }

    const uid = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await env.DB.prepare(
      "INSERT INTO users (uid, email, password, name, role, studentId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(uid, email, password, name, role, studentId || null, createdAt).run();

    const user = {
      uid,
      email,
      name,
      role,
      studentId: studentId || null,
    };

    // 注册成功即登录，直接签发会话令牌
    const { token, expiresAt } = await createSession(env, uid);

    return jsonResponse({ token, expiresAt, user }, 200, cors);
  } catch (err: any) {
    if (err && String(err.message || "").includes("UNIQUE constraint failed")) {
      return jsonResponse({ error: "该邮箱已被注册" }, 400, cors);
    }
    return errorResponse(err, request);
  }
}
