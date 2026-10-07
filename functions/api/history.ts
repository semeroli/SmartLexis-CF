import {
  AuthError,
  assertStudentAccess,
  corsHeadersFor,
  errorResponse,
  jsonResponse,
  requireUser,
} from "../../shared/api";

// 作文批阅历史。原先要 ?studentId= 和 ?teacherId= 两个参数、且都不校验，
// 现在只认令牌：学号必须落在当前用户的可见范围内，教师身份由令牌给出。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "GET, OPTIONS") });

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "GET, OPTIONS");

  if (!env.DB) return jsonResponse({ error: "数据库未绑定" }, 500, cors);

  try {
    const user = await requireUser(env, request);

    const url = new URL(request.url);
    const studentId = url.searchParams.get("studentId") || "";

    if (!studentId) throw new AuthError(400, "缺少学号");

    // 范围闸门：学生只能看自己，教师只能看本班，管理员不限
    await assertStudentAccess(env, user, studentId);

    // 确保表存在且结构正确
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS writing_records (
        id TEXT PRIMARY KEY,
        studentId TEXT,
        teacherId TEXT,
        title TEXT,
        essay_text TEXT,
        analysis TEXT,
        analysis_json TEXT,
        date TEXT
      )`
    ).run();

    // 补加可能缺失的列
    const alterStatements = [
      "ALTER TABLE writing_records ADD COLUMN studentId TEXT",
      "ALTER TABLE writing_records ADD COLUMN teacherId TEXT",
      "ALTER TABLE writing_records ADD COLUMN essay_text TEXT",
      "ALTER TABLE writing_records ADD COLUMN analysis_json TEXT",
    ];
    for (const sql of alterStatements) {
      try { await env.DB.prepare(sql).run(); } catch (_) {}
    }

    let query =
      "SELECT id, studentId, teacherId, title, essay_text, analysis, analysis_json, date FROM writing_records WHERE studentId = ?";
    const params: any[] = [studentId];

    // 教师只看自己批阅过的记录；学生/管理员看该学号的全部记录
    if (user.role === "teacher") {
      query += " AND teacherId = ?";
      params.push(user.uid);
    }
    query += " ORDER BY date DESC";

    const { results } = await env.DB.prepare(query).bind(...params).all();

    // 转换为前端期望的格式
    const formattedResults = (results || []).map((row: any) => ({
      id: row.id,
      studentId: row.studentId,
      teacherId: row.teacherId,
      title: row.title,
      essay_text: row.essay_text,
      analysis: row.analysis_json || row.analysis || "",
      date: row.date,
    }));

    return jsonResponse(formattedResults, 200, cors);
  } catch (err) {
    return errorResponse(err, request);
  }
}
