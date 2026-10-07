// ─────────────────────────────────────────────────────────────
// 共享模块：跨域白名单 + 会话鉴权
//
// 设计要点（改这个文件前先读完）：
//  · 身份**只从令牌推导**，绝不再信任 URL 参数（原来的 ?teacher_id= / ?is_admin=true
//    是客户端自己填的，等于没有鉴权）。
//  · 令牌是 32 字节随机数的十六进制串，数据库里**只存它的 SHA-256**：
//    即便数据库被读走，也拿不到可用的会话。
//  · 会话表 sessions 与 users 表 JOIN 查询：用户被删除后，其会话立即失效。
// ─────────────────────────────────────────────────────────────

// 只认这些来源的跨域请求。绑定自定义域名后，把域名加进这个数组即可（改一处就够）。
export const ALLOWED_ORIGINS = [
  "https://smartlexis-cf.pages.dev",
  "https://zhiyuxq.indevs.in",   // 自定义域名
  "http://localhost:5173",
  "http://localhost:8788",
];

export const SESSION_TTL_DAYS = 30;

export function corsHeadersFor(request: Request, methods = "GET, POST, OPTIONS"): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * 带状态码的业务异常：400 参数错 / 401 未登录 / 403 越权 / 404 不存在 / 429 超配额。
 * 抛它，外层 catch 会自动变成对应状态码的 JSON。
 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 语义化别名：鉴权/越权场景读起来更清楚（行为与 HttpError 完全一致） */
export class AuthError extends HttpError {}

/** 把异常统一转成 JSON 响应——不允许任何一条失败路径返回 HTML 页面 */
export function errorResponse(err: any, request: Request, extraHeaders: Record<string, string> = {}): Response {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError
    ? err.message
    : (err && err.message ? err.message : "服务器内部错误");
  if (status >= 500) console.error("API Error:", err);
  return jsonResponse({ error: message }, status, { ...corsHeadersFor(request), ...extraHeaders });
}

// ── 令牌基础工具 ──────────────────────────────────────────────

