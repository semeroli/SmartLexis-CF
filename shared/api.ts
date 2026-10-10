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

/** 让某个账号在**所有设备**上退出登录。改密码 / 管理员重置密码后必须调用。 */
export async function destroyAllSessions(env: any, uid: string): Promise<void> {
  await ensureSessionTable(env);
  await env.DB.prepare("DELETE FROM sessions WHERE uid = ?").bind(uid).run();
}

// ── 忘记密码 / 管理员重置 ──────────────────────────────────────

/**
 * 重置申请表（懒创建，做法与 sessions 表一致，无需手工迁移）。
 *
 * 为什么不是「自助重置」：这个系统没有邮件服务，发不了验证码。
 * 所以就做成「老师提交申请 → 管理员在后台点一下批准 → 拿到临时密码」。
 * 关键点：**只有管理员批准才会真正改密码**，所以谁乱提交都拿不到账号。
 *
 * status: pending（待处理）/ done（已重置）/ dismissed（已忽略）
 */
let resetTableReady = false;
export async function ensureResetTable(env: any): Promise<void> {
  if (resetTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS password_reset_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      handled_at TEXT,
      handled_by TEXT,
      temp_password TEXT
    )`
  ).run();
  resetTableReady = true;
}

/**
 * 临时密码用的字母表：**故意剔掉 0/O、1/I/L** 这些容易看错的字符。
 * 这个密码是要在微信里发过去、老师在手机上照着敲的，念得清、敲得对最重要。
 */
const TEMP_PW_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateTempPassword(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => TEMP_PW_ALPHABET[b % TEMP_PW_ALPHABET.length]).join("");
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

// ─────────────────────────────────────────────────────────────
// AI 调用「行车记录仪」
//
// 为什么需要这个东西（2026-10-10 加的）：
//   线上出问题时我们往往**什么都看不到** —— 请求被平台中途掐断，返回一张
//   Cloudflare 自己的 502 页面，我们的日志和错误响应一起被吞掉。前端只能
//   显示一句"服务器错误"，谁也说不清卡在哪一步。
//   所以在每次 AI 调用的「开始」和「结束」各写一条记录进 D1（只保留最新一条，
//   不累积），再通过公开的 /api/version 暴露出来。
//
// 🔑 判读要点：**只有「开始」、没有「结束」** ⇒ 这次调用在中途被平台掐断了。
//    这本身就是最关键的信息（说明耗时超过了平台允许的上限）。
// ─────────────────────────────────────────────────────────────
let aiDiagTableReady = false;

async function ensureAiDiagTable(env: any): Promise<void> {
  if (aiDiagTableReady || !env?.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_diag (
      id TEXT PRIMARY KEY,
      at TEXT,
      kind TEXT,
      phase TEXT,
      elapsedMs INTEGER,
      detail TEXT
    )`
  ).run();
  aiDiagTableReady = true;
}

