const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const url = new URL(request.url);
  const studentId = url.searchParams.get("studentId");
  const teacherId = url.searchParams.get("teacherId");

  if (!studentId || !teacherId) {
    return new Response(JSON.stringify({ error: "Missing studentId or teacherId" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    // ✅ 确保表存在且结构正确
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

    const { results } = await env.DB.prepare(
      "SELECT id, studentId, teacherId, title, essay_text, analysis, analysis_json, date FROM writing_records WHERE studentId = ? AND teacherId = ? ORDER BY date DESC"
    ).bind(studentId, teacherId).all();

    // 转换为前端期望的格式
    const formattedResults = (results || []).map((row: any) => ({
      id: row.id,
      studentId: row.studentId,
      teacherId: row.teacherId,
      title: row.title,
      essay_text: row.essay_text,
      analysis: row.analysis_json || row.analysis || "",
      date: row.date
    }));

    return new Response(JSON.stringify(formattedResults), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}
