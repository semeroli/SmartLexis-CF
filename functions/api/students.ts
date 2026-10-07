import {
  AuthError,
  assertStudentAccess,
  corsHeadersFor,
  errorResponse,
  jsonResponse,
  requireUser,
} from "../../shared/api";

// 本接口涉及"谁能看谁的成绩"，身份**只从令牌推导**。
// 原先的 ?teacher_id= / ?student_id= / ?is_admin=true 都是客户端自己填的，等于没有鉴权，已废弃。

/** 数字归一：库里可能是 null，前端可能是 undefined，统一成 0 再比较 */
function normInt(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 这次提交与库里已有的值是否完全一致。
 * 用途：值没变就跳过写入 —— 同一份 Excel 反复导入时，
 * 成长曲线不该被一堆一模一样的点灌满。
 */
function sameScore(row: any, s: any, total: number): boolean {
  return String(row.name ?? "") === String(s.name ?? "")
    && normInt(row.choice) === normInt(s.choice)
    && normInt(row.modern_reading) === normInt(s.modernReading)
    && normInt(row.classic_reading) === normInt(s.classicReading)
    && normInt(row.non_linear) === normInt(s.nonLinear)
    && normInt(row.dictation) === normInt(s.dictation)
    && normInt(row.composition) === normInt(s.composition)
    && normInt(row.total) === normInt(total);
}

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

    // ── 鉴权：以下所有分支都要求合法令牌 ──────────────
    const user = await requireUser(env, request);

    // ── GET ──────────────────────────────────────────
    if (method === "GET") {
      const url = new URL(request.url);
      const studentId = url.searchParams.get("student_id") || "";
      const getHistory = url.searchParams.get("history") === "true";

      if (getHistory) {
        if (!studentId) throw new AuthError(400, "缺少学号");
        await assertStudentAccess(env, user, studentId);
        const { results } = await env.DB.prepare(
          "SELECT * FROM score_history WHERE student_id = ? ORDER BY created_at ASC"
        ).bind(studentId).all();
        return jsonResponse(results || [], 200, cors);
      }

      let query = "SELECT * FROM student_scores";
      const params: any[] = [];

      if (studentId) {
        // 指定了某个学号：先过范围闸门，再查
        await assertStudentAccess(env, user, studentId);
        query += " WHERE student_id = ?";
        params.push(studentId);
      } else if (user.role === "admin") {
        // 管理员查看全部
      } else if (user.role === "student") {
        if (!user.studentId) return jsonResponse([], 200, cors);
        query += " WHERE student_id = ?";
        params.push(user.studentId);
      } else {
        // 教师：只看自己名下（uid 由令牌给出，不看请求参数）
        query += " WHERE teacher_id = ?";
        params.push(user.uid);
      }

      query += " ORDER BY updated_at DESC";
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return jsonResponse(results || [], 200, cors);
    }

    // ── POST（录入/更新成绩）─────────────────────────
    if (method === "POST") {
      if (user.role !== "teacher" && user.role !== "admin") {
        throw new AuthError(403, "只有教师可以录入成绩");
      }

      const body: any = await request.json().catch(() => ({}));
      const students = body.students;
      if (!Array.isArray(students)) {
        throw new AuthError(400, "数据格式错误");
      }

      // 归属教师：教师写死为自己；管理员允许显式指定（后台维护场景）
      const teacherId = user.role === "admin" && body.teacher_id ? String(body.teacher_id) : user.uid;

      // 分类计数：让前端能如实告诉老师"新增了几条、更新了几条、几条没变化"，
      // 而不是笼统地说"成功保存 N 条"。
      const stats = { inserted: 0, updated: 0, unchanged: 0 };

      for (const s of students) {
        const total =
          (s.choice || 0) +
          (s.modernReading || 0) +
          (s.classicReading || 0) +
          (s.nonLinear || 0) +
          (s.dictation || 0) +
          (s.composition || 0);

        if (s.dbId) {
          // 按自增 ID 更新（teacher_id 条件保证只能改自己的记录）
          const row: any = await env.DB.prepare(
            `SELECT name, choice, modern_reading, classic_reading, non_linear,
                    dictation, composition, total
               FROM student_scores WHERE id=? AND teacher_id=?`
          ).bind(s.dbId, teacherId).first();

          // 记录不在（可能已被删除，或不属于当前教师）：必须报错。
          // 原来无条件返回 success:true，老师会以为改成功了。
          if (!row) {
            throw new AuthError(404, `要修改的成绩记录已不存在（学号 ${s.id || s.dbId}），请刷新页面后重试`);
          }

          // 值没变就整条跳过：否则反复导入/反复点保存会往 score_history
          // 里灌一堆一模一样的点，成长曲线就失去意义了。
          if (sameScore(row, s, total)) {
            stats.unchanged++;
            continue;
          }

          const upd = await env.DB.prepare(
            `UPDATE student_scores SET
              name=?, choice=?, modern_reading=?, classic_reading=?,
              non_linear=?, dictation=?, composition=?, total=?,
              updated_at=datetime('now','localtime')
            WHERE id=? AND teacher_id=?`
          )
            .bind(s.name, s.choice, s.modernReading, s.classicReading,
                  s.nonLinear, s.dictation, s.composition, total,
                  s.dbId, teacherId)
            .run();

          // 影响行数为 0 说明没改到任何一行，不能当成成功
          if (!upd || !upd.meta || Number(upd.meta.changes) === 0) {
            throw new AuthError(409, `更新学号 ${s.id || s.dbId} 的成绩时未改动任何记录，请刷新后重试`);
          }

          await env.DB.prepare(
            `INSERT INTO score_history
              (student_id,teacher_id,choice,modern_reading,classic_reading,non_linear,dictation,composition,total)
             VALUES (?,?,?,?,?,?,?,?,?)`
          )
            .bind(s.id || "", teacherId, s.choice, s.modernReading, s.classicReading,
                  s.nonLinear, s.dictation, s.composition, total)
            .run();
          stats.updated++;
          continue;
        }

        // 按 student_id 查找已有记录（Excel 导入走这条路）
        if (s.id && s.id !== "N/A") {
          const existing: any = await env.DB.prepare(
            `SELECT id, name, choice, modern_reading, classic_reading, non_linear,
                    dictation, composition, total
               FROM student_scores WHERE student_id=? AND teacher_id=?`
          ).bind(s.id, teacherId).first();

          if (existing) {
            // 同一份 Excel 反复导入：值一样就跳过，不再往 score_history 里灌重复点
            if (sameScore(existing, s, total)) {
              stats.unchanged++;
              continue;
            }

            const upd = await env.DB.prepare(
              `UPDATE student_scores SET
                name=?, choice=?, modern_reading=?, classic_reading=?,
                non_linear=?, dictation=?, composition=?, total=?,
                updated_at=datetime('now','localtime')
               WHERE id=?`
            )
              .bind(s.name, s.choice, s.modernReading, s.classicReading,
                    s.nonLinear, s.dictation, s.composition, total,
                    existing.id)
              .run();

            if (!upd || !upd.meta || Number(upd.meta.changes) === 0) {
              throw new AuthError(409, `更新学号 ${s.id} 的成绩时未改动任何记录，请刷新后重试`);
            }

            await env.DB.prepare(
              `INSERT INTO score_history
                (student_id,teacher_id,choice,modern_reading,classic_reading,non_linear,dictation,composition,total)
               VALUES (?,?,?,?,?,?,?,?,?)`
            )
              .bind(s.id, teacherId, s.choice, s.modernReading, s.classicReading,
                    s.nonLinear, s.dictation, s.composition, total)
              .run();
            stats.updated++;
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
          .bind(s.id || null, teacherId, s.name, s.choice, s.modernReading,
                s.classicReading, s.nonLinear, s.dictation, s.composition, total)
          .run();

        await env.DB.prepare(
          `INSERT INTO score_history
            (student_id,teacher_id,choice,modern_reading,classic_reading,non_linear,dictation,composition,total)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
          .bind(s.id || "", teacherId, s.choice, s.modernReading, s.classicReading,
                s.nonLinear, s.dictation, s.composition, total)
          .run();
        stats.inserted++;
      }

      return jsonResponse({ success: true, ...stats }, 200, cors);
    }

    // ── DELETE ───────────────────────────────────────
    if (method === "DELETE") {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");

      if (!id || id === "undefined" || id === "null") {
        throw new AuthError(400, "无效的记录ID");
      }

      // 先查出这条记录归谁，再决定能不能删——不再相信请求里的 teacher_id / is_admin
      const row: any = await env.DB.prepare(
        "SELECT student_id, teacher_id FROM student_scores WHERE id=?"
      ).bind(id).first();

      if (!row) throw new AuthError(404, "记录不存在");

      if (user.role === "admin") {
        await env.DB.prepare("DELETE FROM student_scores WHERE id=?").bind(id).run();
      } else if (user.role === "teacher") {
        if (String(row.teacher_id || "") !== user.uid) {
          throw new AuthError(403, "只能删除本班学生的成绩");
        }
        await env.DB.prepare(
          "DELETE FROM student_scores WHERE id=? AND teacher_id=?"
        ).bind(id, user.uid).run();
      } else {
        throw new AuthError(403, "没有权限删除成绩");
      }

      return jsonResponse({ success: true }, 200, cors);
    }

    return jsonResponse({ error: "Method Not Allowed" }, 405, cors);
  } catch (err) {
    return errorResponse(err, request);
  }
}
