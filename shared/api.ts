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
  ocr: 120,      // 作文「只认字」：拆两步后的第一步，单次比阅卷便宜得多
  analyze: 80,   // 学情分析
  practice: 60,  // 专项练习
  upgrade: 60,   // 作文升格
  tts: 200,      // 语音朗读：前端会自动预生成，调用次数天然偏多
};

const AI_KIND_LABEL: Record<string, string> = {
  essay: "作文阅卷",
  ocr: "作文识别",
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

// ─────────────────────────────────────────────────────────────
// 作文「只认字」这一步的输出解析
//
// 为什么要单独写一个解析函数、还不用 JSON：
//   这一步的输出主体是**整篇作文原文**（八百到一千字，里面必然有换行、
//   引号、顿号）。让模型把它塞进 JSON 字符串里，就得转义所有换行和引号 ——
//   实测这种长文本最容易出两种事：转义写错（JSON 解析失败）、或者被长度
//   上限截断在半句（JSON 必然不完整）。一旦解析失败，整篇原文就白认了。
//
//   所以改用**分隔符**：让模型按固定标记分成两段，我们按标记切。
//   即使它话多了几句、标记样式略有出入，也还能救回来。
// ─────────────────────────────────────────────────────────────

export interface OcrResult {
  text: string;
  handwriting: string;
}

/** 把各种可能写歪的标记都算上：===原文===、【原文】、## 原文、原文： */
function ocrMarker(word: string): RegExp {
  return new RegExp(`(?:^|\\n)[\\s>#*=\\[【]*\\s*${word}\\s*[\\]】=*\\s]*(?:\\n|$)`, "m");
}

export function parseOcrOutput(raw: string): OcrResult {
  let s = String(raw || "").trim();
  if (!s) return { text: "", handwriting: "" };

  // 模型爱套一层 ``` 代码块
  const fence = s.match(/```(?:markdown|md|text)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) s = fence[1].trim();

  // 去掉开头的客套话（"好的，以下是转写结果："）
  s = s.replace(/^(好的|好)[，,。]?[^\n]{0,30}?[:：]\s*\n?/, "").trim();

  const mText = ocrMarker("(?:原文|作文原文|正文|转写原文)").exec(s);
  let text = "";
  let before = s;

  if (mText) {
    text = s.slice(mText.index + mText[0].length).trim();
    before = s.slice(0, mText.index);
  } else {
    // 找不到"原文"标记：整段都当原文（宁可多带一点，也不能把原文丢了）
    text = s;
    before = "";
  }

  // 卷面描述：取"卷面"标记之后、原文标记之前的那一小段
  let handwriting = "";
  const mHw = ocrMarker("(?:卷面|卷面情况|卷面书写|书写情况|字迹)").exec(before);
  if (mHw) {
    handwriting = before.slice(mHw.index + mHw[0].length).trim();
  } else {
    // 没写卷面标记时，若原文前面只剩很短一行，就当它是一句卷面描述
    const lead = before.trim();
    if (lead && lead.length <= 60 && !/\n\s*\n/.test(lead)) handwriting = lead;
  }

  // 常见收尾客套话清掉
  text = text.replace(/\n*[（(]?\s*以上[^\n]{0,20}[)）]?\s*$/, "").trim();
  handwriting = handwriting.replace(/^[是为：:\s]+/, "").replace(/\s+/g, " ").trim().slice(0, 80);

  return { text, handwriting };
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
   * 视觉链 —— 2026-10-10 账号恢复后**重新实测**（发一张 64×64 白图，问"什么颜色"）：
   *
   *   ✅ deepseek-ai/DeepSeek-V4-Flash-Vision-Exp   200 / 2.0s / 正文「白色」干净无杂质
   *   ⚠️ Shanghai_AI_Laboratory/Intern-S2-Preview   200 / 2.4s / 但正文是 "Thinking Process: …"
   *   ❌ Qwen/Qwen3-VL-8B、Qwen/QVQ-72B              400 Invalid model id（平台没有）
   *   ❌ ZhipuAI/GLM-4.6V(-Flash)                    400 has no provider supported
   *
   * 🔴 顺序调换的原因（一次真实事故）：
   *   15:17 老师提交作文阅卷，结果 ——
   *     Intern-S2-Preview → 超时(32000ms)，把预算吃光
   *     DeepSeek-V4-Flash-Vision-Exp → 只剩 2818ms，也被判超时
   *   而实测后者 2 秒就能答完。**排在前面的慢模型会把整条链拖死。**
   *
   * ⇒ 快的、干净的排第一；Intern-S2-Preview 留作备胎（它能读图，只是慢+爱写思考过程）。
   */
  vision: [
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
    "Shanghai_AI_Laboratory/Intern-S2-Preview",
  ],
  /**
   * 文本链 —— 2026-10-10 账号恢复后**重新实测**（同一句提示词、max_tokens=600）：
   *
   *   ✅ Qwen/Qwen3.8-Flash-Next          200 / 4.1s / 正文 77 字，**干净**
   *   ✅ deepseek-ai/DeepSeek-V4.1-Flash  200 / 5.0s / 正文 98 字，**干净**
   *   ⚠️ Shanghai_AI_Laboratory/Intern-S2-Preview  200 / 7.8s / 正文 2344 字，**开头全是
   *        "Thinking Process: …"**（它把思考过程写进 content，且很长 —— 60 秒都说不完）
   *   ❌ ZhipuAI/GLM-4.7-Flash            429「该模型当前访问量过大」
   *
   * ⚠️ 10-09 判「Qwen / DeepSeek 超时」是在账号被平台拦的那段时间做的，那次结论作废。
   *   同一个模型现在 4~5 秒就答完。**这就是降级链的价值：平台一变，重排一次就好。**
   */
  text: [
    "Qwen/Qwen3.8-Flash-Next",
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "Shanghai_AI_Laboratory/Intern-S2-Preview",
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

/**
 * 密钥指纹：SHA-256 前 8 位。
 *
 * 用途：线上 AI 失效时，最常见的两种原因是
 *   ① 账号本身没资格（平台驳回）
 *   ② 平台上存的那把 Key，跟手上能用的那把**不是同一把**
 * 这两种从外部看起来一模一样（都是失败），但修法完全不同。
 *
 * 把「线上存的是哪一把」用指纹暴露出来，再让用户对自己的 Key 算同一个指纹
 * 一比 —— 是不是同一把，一目了然。
 *
 * ⚠️ 只取 8 位十六进制、且不可反推（SHA-256 是单向的），公开在探针里是安全的。
 *    绝不能把 Key 本身、或它的可逆变形暴露到公开接口上。
 */
export async function keyFingerprint(key: string): Promise<string> {
  return (await sha256Hex(key)).slice(0, 8);
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
  /**
   * 上游给的收尾原因。`"length"` = **输出被长度上限截断了**。
   *
   * 为什么要把这个透出来：截断和"模型本来就说这么多"从正文上分不出来。
   * 认字这一步一旦被截断，老师拿到的就是**半篇作文**，而界面上看不出异常 ——
   * 评分于是基于半篇作文给出，还显得头头是道。必须让调用方能识别出这种情况。
   */
  finishReason?: string;
}

/**
 * 去掉「思考过程」污染 —— 只在**能明确判断**的时候动手，否则原样返回。
 *
 * 背景（2026-10-10 实测）：`Shanghai_AI_Laboratory/Intern-S2-Preview` 会把推理过程
 * 直接写进 `content`，形如
 *   "Thinking Process:\n\n1.  **Analyze the Request:** … 2. **Final Answer:** …"
 * 而 `callModelscope` 原本只看 `reasoning_content`，对这种情况毫无察觉，
 * 于是老师会在学情分析里看到一大段"分析我的要求…"。
 *
 * ⚠️ 这里做得非常保守：
 *   · 只有**开头**就是思考标记时才进入处理（正常正文绝不受影响）
 *   · 只有**找得到明确的"正文开始"标记**时才截断
 *   · 找不到标记 ⇒ 原样返回（宁可留着，也不能把真正的答案剪掉）
 *   · 截断后如果剩余过短（<20 字），认定是误判 ⇒ 退回原文
 *
 * 为什么不用「模型内部会自己分开」来回避：因为这是上游的返回结构问题，
 * 我们控制不了；能做的只有"降级链里优先选不这么干的模型" + "兜一层网"。
 */
export function stripThinkingNoise(raw: string): string {
  const s = String(raw || "").trim();
  if (!/^(thinking\s*process|reasoning\b|思考过程|推理过程|我的思考)/i.test(s)) return s;

  const markers: RegExp[] = [
    /\*\*\s*(final answer|final response|answer|response|final)\s*\*{0,2}\s*[:：]/i,
    /(最终回答|最终答案|答案如下|正文如下|回复如下|我的回答|结果如下|分析如下|以下是[\u4e00-\u9fa5]{0,6})\s*[:：]/,
    /^\s*#{1,3}\s*(总体评价|一[、.]\s*总体评价)/m,
  ];

  let best: { index: number; len: number } | null = null;
  for (const m of markers) {
    const hit = s.match(m);
    if (hit && typeof hit.index === "number" && hit.index > 0) {
      if (!best || hit.index < best.index) best = { index: hit.index, len: hit[0].length };
    }
  }
  if (!best) return s;

  // 从"正文开始"标记之后取，并把残留的星号/冒号/空白擦干净
  const tail = s.slice(best.index + best.len).replace(/^[\s*:：]+/, "").trim();
  return tail.length >= 12 ? tail : s;
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
      const finishReason = String(data?.choices?.[0]?.finish_reason || "");
      const rawContent = String(msg.content ?? "").trim();
      const stripped = stripThinkingNoise(rawContent);
      const content = stripped;
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
      // 记录里带上「正文开头」—— 一来能看出模型有没有把"思考过程"混进正文
      // （2026-10-10 实测 Intern-S2-Preview 会把 `Thinking Process:` 写进 content），
      // 二来出问题时有据可查，不用再让老师截图。
      await writeAiDiag(
        env,
        kind,
        "succeeded",
        Date.now() - startedAt,
        `使用 ${model} ｜ 正文 ${content.length} 字` +
          (finishReason ? ` ｜ finish=${finishReason}` : "") +
          ` ｜ 开头：${content.slice(0, 140).replace(/\s+/g, " ")}`
      );
      return { content, model, attempts, finishReason };
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

// ─────────────────────────────────────────────────────────────
// 流式调用（SSE）—— 「边生成边显示」
//
// 为什么要做（2026-10-10 实测）：
//   这套免费模型现在只有约 30～45 字/秒，而 Cloudflare 免费版单请求最多撑到
//   约 33.5 秒（实测 40.5 秒会被 CF 直接掐断、返回它自己的错误页）。两条一乘，
//   单次调用最多只能产出 1000～1400 字 —— 而「学情分析 / 专项练习 / 作文升格」
//   产出都在 1500 字以上，**已经顶到上限，随时会偶发失败**。
//
//   改成流式之后有两个好处：
//     ① 老师不用干等 —— 字是一个一个蹦出来的，等待感基本消失；
//     ② 请求从第一秒起就一直在传字节，不再是「上游闷头算 30 秒」，
//        更不容易被平台的空闲判断掐断。
//
// ⚠️ 一个绕不开的限制：**降级链在流式里只能覆盖"开流之前"的失败**。
//    一旦我们已经把字节发给浏览器了，就不可能再换一个模型从头吐一遍
//    （老师会看到两篇文章接在一起）。所以：
//      · 只有上游返回非 2xx 时，才继续试下一个模型（这部分和原来一样）；
//      · 一旦开流，模型中途断掉就只能如实报错，让老师重试一次。
//    这也是为什么"把最快的、最稳的模型排链首"依然是最重要的事。
// ─────────────────────────────────────────────────────────────

export interface AiStreamHandshake {
  /** 上游的流式响应，**尚未被消费** —— 交给 pipeAiStream 转发 */
  response: Response;
  model: string;
  attempts: AiAttempt[];
}

/** 一次调用最多允许下发多少字节。防止失控的流把请求拖到被平台掐断。 */
const STREAM_SAFETY_MS = 60000;

/**
 * 和 callModelscope 用**同一条候选链、同一套超时预算**，唯一区别是 `stream: true`。
 * 返回还没被读过的上游响应；全部候选都失败时抛 HttpError(502)。
 *
 * 注意：这里**不做** stripThinkingNoise —— 流式下正文是一点点来的，
 * 中途无法判断开头那段是不是"思考过程"。剥除动作放在收尾时做（见 transformFinal）。
 */
export async function callModelscopeStream(
  env: any,
  kind: AiModelKind,
  messages: any[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    totalBudgetMs?: number;
  } = {}
): Promise<AiStreamHandshake> {
  const keys = modelscopeKeys(env);
  if (!keys.length) {
    throw new HttpError(500, "AI 服务未配置（缺少 MODELSCOPE_API_KEY）");
  }

  const chain = modelscopeModelChain(env, kind);
  const timeoutMs = opts.timeoutMs ?? 60000;
  // 流式下的"超时"含义会和同步调用不同 —— 它约束的是**整个流的持续时长**，
  // 而不是"多久之内必须出完"。所以给得比同步宽松一点（默认 +8 秒），
  // 否则一个正常但较慢的长文生成会被自己掐断。
  const streamTimeoutMs = timeoutMs + 8000;
  const budgetMs = opts.totalBudgetMs ?? 28000;
  const startedAt = Date.now();
  const attempts: AiAttempt[] = [];

  await writeAiDiag(env, kind, "started", 0, `流式 ｜ 候选链：${chain.join(" → ")}`);

  for (const model of chain) {
    if (deadModels.has(model)) continue;
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
    const perTry = Math.min(streamTimeoutMs, left);
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
          stream: true,
        }),
        signal: controller.signal,
      });
      // ⚠️ 这里**不能** clearTimeout：定时器要陪着整个流走完，
      //    否则上游开流之后就不受控了，可能挂着不动直到平台掐断。
      //    真正的清理在返回的流收尾时做（见 consumeUpstream）。
      if (!res.ok) {
        clearTimeout(timer);
        const note = (await res.text().catch(() => "")).slice(0, 240).replace(/\s+/g, " ");
        attempts.push({ model, result: `HTTP ${res.status}`, note });
        if (
          res.status === 401 ||
          res.status === 403 ||
          (res.status === 400 && /no provider supported/i.test(note))
        ) {
          deadModels.add(model);
        }
        if (res.status === 401 || res.status === 403) break;
        continue;
      }

      lastGoodModel[kind] = model;
      // 把中止控制器挂在 response 上带出去，由转发层负责 clearTimeout
      (res as any).__slAbortTimer = timer;
      (res as any).__slController = controller;
      return { response: res, model, attempts };
    } catch (e: any) {
      clearTimeout(timer);
      const aborted = e?.name === "AbortError";
      if (aborted && perTry >= streamTimeoutMs) timeoutCoolDown.set(model, Date.now());
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

  console.error(
    `[AI失败·流式] kind=${kind} 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s | ` +
      attempts.map((a) => `${a.model}→${a.result}${a.note ? "「" + a.note.slice(0, 90) + "」" : ""}`).join(" || ")
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

const SSE_ENCODER = new TextEncoder();

/** 把一个小对象包成一帧 SSE，浏览器侧按 `data: {...}` 逐行解析。 */
export function sseFrame(obj: Record<string, any>): Uint8Array {
  return SSE_ENCODER.encode("data: " + JSON.stringify(obj) + "\n\n");
}

/**
 * 需要的响应头。
 *   · `text/event-stream`：告诉浏览器这是流，fetch 的 body 可以边收边读；
 *   · `no-store` + `X-Accel-Buffering: no`：避免中间层攒够一大块才转发，
 *     那样"边生成边显示"就退化成"等半天一次性出现"。
 */
export function sseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...extra,
  };
}

/**
 * 前端用 `?stream=1` 表示「请用流式返回」。
 *
 * 为什么不把接口直接改成只支持流式：同一份代码里留着非流式那条路，
 * 一是测试脚本、诊断工具还在按 JSON 用；二是万一流式在某个环境里被中间层
 * 攒着不转发，我们能随时把前端换回 `?stream=0` 立刻恢复，不用回滚部署。
 */
export function wantsStream(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.get("stream") === "1";
  } catch (_) {
    return false;
  }
}

/**
 * 把上游的流式响应转成我们自己的小信封，边收边下发。
 *
 * 下发的事件（每帧都是 `{type: ...}`）：
 *   meta   —— 一开始就发，带模型名。老师能知道这次是谁在写。
 *   delta  —— 增量正文。前端把它累加起来实时显示。
 *   done   —— 流正常结束。带 `onComplete` 的返回值（落库结果、解析好的 JSON 等）。
 *   error  —— 出错了。带一句人话，前端直接显示。
 *
 * ⚠️ 无论成功失败都必须把流关掉：中途抛异常又不 close，浏览器会一直等，
 *    表现就是"卡住不动"，比明确报错更糟。
 */
export function pipeAiStream(
  upstream: Response,
  model: string,
  opts: {
    /** 流正常收尾后调用；返回值随 done 事件下发。抛错 ⇒ 变成 error 事件。 */
    onComplete: (full: string, finishReason: string) => Promise<Record<string, any>> | Record<string, any>;
    /** 收尾时对完整正文做一次加工（例如剥掉思考过程）；同时用于 done 载荷里的 text */
    transformFinal?: (full: string) => string;
    /** 只想下发增量文本时用；默认直接下发 delta.content */
    extraHeaders?: Record<string, string>;
    /**
     * 本次流的硬停上限（毫秒）。默认 STREAM_SAFETY_MS。
     * 长产出接口（作文升格要吐 2500 字）需要比默认更宽 ——
     * 实测免费模型只有 30～45 字/秒，2500 字就要 55～80 秒，
     * 默认 60 秒会把一个"正常但慢"的生成当成故障掐掉。
     */
    safetyMs?: number;
  }
): Response {
  const timer = (upstream as any).__slAbortTimer;
  const abortController = (upstream as any).__slController;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      let finishReason = "";
      let closed = false;
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch (_) {} } };
      const send = (obj: Record<string, any>) => {
        if (closed) return;
        try { controller.enqueue(sseFrame(obj)); } catch (_) { closed = true; }
      };

      const safetyMs = opts.safetyMs && opts.safetyMs > 0 ? opts.safetyMs : STREAM_SAFETY_MS;
      const hardStop = setTimeout(() => {
        try { abortController?.abort(); } catch (_) {}
        send({ type: "error", message: "生成时间过长已中止，请重试一次" });
        close();
      }, safetyMs);

      try {
        send({ type: "meta", model });

        const reader = upstream.body?.getReader();
        if (!reader) throw new Error("上游没有返回流式内容");

        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // SSE 以空行分帧；这里按行处理，把不完整的最后一段留在 buf 里。
          // ⚠️ 一定要留着 —— 一个 JSON 帧可能被 TCP 切成两段，
          //    直接 JSON.parse 会失败，而且丢的是正文。
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let obj: any = null;
            try { obj = JSON.parse(payload); } catch (_) { continue; }
            const choice = obj?.choices?.[0];
            if (choice?.finish_reason) finishReason = String(choice.finish_reason);
            // 同时兼容 delta（流式）与 message（个别平台流里也塞 message）
            const piece = String(choice?.delta?.content ?? choice?.message?.content ?? "");
            if (piece) {
              full += piece;
              send({ type: "delta", text: piece });
            }
          }
        }

        // 正常结束
        if (!full.trim()) {
          // 上游 200 但一个字都没吐（实测遇到过）。这时**不要**调 onComplete ——
          // 否则会记一次"成功"的用量，还把空结果落库。
          console.error(`pipeAiStream: 上游 ${model} 返回空正文`);
          send({ type: "error", message: "AI 没有返回任何内容，请重试一次" });
        } else {
          const finalText = opts.transformFinal ? opts.transformFinal(full) : full;
          const payload = await opts.onComplete(full, finishReason);
          send({ type: "done", text: finalText, model, finishReason, ...payload });
        }
      } catch (e: any) {
        // 调用方在 onComplete 里主动抛 HttpError(502, "……") 时，文案本来就是给老师看的，
        // 直接原样下发；只有意料之外的异常才套上"中途中断"的壳。
        const isExpected = e instanceof HttpError;
        const msg = isExpected
          ? e.message
          : "生成中途中断（" + String(e?.message || e).slice(0, 120) + "），请重试一次";
        console.error("pipeAiStream error:", String(e?.message || e));
        send({ type: "error", message: msg });
      } finally {
        clearTimeout(hardStop);
        if (timer) clearTimeout(timer);
        close();
      }
    },
  });

  return new Response(body, { status: 200, headers: sseHeaders(opts.extraHeaders) });
}


// ─────────────────────────────────────────────────────────────
// 模型体检（公开自检用，配 /api/version?probe=1）
//
// 为什么需要它：
//   线上 AI 一出问题，我们分不清是「平台侧挂了 / 免费额度用完了」还是
//   「我们自己的代码有问题」。而要在线上复现，就必须登录、传图、等 30 秒，
//   排查一次要麻烦老师好几步。
//   这个函数把「对着候选链挨个点名」做成**一次请求**：谁活着、谁报什么错、
//   各花多久、回来的正文有多长，一次全看见。
//
// ⚠️ 它刻意**不碰** callModelscope 的三个 isolate 状态
//   （lastGoodModel / deadModels / timeoutCoolDown）——
//   体检就是体检，不能顺手把真实调用要用的判断改掉。
// ─────────────────────────────────────────────────────────────

/** 64×64 纯白 PNG。用来做视觉模型的「你能不能真读到一张图」最小验证。 */
export const PROBE_TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAXklEQVR4nO3PMQ0AMAzAsPInvYLYYVWKESTzjhsd8KsBrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BbQHKU9LC7/CP1AAAAABJRU5ErkJggg==";

export interface AiProbeItem {
  model: string;
  status: string;
  ms: number;
  textChars?: number;
  note?: string;
}

export interface AiProbeResult {
  kind: AiModelKind;
  endpoint: string;
  chain: string[];
  perModelTimeoutMs: number;
  maxTokens: number;
  results: AiProbeItem[];
}

export async function probeAiChain(
  env: any,
  kind: AiModelKind,
  opts: {
    perModelTimeoutMs?: number;
    totalBudgetMs?: number;
    maxTokens?: number;
    prompt?: string;
    /** 指定要试的模型名（逗号分隔也行）—— 用来摸候选池，不用改代码 */
    models?: string[] | string;
  } = {}
): Promise<AiProbeResult> {
  const keys = modelscopeKeys(env);
  const asked = Array.isArray(opts.models)
    ? opts.models
    : String(opts.models || "").split(",");
  const named = asked.map((s) => String(s).trim()).filter(Boolean);
  const chain = named.length ? [...new Set(named)].slice(0, 12) : modelscopeModelChain(env, kind);
  const endpoint = aiEndpoint(env, kind);
  const perModelTimeoutMs = opts.perModelTimeoutMs ?? 8000;
  // 总预算跟着单模型超时走（否则「特意放长超时」会被总预算先掐死）；
  // 但绝不越过平台那条线 —— 实测 40.5 秒的请求会被 CF 自己吐 502 HTML。
  const budgetMs = opts.totalBudgetMs ?? Math.min(Math.max(26000, perModelTimeoutMs * 2 + 4000), 32000);
  const maxTokens = Math.min(Math.max(opts.maxTokens ?? 32, 8), 2000);
  const defaultPrompt = kind === "vision" ? "这张图是什么颜色？只回答颜色名。" : "请只回复两个字：正常";
  const askText = String(opts.prompt || defaultPrompt).slice(0, 500);
  const startedAt = Date.now();
  const results: AiProbeItem[] = [];

  const messages =
    kind === "vision"
      ? [
          {
            role: "user",
            content: [
              { type: "text", text: askText },
              { type: "image_url", image_url: { url: PROBE_TINY_PNG } },
            ],
          },
        ]
      : [{ role: "user", content: askText }];

  for (const model of chain) {
    if (!keys.length) {
      results.push({ model, status: "❌ MODELSCOPE_API_KEY 未配置", ms: 0 });
      continue;
    }
    const left = budgetMs - (Date.now() - startedAt);
    if (left < perModelTimeoutMs / 2) {
      results.push({ model, status: "未测（总时间已用完）", ms: 0 });
      continue;
    }
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(perModelTimeoutMs, left));
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${keys[0]}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens, stream: false }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const raw = await res.text().catch(() => "");
      let content = "";
      try {
        const d: any = JSON.parse(raw);
        const msg = d?.choices?.[0]?.message || {};
        content = String(msg.content || msg.reasoning_content || "");
      } catch (_) {}
      results.push({
        model,
        status: res.ok ? "✅ HTTP 200" : `❌ HTTP ${res.status}`,
        ms: Date.now() - t0,
        textChars: content.length,
        // 限流时把整段原文留着（很短），正常时给正文片段
        note: (res.ok ? content || raw : raw).slice(0, 400).replace(/\s+/g, " "),
      });
    } catch (e: any) {
      clearTimeout(timer);
      const aborted = e?.name === "AbortError";
      results.push({
        model,
        status: aborted ? "⏱ 无任何回应（超时）" : "❌ 请求异常",
        ms: Date.now() - t0,
        note: String(e?.message || e).slice(0, 160),
      });
    }
  }

  return { kind, endpoint, chain, perModelTimeoutMs, maxTokens, results };
}

/**
 * 体检闸门：同一个实例 30 秒内只允许体检一次。
 * 体检会真花掉一次模型调用，放任连点等于把本就不宽裕的免费额度打光。
 * 拿不到闸门（比如 D1 抽风）时不拦 —— 排查优先。
 */
let aiProbeTableReady = false;

export async function claimAiProbe(
  env: any,
  cooldownMs = 30000
): Promise<{ ok: boolean; retryAfterSec: number }> {
  try {
    if (!env?.DB) return { ok: true, retryAfterSec: 0 };
    if (!aiProbeTableReady) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS ai_probe (id TEXT PRIMARY KEY, at TEXT)`
      ).run();
      aiProbeTableReady = true;
    }
    const row: any = await env.DB.prepare(`SELECT at FROM ai_probe WHERE id = 'last'`).first();
    if (row?.at) {
      const elapsed = Date.now() - new Date(row.at).getTime();
      if (elapsed >= 0 && elapsed < cooldownMs) {
        return { ok: false, retryAfterSec: Math.ceil((cooldownMs - elapsed) / 1000) };
      }
    }
    await env.DB.prepare(`INSERT OR REPLACE INTO ai_probe (id, at) VALUES ('last', ?)`)
      .bind(new Date().toISOString())
      .run();
    return { ok: true, retryAfterSec: 0 };
  } catch (_) {
    return { ok: true, retryAfterSec: 0 };
  }
}

