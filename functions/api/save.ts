import { AuthError, assertStudentAccess, errorResponse, jsonResponse, requireUser } from "../../shared/api";

// 保存批阅记录（备用接口）。
// 注意：当前前端没有调用这个接口，且它建表用的列名与 analyze_essay / history 用的
// writing_records 结构不一致（两边都叫 writing_records 但列名不同）。本次只做鉴权加固，
// 结构问题留在后续数据类问题里统一处理——如果以后真要启用它，必须先统一表结构。
export const onRequestOptions = () => new Response(null, { status: 204 });

export const onRequest = async (context: any) => {
  const { env, request } = context;

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405);
  }

  if (!env.DB) {
    return jsonResponse({ error: "D1 数据库未配置，请在 Cloudflare 控制台绑定数据库。" }, 500);
  }

  try {
    const user = await requireUser(env, request);

    const data = await request.json();
    const { studentId, title, transcription, analysis, score } = data;

    if (!studentId) throw new AuthError(400, "缺少学号");
    await assertStudentAccess(env, user, studentId);

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS writing_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        essay_title TEXT NOT NULL,
        transcription TEXT,
        analysis_content TEXT NOT NULL,
        score INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    await env.DB.prepare(
      "INSERT INTO writing_records (student_id, essay_title, transcription, analysis_content, score) VALUES (?, ?, ?, ?, ?)"
    ).bind(studentId, title, transcription, analysis, score).run();

    return jsonResponse({ success: true }, 200);
  } catch (err: any) {
    return errorResponse(err, request);
  }
};
