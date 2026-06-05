export async function onRequest(context: any) {
  const { env, request } = context;
  const method = request.method;

  // CORS
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!env.DB) {
    return new Response(JSON.stringify({ error: "数据库未绑定" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    // 建表（若缺少列则补加，不重建表）
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS student_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        teacher_id TEXT,
        name TEXT,
        choice INTEGER,
        modern_reading INTEGER,
        classic_reading INTEGER,
        non_linear INTEGER,
        dictation INTEGER,
        composition INTEGER,
        total INTEGER,
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      )`
    ).run();

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS score_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        teacher_id TEXT,
        choice INTEGER,
        modern_reading INTEGER,
        classic_reading INTEGER,
        non_linear INTEGER,
        dictation INTEGER,
        composition INTEGER,
        total INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )`
    ).run();

    // 补加 teacher_id 列（兼容极旧版本）
    try { await env.DB.prepare("ALTER TABLE student_scores ADD COLUMN teacher_id TEXT").run(); } catch (_) {}
    try { await env.DB.prepare("ALTER TABLE score_history ADD COLUMN teacher_id TEXT").run(); } catch (_) {}

    // ── GET ──────────────────────────────────────────
    if (method === "GET") {
      const url = new URL(request.url);
      const teacherId = url.searchParams.get("teacher_id");
      const studentId = url.searchParams.get("student_id");
      const getHistory = url.searchParams.get("history") === "true";
      const isAdmin = url.searchParams.get("is_admin") === "true";

      if (getHistory && studentId) {
        const { results } = await env.DB.prepare(
          "SELECT * FROM score_history WHERE student_id = ? ORDER BY created_at ASC"
        ).bind(studentId).all();
        return new Response(JSON.stringify(results || []), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let query = "SELECT * FROM student_scores";
      let params: any[] = [];

      if (studentId) {
        query += " WHERE student_id = ?";
        params.push(studentId);
      } else if (isAdmin) {
        // 管理员查看全部
      } else if (teacherId) {
        query += " WHERE teacher_id = ?";
        params.push(teacherId);
      } else {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      query += " ORDER BY updated_at DESC";
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(results || []), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── POST ─────────────────────────────────────────
    if (method === "POST") {
      const body = await request.json();
      const { students, teacher_id } = body;
      if (!Array.isArray(students) || !teacher_id) {
        return new Response(JSON.stringify({ error: "数据格式错误或缺少教师ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      for (const s of students) {
        const total =
          (s.choice || 0) +
          (s.modernReading || 0) +
          (s.classicReading || 0) +
          (s.nonLinear || 0) +
          (s.dictation || 0) +
          (s.composition || 0);

        if (s.dbId) {
          // 按自增 ID 更新
          await env.DB.prepare(
            `UPDATE student_scores SET
              name=?, choice=?, modern_reading=?, classic_reading=?,
              non_linear=?, dictation=?, composition=?, total=?,
              updated_at=datetime('now','localtime')
            WHERE id=? AND teacher_id=?`
          )
            .bind(s.name, s.choice, s.modernReading, s.classicReading,
                  s.nonLinear, s.dictation, s.composition, total,
                  s.dbId, teacher_id)
            .run();

          await env.DB.prepare(
            `INSERT INTO score_history
              (student_id,teacher_id,choice,modern_reading,classic_reading,non_linear,dictation,composition,total)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
            .bind(s.id || "", teacher_id, s.choice, s.modernReading, s.classicReading,
                  s.nonLinear, s.dictation, s.composition, total)
            .run();
          continue;
        }

        // 按 student_id 查找已有记录
        if (s.id && s.id !== "N/A") {
          const existing = await env.DB.prepare(
            "SELECT id FROM student_scores WHERE student_id=? AND teacher_id=?"
          ).bind(s.id, teacher_id).first();
          if (existing) {
            await env.DB.prepare(
              `UPDATE student_scores SET
                name=?, choice=?, modern_reading=?, classic_reading=?,
                non_linear=?, dictation=?, composition=?, total=?,
                updated_at=datetime('now','localtime')
               WHERE id=?`
            )
              .bind(s.name, s.choice, s.modernReading, s.classicReading,
                    s.nonLinear, s.dictation, s.composition, total,
                    (existing as any).id)
              .run();
            await env.DB.prepare(
              `INSERT INTO score_history
                (student_id,teacher_id,choice,modern_reading,classic_reading,non_linear,dictation,composition,total)
               VALUES (?,?,?,?,?,?,?,?,?)`
            )
              .bind(s.id, teacher_id, s.choice, s.modernReading, s.classicReading,
                    s.nonLinear, s.dictation, s.composition, total)
              .run();
            continue;
          }
        }

        // 新增
        await env.DB.prepare(
          `INSERT INTO student_scores
            (student_id,teacher_id,name,choice,modern_reading,classic_reading,
             non_linear,dictation,composition,total,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`
        )
          .bind(s.id || null, teacher_id, s.name, s.choice, s.modernReading,
                s.classicReading, s.nonLinear, s.dictation, s.composition, total)
          .run();

        await env.DB.prepare(
          `INSERT INTO score_history
            (student_id,teacher_id,choice,modern_reading,classic_reading,non_linear,dictation,composition,total)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
          .bind(s.id || "", teacher_id, s.choice, s.modernReading, s.classicReading,
                s.nonLinear, s.dictation, s.composition, total)
          .run();
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ── DELETE ───────────────────────────────────────
    if (method === "DELETE") {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      const teacherId = url.searchParams.get("teacher_id");
      const isAdmin = url.searchParams.get("is_admin") === "true";

      if (!id || id === "undefined" || id === "null") {
        return new Response(JSON.stringify({ error: "无效的记录ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (isAdmin) {
        await env.DB.prepare("DELETE FROM student_scores WHERE id=?").bind(id).run();
      } else if (teacherId) {
        await env.DB.prepare(
          "DELETE FROM student_scores WHERE id=? AND teacher_id=?"
        ).bind(id, teacherId).run();
      } else {
        return new Response(JSON.stringify({ error: "权限不足" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  } catch (err: any) {
    console.error("Students API Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
