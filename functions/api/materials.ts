import {
  AuthError,
  assertStudentAccess,
  corsHeadersFor,
  errorResponse,
  jsonResponse,
  requireUser,
} from "../../shared/api";

// 作文素材库。原先 ?student_id= 谁都能读、DELETE 只要同时传 student_id 就算"校验归属"
// （等于自己给自己发许可），现在一律走令牌 + 范围闸门。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "GET, POST, DELETE, OPTIONS") });

export async function onRequest(context: any) {
  const { env, request } = context;
  const method = request.method;
  const cors = corsHeadersFor(request, "GET, POST, DELETE, OPTIONS");

  if (!env.DB) {
    return jsonResponse({ error: "数据库未绑定" }, 500, cors);
  }

  try {
    const user = await requireUser(env, request);

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS writing_materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        content TEXT,
        theme TEXT,
        source_title TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )`
    ).run();

    const url = new URL(request.url);
    const studentId = url.searchParams.get("student_id") || "";

    // ── GET ───────────────────────────────────────
    if (method === "GET") {
      if (!studentId) return jsonResponse([], 200, cors);
      await assertStudentAccess(env, user, studentId);

      const { results } = await env.DB.prepare(
        "SELECT * FROM writing_materials WHERE student_id = ? ORDER BY created_at DESC"
      ).bind(studentId).all();
      return jsonResponse(results || [], 200, cors);
    }

    // ── POST ──────────────────────────────────────
    if (method === "POST") {
      const body: any = await request.json().catch(() => ({}));
      const { content, theme, source_title } = body;
      const sid = body.student_id || studentId;

      if (!sid || !content) throw new AuthError(400, "缺少必要参数");
      await assertStudentAccess(env, user, sid);

      await env.DB.prepare(
        `INSERT INTO writing_materials (student_id, content, theme, source_title)
         VALUES (?, ?, ?, ?)`
      ).bind(sid, content, theme || "其他", source_title || "未知").run();

      return jsonResponse({ success: true }, 200, cors);
    }

    // ── DELETE（先查归属再删）─────────────────────
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) throw new AuthError(400, "缺少ID");

      const row: any = await env.DB.prepare(
        "SELECT student_id FROM writing_materials WHERE id = ?"
      ).bind(id).first();

      if (!row) throw new AuthError(404, "素材不存在");

      // 归属由数据库里的记录决定，不由请求参数决定
      await assertStudentAccess(env, user, row.student_id);

      await env.DB.prepare("DELETE FROM writing_materials WHERE id = ?").bind(id).run();
      return jsonResponse({ success: true }, 200, cors);
    }

    return jsonResponse({ error: "Method Not Allowed" }, 405, cors);
  } catch (err) {
    return errorResponse(err, request);
  }
}