/** 记一次 AI 调用的阶段（started / succeeded / failed）。失败绝不影响主流程。 */
export async function writeAiDiag(
  env: any,
  kind: string,
  phase: string,
  elapsedMs: number,
  detail: string
): Promise<void> {
  try {
    await ensureAiDiagTable(env);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ai_diag (id, at, kind, phase, elapsedMs, detail)
       VALUES ('last', ?, ?, ?, ?, ?)`
    )
      .bind(new Date().toISOString(), kind, phase, Math.round(elapsedMs), String(detail).slice(0, 900))
      .run();
  } catch (_) {
    /* 记录失败不能影响正常功能 */
  }
}

/** 读最近一次记录，供 /api/version 展示 */
export async function readAiDiag(env: any): Promise<any> {
  try {
    await ensureAiDiagTable(env);
    return await env.DB.prepare(`SELECT * FROM ai_diag WHERE id = 'last'`).first();
  } catch (_) {
    return null;
  }
}

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

// ── 作文阅卷报告：可读文本的唯一来源 ───────────────────────────
//
// 数据库里同时存了两份：analysis（纯文本摘要）和 analysis_json（结构化 JSON）。
// 历史接口原先返回 `analysis_json || analysis`，于是「历史诊断记录」在刷新之后
// 显示的是一整段 {"essay_text":"…","score":52,…} 的原始 JSON，而不是报告本身。
// 读写两处统一走这里拼装，避免再出现"结构变了、显示错位"。

/** 把作文阅卷的结构化结果拼成 Markdown（前端用 ReactMarkdown 渲染）。 */
export function buildEssayReport(result: any): string {
  if (!result || typeof result !== "object") return "";
  const d = result.dimensions || {};
  return [
    `## 作文原文\n\n${result.essay_text || "（未识别）"}`,
    `## 阅卷评分\n\n总分: **${result.score ?? "?"} / 60**`,
    `### 各维度得分`,
    `- 立意深度: ${d["立意深度"] ?? "?"}/15`,
    `- 结构安排: ${d["结构安排"] ?? "?"}/15`,
    `- 语言表达: ${d["语言表达"] ?? "?"}/15`,
    `- 卷面书写: ${d["卷面书写"] ?? "?"}/15`,
    `## 优点`,
    ...((result.strengths || []) as string[]).map((s) => `- ${s}`),
    `## 不足与建议`,
    ...((result.weaknesses || []) as string[]).map((s) => `- ❌ ${s}`),
    ...((result.suggestions || []) as string[]).map((s) => `- 💡 ${s}`),
    `## 总体评价\n\n${result.summary || ""}`,
  ].join("\n");
}

/** 历史记录的可读正文：优先用 analysis_json 重拼 Markdown，否则退回纯文本列。 */
export function essayReportFromRow(row: any): string {
  const raw = row?.analysis_json;
  if (raw) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const md = buildEssayReport(parsed);
      if (md) return md;
    } catch {
      // 不是 JSON 就退回下面的纯文本列
    }
  }
  return typeof row?.analysis === "string" ? row.analysis : "";
}

// ── 魔搭（ModelScope）AI 调用 —— 带「模型降级链」────────────────
//
// 背景（2026-10-08 的一次真实故障）：AI 平台会下架 / 改名模型。那天
// `ZhipuAI/GLM-5.1` 被下架（调用回 "has no provider supported"），
// `Qwen/Qwen3-VL-8B-Instruct` 也从可用清单里消失 —— 于是学情分析、专项练习、
// 作文升格三个功能同时失效。根因不是代码写错，而是「模型名被写死在代码里」
// 这件事本身太脆：平台一改名，功能当场断，而且断得没有提示。
//
// 现在改成候选链：按顺序尝试，谁先成功就用谁，并把它记下来（isolate 级），
// 后续请求直接命中上次成功的那个。平台再改名，系统自己绕过去。
//
// 不用改代码就能换模型（Cloudflare Pages 控制台 → 环境变量）：
//   MODELSCOPE_MODEL         覆盖所有类别
//   MODELSCOPE_VISION_MODEL  只覆盖「要读图」的（作文阅卷）
//   MODELSCOPE_TEXT_MODEL    只覆盖「纯文本」的
// 值可以是逗号分隔的多个模型名，按顺序尝试，排在内置候选之前。

export type AiModelKind = "vision" | "text";

const MODELSCOPE_ENDPOINT = "https://api-inference.modelscope.cn/v1/chat/completions";

/**
 * 上游地址可配置 —— 方便整站换平台，而不用再改接口代码。
 *   通用覆盖：MODELSCOPE_ENDPOINT
 *   分类型覆盖：MODELSCOPE_VISION_ENDPOINT / MODELSCOPE_TEXT_ENDPOINT
 *
 * 之所以能"只换地址就切平台"：魔搭、智谱、SiliconFlow 的对话接口都是
 * OpenAI 兼容格式 —— 请求体 `{model, messages, temperature, max_tokens}`，
 * 响应体 `choices[0].message.content`，图片都用 `image_url`。
 * 所以切平台 = 换 endpoint + 换 key + 换模型名，三个环境变量搞定。
 *
 * 例：作文阅卷改用智谱免费视觉模型
 *   MODELSCOPE_VISION_ENDPOINT = https://open.bigmodel.cn/api/paas/v4/chat/completions
 *   MODELSCOPE_API_KEY         = <智谱 API Key>
 *   MODELSCOPE_VISION_MODEL    = glm-4v-flash
 */