export interface AuthUser {
  uid: string;
  email: string;
  name: string;
  role: string;
  studentId?: string | null;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 会话表在首次用到时懒创建，和本项目其它表的做法一致（无需手工迁移）。
 * 每个 isolate 只建一次：建表是写操作，若每个请求都跑一遍，会白白吃掉 D1 的写入额度。
 */
let sessionTableReady = false;
export async function ensureSessionTable(env: any): Promise<void> {
  if (sessionTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      expires_at TEXT NOT NULL
    )`
  ).run();
  sessionTableReady = true;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") || request.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** 登录成功后签发令牌，返回明文令牌（只在这一刻存在于服务端） */
export async function createSession(env: any, uid: string): Promise<{ token: string; expiresAt: string }> {
  await ensureSessionTable(env);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400000).toISOString();

  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, uid, expires_at) VALUES (?, ?, ?)"
  ).bind(tokenHash, uid, expiresAt).run();

  // 顺手清理过期会话，避免表无限增长（失败不影响登录）
  try {
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso()).run();
  } catch (_) {}

  return { token, expiresAt };
}

/** 校验令牌并取回当前用户；无效/过期/用户已删 一律返回 null */
export async function currentUser(env: any, request: Request): Promise<AuthUser | null> {
  const token = bearerToken(request);
  if (!token) return null;
  if (!env || !env.DB) return null;

  await ensureSessionTable(env);
  const tokenHash = await sha256Hex(token);

  const row: any = await env.DB.prepare(
    `SELECT u.uid, u.email, u.name, u.role, u.studentId
       FROM sessions s JOIN users u ON u.uid = s.uid
      WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(tokenHash, nowIso()).first();

  if (!row) return null;
  return {
    uid: row.uid,
    email: row.email,
    name: row.name,
    role: row.role,
    studentId: row.studentId ?? null,
  };
}

/** 必须已登录，否则 401 */
export async function requireUser(env: any, request: Request): Promise<AuthUser> {
  const user = await currentUser(env, request);
  if (!user) throw new AuthError(401, "登录已过期，请重新登录");
  return user;
}

/** 必须是这些角色之一，否则 403（未登录则是 401） */
export async function requireRole(env: any, request: Request, roles: string[]): Promise<AuthUser> {
  const user = await requireUser(env, request);
  if (!roles.includes(user.role)) throw new AuthError(403, "没有权限执行该操作");
  return user;
}

export async function destroySession(env: any, request: Request): Promise<void> {
  const token = bearerToken(request);
  if (!token) return;
  await ensureSessionTable(env);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

// ── 数据范围判定 ──────────────────────────────────────────────

/**
 * 这个学号是否属于该教师（该教师在 student_scores 里有没有这个学号的行）。
 * 管理员不受限。
 */
export async function teacherOwnsStudent(env: any, teacherUid: string, studentId: string): Promise<boolean> {
  if (!studentId) return false;
  const row: any = await env.DB.prepare(
    "SELECT id FROM student_scores WHERE student_id = ? AND teacher_id = ? LIMIT 1"
  ).bind(studentId, teacherUid).first();
  return !!row;
}

/**
 * 这个学号在 student_scores 里挂在哪位教师名下（取第一条）。
 * 学生自己提交作文时，用它把记录归到本班教师名下，
 * 这样教师查看该生历史时（按 学号 + 自己 uid 过滤）能看到。
 */
export async function resolveOwnerTeacherId(env: any, studentId: string): Promise<string | null> {
  if (!studentId) return null;
  const row: any = await env.DB.prepare(
    "SELECT teacher_id FROM student_scores WHERE student_id = ? AND teacher_id IS NOT NULL LIMIT 1"
  ).bind(studentId).first();
  return (row && row.teacher_id) ? String(row.teacher_id) : null;
}

/** 占位学号：学生还没被导入名单时前端会传这些值，不算真实身份 */
export function isPlaceholderStudentId(studentId: string): boolean {
  const s = (studentId || "").trim().toLowerCase();
  return !s || s === "n/a" || s === "unknown" || s === "undefined" || s === "null";
}

/**
 * 统一的数据范围闸门：判断当前用户能不能读写某个学号的数据。
 * 学生 → 只能是自己的学号；教师 → 只能是本班（自己名下）的学号；管理员 → 不限。
 * 不通过就抛 403（不复用 404，避免隐瞒与误判混淆）。
 */
export async function assertStudentAccess(env: any, user: AuthUser, studentId: string): Promise<void> {
  if (!studentId) throw new AuthError(400, "缺少学号");
  if (user.role === "admin") return;
  if (user.role === "student") {
    if (user.studentId && user.studentId === studentId) return;
    throw new AuthError(403, "只能访问自己的数据");
  }
  if (user.role === "teacher") {
    if (await teacherOwnsStudent(env, user.uid, studentId)) return;
    throw new AuthError(403, "该学生不在你的班级中");
  }
  throw new AuthError(403, "没有权限访问该数据");
}

// ── AI 用量配额（应用侧兜底闸门） ─────────────────────────────
//
// 三个 AI 平台的额度上限要在各自控制台里设，但那只在"平台侧"生效：
// 谁要是拿到某个老师账号的口令，就能拿它把额度刷干净。
// 这一层按「用户 + 日期 + 接口类别」计数，超了就 429，属于应用侧的最后一道闸。
//
// 记账只在上游**调用成功之后**才 +1，失败不扣 —— 这几个平台偶发 502 的概率不低，
// 若"发起就扣"，用户会遇到"明明没出结果却提示次数用完"。

/** 各类接口的每日上限（按用户）。设 0 或负数 = 该类不限制。 */
export const AI_DAILY_LIMITS: Record<string, number> = {
  essay: 60,     // 作文阅卷：多模态、单次最贵
  analyze: 80,   // 学情分析
  practice: 60,  // 专项练习
  upgrade: 60,   // 作文升格
  tts: 200,      // 语音朗读：前端会自动预生成，调用次数天然偏多
};

const AI_KIND_LABEL: Record<string, string> = {
  essay: "作文阅卷",
  analyze: "学情分析",
  practice: "专项练习",
  upgrade: "作文升格",
  tts: "语音朗读",
};

let aiUsageTableReady = false;
/** 用量表懒创建；每个 isolate 只建一次，避免每个请求都跑一次 DDL（那是写操作） */
export async function ensureAiUsageTable(env: any): Promise<void> {
  if (aiUsageTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_usage (
      uid TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (uid, day, kind)
    )`
  ).run();
  aiUsageTableReady = true;
}

function dailyLimitFor(kind: string, env: any): number {
  // 环境变量 AI_DAILY_LIMIT 可一次性覆盖所有类别（设为 0 = 全部不限，方便临时放开）
  const raw = env ? env.AI_DAILY_LIMIT : undefined;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  const v = AI_DAILY_LIMITS[kind];
  return v === undefined ? 0 : v;
}

/** 用 UTC 日期分桶，和 Workers 的运行环境一致（服务器本来就在 UTC） */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 超配额抛 429。必须放在真正发起 AI 调用之前。 */
export async function checkAiQuota(env: any, user: AuthUser, kind: string): Promise<void> {
  const limit = dailyLimitFor(kind, env);
  if (limit <= 0) return;
  await ensureAiUsageTable(env);
  const row: any = await env.DB.prepare(
    "SELECT count FROM ai_usage WHERE uid = ? AND day = ? AND kind = ?"
  ).bind(user.uid, todayKey(), kind).first();
  const used = row ? Number(row.count) || 0 : 0;
  if (used >= limit) {
    const label = AI_KIND_LABEL[kind] || "AI 功能";
    throw new HttpError(429, `今日${label}次数已用完（上限 ${limit} 次/天），请明天再试`);
  }
}

/** 上游成功后再记账；记账本身失败不影响用户这次请求 */
export async function recordAiUsage(env: any, user: AuthUser, kind: string): Promise<void> {
  if (dailyLimitFor(kind, env) <= 0) return;
  try {
    await ensureAiUsageTable(env);
    await env.DB.prepare(
      `INSERT INTO ai_usage (uid, day, kind, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(uid, day, kind) DO UPDATE SET count = count + 1`
    ).bind(user.uid, todayKey(), kind).run();
  } catch (e) {
    console.error("recordAiUsage failed:", e);
  }
}

/** 管理侧查询某人今天各类用量（排查"怎么就被限流了"时用） */
export async function aiUsageToday(env: any, uid: string): Promise<Record<string, number>> {
  await ensureAiUsageTable(env);
  const { results } = await env.DB.prepare(
    "SELECT kind, count FROM ai_usage WHERE uid = ? AND day = ?"
  ).bind(uid, todayKey()).all();
  const out: Record<string, number> = {};
  for (const r of (results || []) as any[]) out[r.kind] = Number(r.count) || 0;
  return out;
}