// ─────────────────────────────────────────────────────────────
// 流式体检（/api/version?probe=1&stream=1）
//
// 它要回答一个**用猜的会出事**的问题：改了流式之后，单次请求到底还能撑多久？
//
//   已知（2026-10-09 实测）：普通一次性请求里，33.5 秒能正常返回，
//     40.5 秒被 Cloudflare 掐断、返回它自己的 502 HTML。
//   不确定：流式响应**全程一直在传字节**，那个上限还适不适用？
//     这决定了「作文升格」这种要吐 2500 字的接口能不能一次做完
//     （按 30～45 字/秒算需要 50 秒以上）。
//
// 所以这里故意**不设总预算**，让它跑到平台自己喊停 —— 我们要的就是那条线的位置。
// 失败时客户端拿到的会是平台自己的 HTML 而不是 JSON，这本身就是答案。
// ─────────────────────────────────────────────────────────────

export interface AiProbeStreamItem {
  model: string;
  status: string;
  /** 从发出请求到收到**第一个正文增量**的毫秒数 —— 也就是"老师多久能看到字" */
  firstMs?: number;
  ms: number;
  textChars?: number;
  finishReason?: string;
  note?: string;
}

export async function probeAiStream(
  env: any,
  kind: AiModelKind,
  opts: {
    perModelTimeoutMs?: number;
    maxTokens?: number;
    prompt?: string;
    models?: string[] | string;
  } = {}
): Promise<{ kind: string; streaming: true; perModelTimeoutMs: number; maxTokens: number; results: AiProbeStreamItem[] }> {
  const keys = modelscopeKeys(env);
  const named = typeof opts.models === "string"
    ? opts.models.split(",").map((s) => s.trim()).filter(Boolean)
    : Array.isArray(opts.models) ? opts.models.map((s) => String(s).trim()).filter(Boolean) : [];
  const chain = named.length ? [...new Set(named)].slice(0, 6) : modelscopeModelChain(env, kind).slice(0, 4);

  // 默认给 45 秒：足够跑出"平台到底在哪一秒掐断"这个结论
  const perModelTimeoutMs = Math.min(Math.max(opts.perModelTimeoutMs ?? 45000, 5000), 60000);
  const maxTokens = Math.min(Math.max(opts.maxTokens ?? 2500, 8), 4000);
  const askText = String(
    opts.prompt ||
      (kind === "vision" ? "这张图是什么颜色？只回答颜色名。" : "请只回复两个字：正常")
  ).slice(0, 500);

  // 视觉必须真的带图 —— 否则"视觉流式体检"只是在拿文本考一个视觉模型，
  // 测出来的时间跟「认作文照片」没有关系，等于白测。
  const messages =
    kind === "vision"
      ? [
          {
            role: "user",
            content: [
              { type: "text", text: askText },
              { type: "image_url", image_url: { url: PROBE_TINY_PNG } },
            ],
          },
        ]
      : [{ role: "user", content: askText }];

  const results: AiProbeStreamItem[] = [];

  for (const model of chain) {
    if (!keys.length) {
      results.push({ model, status: "未配置 KEY", ms: 0, note: "MODELSCOPE_API_KEY 为空" });
      break;
    }
    const key = keys[0];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perModelTimeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(aiEndpoint(env, kind), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        clearTimeout(timer);
        const note = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
        results.push({ model, status: `HTTP ${res.status}`, ms: Date.now() - t0, note });
        if (res.status === 401 || res.status === 403) break;
        continue;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let chars = 0;
      let firstMs: number | undefined;
      let finishReason = "";
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let obj: any = null;
          try { obj = JSON.parse(payload); } catch (_) { continue; }
          const choice = obj?.choices?.[0];
          if (choice?.finish_reason) finishReason = String(choice.finish_reason);
          const piece = String(choice?.delta?.content ?? "");
          if (piece) {
            if (firstMs === undefined) firstMs = Date.now() - t0;
            chars += piece.length;
          }
        }
      }
      clearTimeout(timer);
      results.push({
        model,
        status: chars ? "✅ 流式 200" : "⚠️ 流式 200 但正文为空",
        firstMs,
        ms: Date.now() - t0,
        textChars: chars,
        finishReason,
        note: firstMs !== undefined ? `首字 ${firstMs}ms，全程 ${Date.now() - t0}ms` : "",
      });
      if (chars) break; // 有一个能用的就够了
    } catch (e: any) {
      clearTimeout(timer);
      const aborted = e?.name === "AbortError";
      results.push({
        model,
        status: aborted ? `超时(${perModelTimeoutMs}ms)` : "请求异常",
        ms: Date.now() - t0,
        note: String(e?.message || e).slice(0, 200),
      });
    }
  }

  return { kind, streaming: true, perModelTimeoutMs, maxTokens, results };
}

