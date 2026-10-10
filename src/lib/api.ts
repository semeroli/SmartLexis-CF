// ─────────────────────────────────────────────────────────────
// 前端统一请求出口
//
// 以前每个组件各自 fetch，把 teacher_id / is_admin 之类的"身份"塞在 URL 里——
// 那些参数客户端可以随便改，等于没有鉴权。现在：
//   · 登录后把服务端签发的令牌存在本地，所有请求自动带上 Authorization 头；
//   · 令牌失效（401）时统一清掉本地登录态并回调，界面自动回到登录页；
//   · 身份只认服务端返回的 /api/auth/me，不信 localStorage 里的副本。
// ─────────────────────────────────────────────────────────────

import { createSseDecoder, type SseEvent } from "./sse";

const TOKEN_KEY = "lexis_token";
const USER_KEY = "lexis_user";

export interface SessionUser {
  uid: string;
  email: string;
  name: string;
  role: string;
  studentId?: string | null;
}

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; }
}

export function getStoredUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export function saveSession(token: string, user: SessionUser) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch (_) {}
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch (_) {}
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | null = null;
/** 注册"登录已失效"时的回调（由 App 挂上：清空 user，回到登录页） */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

/**
 * 带令牌的 fetch。
 * 用法与原生 fetch 一致；FormData 不要自己设 Content-Type（浏览器会自动加 boundary）。
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers });

  if (res.status === 401) {
    clearSession();
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(401, "登录已过期，请重新登录");
  }
  return res;
}

/** 取 JSON 的便捷封装：非 2xx 抛 ApiError（带服务端返回的 error 文案） */
export async function apiJson<T = any>(input: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(input, init);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }

  if (!res.ok) {
    throw new ApiError(res.status, (body && body.error) || `请求失败 (${res.status})`);
  }
  return body as T;
}

/** 从响应里提取错误文案（兼容非 JSON 响应） */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || fallback;
  } catch (_) {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────
// 流式请求（「边生成边显示」）
//
// 服务端把 AI 的增量包成 `data: {"type":...}` 一帧帧发过来，这里负责读、解、回调。
// 约定四种帧：meta（模型名）/ delta（增量正文）/ done（收尾载荷）/ error（一句人话）。
//
// ⚠️ 两个必须处理的现实情况：
//   ① **错误可能出现在"开流之后"**（模型说到一半断了）。这时 HTTP 状态码已经是 200、
//      响应头也已经发出去了，改不了 —— 只能靠 error 帧告诉我们。所以不能只看 res.ok。
//   ② **中间层可能把流换掉**。遇到平台自己吐的错误页时，Content-Type 不是
//      text/event-stream，这时要明确报错，而不是当成"流里没内容"静默结束。
// ─────────────────────────────────────────────────────────────

export interface AiStreamHandlers {
  /** 已连上模型，附模型名（老师能知道这次是谁在写） */
  onStart?: (model: string) => void;
  /** 每次拿到增量就回调，参数是**累计至今**的完整正文 */
  onDelta?: (fullText: string) => void;
  /** 正常结束。payload 是 done 帧的全部字段（含 text / result 等） */
  onDone?: (payload: any) => void;
  /**
   * 「还在思考」的进度：模型已经在吐内容了，但吐的是思考过程、还没轮到正文。
   *
   * 为什么需要它：实测推理型模型会先思考十几秒到几十秒才写第一个正文字，
   * 那段时间如果界面上什么都不动，老师会以为卡死了。
   * ⚠️ 这里**只有字数**，没有思考原文 —— 思考内容不该给老师看，也不该进记录。
   */
  onThinking?: (reasoningChars: number) => void;
}

export async function apiStream(
  input: string,
  init: RequestInit,
  handlers: AiStreamHandlers = {}
): Promise<void> {
  const res = await apiFetch(input, init); // 401 会在这里直接抛

  if (!res.ok) {
    // 走到这里说明失败发生在"还没有开始输出"之前（配额、参数、模型全挂），
    // 此时服务端返回的是普通 JSON，能拿到准确文案。
    throw new ApiError(res.status, await errorMessage(res, `请求失败 (${res.status})`));
  }

  const contentType = res.headers.get("Content-Type") || "";
  if (!contentType.includes("text/event-stream")) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      res.status,
      text.trim().startsWith("<")
        ? `请求被服务器中途中断（HTTP ${res.status}）—— 请稍等一会儿重试一次`
        : "服务器没有返回流式内容，请稍后重试"
    );
  }

  const reader = res.body?.getReader();
  if (!reader) throw new ApiError(500, "当前浏览器不支持流式读取");

  const sse = createSseDecoder();
  let full = "";
  let finished = false;
  let streamError: string | null = null;
  let lastDone: any = null;

  const handle = (events: SseEvent[]) => {
    for (const ev of events) {
      if (ev.type === "meta") {
        handlers.onStart?.(String(ev.model || ""));
      } else if (ev.type === "delta") {
        full += String(ev.text || "");
        handlers.onDelta?.(full);
      } else if (ev.type === "progress") {
        handlers.onThinking?.(Number(ev.reasoningChars) || 0);
      } else if (ev.type === "done") {
        finished = true;
        lastDone = ev;
      } else if (ev.type === "error") {
        streamError = String(ev.message || "生成失败，请重试一次");
      }
    }
  };

  const bailIfError = () => {
    if (streamError) {
      // 停止继续读 —— 后面的内容已经没有意义了
      try { reader.cancel(); } catch (_) {}
      throw new ApiError(502, streamError);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      handle(sse.push(value));
      bailIfError();
    }
    handle(sse.end());
    bailIfError();
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    // 读流本身出错（断网、连接被掐断）
    throw new ApiError(502, "连接中断，生成未完成，请重试一次");
  }

  if (!finished) {
    // 流结束了但没有 done 帧：服务端在收尾前挂掉了
    throw new ApiError(502, "生成被中断，结果可能不完整，请重试一次");
  }

  handlers.onDone?.(lastDone);
}

