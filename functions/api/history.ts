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
    // 确保表存在（D1 兼容写法）
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS writing_records (
        id TEXT PRIMARY KEY,
        studentId TEXT,
        teacherId TEXT,
        title TEXT,
        analysis TEXT,
        date TEXT
      )`
    ).run();

    // 补加缺失列（D1 支持 ALTER TABLE ADD COLUMN）
    try { await env.DB.prepare("ALTER TABLE writing_records ADD COLUMN teacherId TEXT").run(); } catch (_) {}
    try { await env.DB.prepare("ALTER TABLE writing_records ADD COLUMN studentId TEXT").run(); } catch (_) {}

    const { results } = await env.DB.prepare(
      "SELECT * FROM writing_records WHERE studentId = ? AND teacherId = ? ORDER BY date DESC"
    ).bind(studentId, teacherId).all();

    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}