// ─────────────────────────────────────────────────────────────
// 心跳探针（/api/version?probe=1&tick=1）
//
// 它是唯一能回答「流式响应到底能在平台上活多久」的东西，因为**别的探针都量不到**：
// probeAiChain / probeAiStream 都是「跑完再一次性返回 JSON」，那样的响应自己就受
// 同一个上限约束（实测普通请求 33.5s 可、40.5s 被 CF 掐断），量出来的只是"我们的
// 预算"，不是"平台的天花板"。
//
// 心跳只往一个 text/event-stream 里每秒写一行、什么都不算、也不调模型 ——
// 零额度消耗，可以放心跑到平台自己喊停，那条线在哪一秒就一目了然。
//
// 为什么要知道这条线：作文升格要吐 2500 字，按实测的 30～45 字/秒需要 50 秒以上。
//   线在 40 秒 ⇒ 一次做不完，得改成"分段续写"；
//   线在 90 秒 ⇒ 一次就能做完，现在的实现直接可用。
// ─────────────────────────────────────────────────────────────

export interface AiHeartbeatResult {
  seconds: number;
  intervalMs: number;
  ticks: number;
  /** 最后一次真正到达客户端的时间（毫秒）—— 没收到 done 帧时就是它断掉的时刻 */
  elapsedMs: number;
  /** 是否收到了收尾帧。缺它 = 中途被平台掐断 */
  closed: boolean;
  frames: any[];
}

