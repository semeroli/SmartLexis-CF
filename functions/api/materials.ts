const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

export async function onRequest(context: any) {
  const { env, request } = context;
  const method = request.method;

  if (!env.DB) {
    return new Response(JSON.stringify({ error: "数据库未绑定" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
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
    const studentId = url.searchParams.get("student_id");

    // ── GET ───────────────────────────────────────
    if (method === "GET") {
      if (!studentId) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const { results } = await env.DB.prepare(
        "SELECT * FROM writing_materials WHERE student_id = ? ORDER BY created_at DESC"
      ).bind(studentId).all();
      return new Response(JSON.stringify(results || []), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── POST ──────────────────────────────────────
    if (method === "POST") {
      const { student_id, content, theme, source_title } = await request.json();
      if (!student_id || !content) {
        return new Response(JSON.stringify({ error: "缺少必要参数" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await env.DB.prepare(
        `INSERT INTO writing_materials (student_id, content, theme, source_title)
         VALUES (?, ?, ?, ?)`
      ).bind(student_id, content, theme || "其他", source_title || "未知").run();

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── DELETE（校验归属）────────────────────────
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      const sid = url.searchParams.get("student_id");

      if (!id) {
        return new Response(JSON.stringify({ error: "缺少ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // 必须提供 student_id 用于校验归属
      if (sid) {
        const existing = await env.DB.prepare(
          "SELECT id FROM writing_materials WHERE id = ? AND student_id = ?"
        ).bind(id, sid).first();
        if (!existing) {
          return new Response(JSON.stringify({ error: "无权删除该素材" }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }

      await env.DB.prepare("DELETE FROM writing_materials WHERE id = ?").bind(id).run();
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}
