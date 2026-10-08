import {
  AuthError,
  corsHeadersFor,
  destroyAllSessions,
  ensureResetTable,
  errorResponse,
  generateTempPassword,
  jsonResponse,
  requireRole,
} from "../../../shared/api";

// 管理员专用的「密码重置」接口。只有令牌里 role=admin 的人能调。
//
// 两个入口：
//   · 批准老师提交的找回申请：POST { requestId }
//   · 直接重置任意账号（老师连姓名都记不清时的兜底）：POST { uid }
// 批准和直接重置走的是同一段逻辑 —— 生成临时密码、写库、把旧登录全踢掉。
//
// 临时密码只在这一次响应里返回给管理员，由管理员转发；库里也存了一份到申请表上，
// 方便管理员事后回去看（老师没记下来时不用重复重置）。

export const onRequestOptions = (context: any) =>
  new Response(null, {
    status: 204,
    headers: corsHeadersFor(context.request, "GET, POST, DELETE, OPTIONS"),
  });

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "GET, POST, DELETE, OPTIONS");
  try {
    await requireRole(env, request, ["admin"]);
    await ensureResetTable(env);

    const { results } = await env.DB.prepare(
      `SELECT r.id, r.email, r.name, r.status, r.created_at, r.handled_at, r.temp_password,
              u.uid, u.name AS account_name, u.role
         FROM password_reset_requests r
         LEFT JOIN users u ON u.email = r.email
        ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC
        LIMIT 200`
    ).all();

    return jsonResponse(results || [], 200, cors);
  } catch (err) {
    return errorResponse(err, request);
  }
}

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "GET, POST, DELETE, OPTIONS");
  try {
    const admin = await requireRole(env, request, ["admin"]);

    const body: any = await request.json().catch(() => ({}));
    const requestId = Number(body.requestId) || 0;
    const uid = typeof body.uid === "string" ? body.uid.trim() : "";
    const dismiss = body.dismiss === true;

    if (!requestId && !uid) throw new AuthError(400, "请指定要处理的申请或账号");

    // ── 目标账号从哪来 ────────────────────────────────────────
    let target: any = null;

    if (requestId) {
      await ensureResetTable(env);
      const reqRow: any = await env.DB.prepare(
        "SELECT id, email, status FROM password_reset_requests WHERE id = ?"
      )
        .bind(requestId)
        .first();

      if (!reqRow) throw new AuthError(404, "这条申请不存在（可能已被删除）");
      if (reqRow.status !== "pending") throw new AuthError(400, "这条申请已经处理过了");

      if (dismiss) {
        await env.DB.prepare(
          "UPDATE password_reset_requests SET status = 'dismissed', handled_at = ?, handled_by = ? WHERE id = ?"
        )
          .bind(new Date().toISOString(), admin.uid, requestId)
          .run();
        return jsonResponse({ ok: true, dismissed: true, message: "已忽略这条申请" }, 200, cors);
      }

      target = await env.DB.prepare(
        "SELECT uid, email, name, role FROM users WHERE email = ?"
      )
        .bind(reqRow.email)
        .first();

      if (!target) {
        // 账号已经被删了（比如管理员之前清理过）——把申请标记掉，别让它一直挂在待办里
        await env.DB.prepare(
          "UPDATE password_reset_requests SET status = 'dismissed', handled_at = ?, handled_by = ? WHERE id = ?"
        )
          .bind(new Date().toISOString(), admin.uid, requestId)
          .run();
        throw new AuthError(400, "这个邮箱对应的账号已经不存在了（可能已被删除），申请已自动忽略");
      }
    } else {
      target = await env.DB.prepare(
        "SELECT uid, email, name, role FROM users WHERE uid = ?"
      )
        .bind(uid)
        .first();
      if (!target) throw new AuthError(404, "账号不存在");
    }

    // ── 重置 ──────────────────────────────────────────────────
    const tempPassword = generateTempPassword();

    await env.DB.prepare("UPDATE users SET password = ? WHERE uid = ?")
      .bind(tempPassword, target.uid)
      .run();

    // 和「修改密码」一样：旧登录全部作废，否则老师手机上还挂着旧会话
    await destroyAllSessions(env, target.uid);

    if (requestId) {
      await env.DB.prepare(
        `UPDATE password_reset_requests
            SET status = 'done', handled_at = ?, handled_by = ?, temp_password = ?
          WHERE id = ?`
      )
        .bind(new Date().toISOString(), admin.uid, tempPassword, requestId)
        .run();
    }

    return jsonResponse(
      {
        ok: true,
        uid: target.uid,
        email: target.email,
        name: target.name,
        role: target.role,
        tempPassword,
        message: `已为 ${target.name || target.email} 重置密码`,
      },
      200,
      cors
    );
  } catch (err) {
    return errorResponse(err, request);
  }
}

export async function onRequestDelete(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "GET, POST, DELETE, OPTIONS");
  try {
    await requireRole(env, request, ["admin"]);
    await ensureResetTable(env);

    const id = Number(new URL(request.url).searchParams.get("id")) || 0;
    if (!id) throw new AuthError(400, "缺少 id");

    await env.DB.prepare("DELETE FROM password_reset_requests WHERE id = ?").bind(id).run();
    return jsonResponse({ ok: true }, 200, cors);
  } catch (err) {
    return errorResponse(err, request);
  }
}