/**
 * 造一个心跳流响应。**不调模型、不花额度**，纯粹用来量平台对流式响应的时限。
 * 同时导出成可离线验证的形式：测试里直接读这个 Response 的 body 就能断言。
 */
export function probeHeartbeat(opts: { seconds?: number; intervalMs?: number; buffered?: boolean } = {}): Response {
  const seconds = Math.min(Math.max(Math.round(opts.seconds ?? 60), 5), 120);
  const intervalMs = Math.min(Math.max(Math.round(opts.intervalMs ?? 1000), 200), 5000);
  const buffered = !!opts.buffered;
  const t0 = Date.now();
  let timer: any = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const queue: Uint8Array[] = [];
      const send = (obj: Record<string, any>) => {
        if (closed) return;
        // buffered 模式：先不发，攒到最后一次性吐出去。
        // 它不是"另一种心跳"，而是**对照组** —— 同一条代码路径、同样的时长，
        // 唯一差别就是"边跑边发"还是"跑完一次性发"。
        // 这样量出来的差异只可能来自"有没有在传字节"这一个变量，
        // 而不是拿昨天测的旧数字跟今天比（平台中途改了规矩就没人知道了）。
        if (buffered) {
          queue.push(sseFrame(obj));
          return;
        }
        try {
          controller.enqueue(sseFrame(obj));
        } catch (_) {
          closed = true;
        }
      };
      const finish = (obj: Record<string, any>) => {
        if (closed) return;
        send(obj);
        closed = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (buffered) {
          for (const c of queue) {
            try {
              controller.enqueue(c);
            } catch (_) {
              break;
            }
          }
        }
        try {
          controller.close();
        } catch (_) {}
      };

      send({
        type: "meta",
        seconds,
        intervalMs,
        buffered,
        startedAt: new Date(t0).toISOString(),
        note: buffered
          ? "心跳探针（缓冲对照组）：过程不发，跑完一次性吐出去"
          : "心跳探针：只发字节，不调模型，不花额度",
      });

      let n = 0;
      timer = setInterval(() => {
        n++;
        const elapsedMs = Date.now() - t0;
        if (n * intervalMs >= seconds * 1000) {
          finish({
            type: "done",
            ticks: n,
            elapsedMs,
            survivedSec: Math.round(elapsedMs / 100) / 10,
          });
          return;
        }
        send({ type: "tick", n, elapsedMs });
      }, intervalMs);
    },
    cancel() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  });

  return new Response(body, { status: 200, headers: sseHeaders() });
}