export function aiEndpoint(env: any, kind: AiModelKind): string {
  const specific =
    kind === "vision" ? env?.MODELSCOPE_VISION_ENDPOINT : env?.MODELSCOPE_TEXT_ENDPOINT;
  return String(specific || env?.MODELSCOPE_ENDPOINT || "").trim() || MODELSCOPE_ENDPOINT;
}

/** 内置候选链：前面失败就自动试后面的。 */
export const DEFAULT_MODEL_CHAIN: Record<AiModelKind, string[]> = {
  /**
   * 视觉链 —— 2026-10-08 用「canvas 画诗句、看模型能否原文读出」的方式，
   * 对 10 个候选逐一实测（只回 HTTP 200 不算数，必须真读到图）。结果：
   *
   *   ✅ Shanghai_AI_Laboratory/Intern-S2-Preview   200 / 1.2s / 原文读出 ✅
   *   ⏳ deepseek-ai/DeepSeek-V4-Flash-Vision-Exp   503「SGLang 正在加载模型」（冷启动）
   *   ❌ Shanghai_AI_Laboratory/Intern-S1(-mini)    401 本账号无权限
   *   ❌ Qwen/Qwen3-VL-8B / 235B、Qwen/QVQ-72B       400 平台不提供
   *   ❌ PaddlePaddle/ERNIE-4.5-VL-28B、InternVL3_5  401 本账号无权限
   *   ❌ ZhipuAI/GLM-4.6V(-Flash)                    400 平台不提供
   *
   * 所以只留两个：一个已验证能用且快（1.2 秒，不是冷启动），一个是唯一
   * 另一个「有提供商」的（它在冷启动，留着当备胎）。其余全删 —— 留着只会
   * 让每次阅卷多花几秒去撞墙（虽然 deadModels 会兜住，但没必要）。
   */
  vision: [
    "Shanghai_AI_Laboratory/Intern-S2-Preview",
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
  ],
  // 2026-10-09 用「与线上完全相同的提示词与参数」逐个实测（4 个全军覆没）：
  //   ⏱ Qwen/Qwen3.8-Flash-Next           超时（40 秒**没有任何回应**）
  //   ⏱ deepseek-ai/DeepSeek-V4.1-Flash   超时（同上）
  //   ⏱ ZhipuAI/GLM-5.2                   超时（同上）
  //   ❌ ZhipuAI/GLM-4.7-Flash            429 限流
  //   ✅ Shanghai_AI_Laboratory/Intern-S2-Preview   200 / 22 秒 / 1143 字正文
  //
  // ⚠️ 注意是「没有任何回应」，不是报错 —— 前一天这几个还都能正常返回（200 有正文）。
  // 推测与魔搭免费额度耗尽 / 平台侧调整有关。这就是"降级链"存在的意义：
  // 平台一变，只要链里还有活着的，功能就不会整块失效。
  //
  // ⇒ 把唯一实测可用的提到首位。它读图、纯文本都能干，于是整套系统统一到它。
  //   后面几个保留作备用（万一它将来也挂了，还有得试）。
  text: [
    "Shanghai_AI_Laboratory/Intern-S2-Preview",
    "Qwen/Qwen3.8-Flash-Next",
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "ZhipuAI/GLM-4.7-Flash",
  ],
};

/** 每个类别上一次成功的模型（isolate 级；新 isolate 会回到候选链头部） */
const lastGoodModel: Partial<Record<AiModelKind, string>> = {};

/**
 * 「已经确认没戏」的模型（isolate 级）。
 *
 * 实测发现候选项里有大量「平台根本不提供这个模型」（回 400 has no provider
 * supported）和「本账号无权限」（回 401）。这类结论短期内不会变，但每次阅卷
 * 都要重新把这些死模型试一遍，白白吃掉几十秒。所以记下来，同一个 isolate 内
 * 直接跳过。
 *
 * ⚠️ 只记「确定不会变」的：400 不提供 / 401 无权限 / 403 被拒。
 * 429 限流、503 加载中、超时都是**临时**状态，绝不能记 —— 否则会把一个本来
 * 可用的模型永久拉黑。
 */