/**
 * 读一段 SSE 响应，把帧收成数组 —— 心跳探针的客户端侧。
 * 判据很关键：**有没有收到 `type:"done"` 的收尾帧**。
 * 缺它 = 平台在到达 seconds 之前就把连接掐了，elapsedMs 就是断点位置。
 */
export async function readHeartbeat(res: Response, onFrame?: (f: any) => void): Promise<AiHeartbeatResult> {
  const t0 = Date.now();
  const out: AiHeartbeatResult = { seconds: 0, intervalMs: 0, ticks: 0, elapsedMs: 0, closed: false, frames: [] };
  const reader = res.body?.getReader();
  if (!reader) return out;
  const decoder = new TextDecoder();
  let buf = "";
  let lastAt = t0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lastAt = Date.now();
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let obj: any = null;
      try {
        obj = JSON.parse(payload);
      } catch (_) {
        continue;
      }
      out.frames.push(obj);
      if (typeof onFrame === "function") {
        try {
          onFrame(obj);
        } catch (_) {}
      }
      if (obj.type === "meta") {
        out.seconds = Number(obj.seconds) || 0;
        out.intervalMs = Number(obj.intervalMs) || 0;
      }
      if (obj.type === "tick") out.ticks = Number(obj.n) || out.ticks;
      if (obj.type === "done") {
        out.closed = true;
        out.elapsedMs = Number(obj.elapsedMs) || lastAt - t0;
        out.ticks = Number(obj.ticks) || out.ticks;
      }
    }
  }
  if (!out.closed) out.elapsedMs = lastAt - t0;
  return out;
}