const deadModels = new Set<string>();

/**
 * 最近一次「毫无回应地超时」的时间（isolate 级），用于**短期冷却**。
 *
 * 2026-10-09 实测：有好几个模型是"请求发出去、40 秒一个字都不回"（不是报错）。
 * 这种模型一旦排在靠前的位置，每次调用都要在这里白等几十秒，把整个预算吃光，
 * 后面的候选一个都轮不上。
 *
 * 所以：某个模型**用满了它自己的单模型超时**（= 确实没回应），就冷却 2 分钟不再试。
 * ⚠️ 只冷却"用满超时"这一种情况 —— 如果只是预算快用完了才 abort（perTry 远小于
 * 单模型超时），那不能怪模型，不计入冷却。
 */
const timeoutCoolDown = new Map<string, number>();
const TIMEOUT_COOLDOWN_MS = 2 * 60 * 1000;

/** MODELSCOPE_API_KEY 支持逗号分隔多个 key，轮换使用以摊平单 key 的速率限制 */
export function modelscopeKeys(env: any): string[] {
  return String(env?.MODELSCOPE_API_KEY || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export function modelscopeModelChain(env: any, kind: AiModelKind): string[] {
  const specific = kind === "vision" ? env?.MODELSCOPE_VISION_MODEL : env?.MODELSCOPE_TEXT_MODEL;
  const merged = [
    ...String(specific || "").split(","),
    ...String(env?.MODELSCOPE_MODEL || "").split(","),
    lastGoodModel[kind] || "",
    ...DEFAULT_MODEL_CHAIN[kind],
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(merged)];
}

export interface AiAttempt {
  model: string;
  result: string;
  note?: string;
}

export interface AiCallResult {
  content: string;
  model: string;
  attempts: AiAttempt[];
}

/**
 * 调魔搭：按候选链依次尝试，返回第一个成功的内容。
 *
 * 全部失败时抛 HttpError(502)，文案里带上「每个模型分别报了什么」——
 * 这样下次平台再改模型，老师在界面上直接就能看到是谁下架了，不用再来回猜。
 */
export async function callModelscope(
  env: any,
  kind: AiModelKind,
  messages: any[],
  opts: {
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    totalBudgetMs?: number;
  } = {}
): Promise<AiCallResult> {
  const keys = modelscopeKeys(env);
  if (!keys.length) throw new HttpError(500, "MODELSCOPE_API_KEY 未配置");

  const chain = modelscopeModelChain(env, kind);
  const timeoutMs = opts.timeoutMs ?? 60000;
  // 整条链的总时间预算。
  //
  // ⚠️ 2026-10-09 实测校准：这个值**必须明显小于平台允许的请求时长**。
  // 实测数据：一次 33.5 秒的请求正常返回；一次 40.5 秒的请求被 Cloudflare
  // 自己吐了一张 502 HTML 页面（`<title>xxx | 502: Bad gateway</title>`，
  // 不是我们代码返回的 JSON）。
  // 也就是说：预算顶到 40 秒时，我们"到点收手 → 返回一句人话"的意图会落空 ——
  // 平台的线先到，用户拿到的是一张什么都看不出来的错误页，比明确报错更糟。
  // 所以取 28 秒：留足余量，保证失败时是我们自己的 JSON 先返回。
  const budgetMs = opts.totalBudgetMs ?? 28000;
  const startedAt = Date.now();
  const attempts: AiAttempt[] = [];
  // 行车记录仪：先把"这次调用开始了"记下来。万一后面被平台掐断，
  // 记录会停在 started 这个阶段 —— 那正是我们最需要知道的信号。
  await writeAiDiag(env, kind, "started", 0, `候选链：${chain.join(" → ")}`);

  for (const model of chain) {
    // 已知「平台不提供 / 本账号无权限」的模型直接跳过，不浪费老师的时间
    if (deadModels.has(model)) continue;
    // 刚刚毫无回应地超时过的模型，短期内也不再白等
    const cooledAt = timeoutCoolDown.get(model);
    if (cooledAt && Date.now() - cooledAt < TIMEOUT_COOLDOWN_MS) {
      attempts.push({ model, result: "刚超时过，暂时跳过" });
      continue;
    }
    const left = budgetMs - (Date.now() - startedAt);
    if (left <= 2500) {
      attempts.push({ model, result: "总时间已用完，未及尝试" });
      break;
    }
    const perTry = Math.min(timeoutMs, left);
    const key = keys[Math.floor(Math.random() * keys.length)];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perTry);
    try {
      const res = await fetch(aiEndpoint(env, kind), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 2500,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const note = (await res.text().catch(() => "")).slice(0, 240).replace(/\s+/g, " ");
        attempts.push({ model, result: `HTTP ${res.status}`, note });
        // 「平台不提供这个模型」(400) / 「本账号无权限」(401、403) 都是短期内
        // 不会变的结论 —— 记进黑名单，同一个 isolate 内不再重试。
        // 429 限流、503 加载中属于临时状态，不记（否则会误伤可用模型）。
        if (
          res.status === 401 ||
          res.status === 403 ||
          (res.status === 400 && /no provider supported/i.test(note))
        ) {
          deadModels.add(model);
        }
        // key 本身无效（401/403）时换模型也没用，直接停
        if (res.status === 401 || res.status === 403) break;
        continue;
      }

      const data: any = await res.json().catch(() => null);
      const msg = data?.choices?.[0]?.message || {};
      const content = String(msg.content ?? "").trim();
      const reasoning = String(msg.reasoning_content ?? "").trim();

      if (!content) {
        // 推理型模型把内容放进 reasoning_content、content 为空时，绝不能把
        // 「推理过程」当成答案端给老师 —— 记为失败，继续试下一个模型。
        attempts.push({
          model,
          result: reasoning ? "只返回了推理过程、正文为空" : "返回内容为空",
          note: reasoning.slice(0, 120),
        });
        continue;
      }

      lastGoodModel[kind] = model;
      await writeAiDiag(env, kind, "succeeded", Date.now() - startedAt, `使用 ${model}`);
      return { content, model, attempts };
    } catch (e: any) {
      clearTimeout(timer);
      const aborted = e?.name === "AbortError";
      // 用满单模型超时 ⇒ 确认是"这个模型压根没回应"，纳入冷却；
      // 若只是因为预算不够才 abort，那不能怪模型，不计。
      if (aborted && perTry >= timeoutMs) timeoutCoolDown.set(model, Date.now());
      attempts.push({
        model,
        result: aborted ? `超时(${perTry}ms)` : "请求异常",
        note: String(e?.message || e).slice(0, 160),
      });
    }
  }

  const tried = attempts.filter((a) => a.result !== "总时间已用完，未及尝试");
  const detail = tried.length
    ? tried.map((a) => `${a.model} → ${a.result}`).join("；")
    : `候选模型都已确认不可用（共 ${chain.length} 个，多为平台下架或本账号无权限）` +
      (attempts.length ? "，且剩余模型来不及尝试" : "");

  // 把「试过谁、各自报了什么」写进服务端日志（Cloudflare 的 Functions 日志里能看到）。
  // 线上再出问题时，直接看日志就能定位，不用再让老师跑诊断脚本。
  const usedSecs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(
    `[AI失败] kind=${kind} 耗时=${usedSecs}s 预算=${budgetMs}ms | ` +
      attempts
        .map((a) => `${a.model}→${a.result}${a.note ? "「" + a.note.slice(0, 90) + "」" : ""}`)
        .join(" || ")
  );

  await writeAiDiag(
    env,
    kind,
    "failed",
    Date.now() - startedAt,
    attempts.map((a) => `${a.model}→${a.result}`).join(" | ") || "全部候选被跳过"
  );

  throw new HttpError(502, `AI 服务暂不可用（${detail}）`);
}
