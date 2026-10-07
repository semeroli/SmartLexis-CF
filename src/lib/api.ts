// ─────────────────────────────────────────────────────────────
// 前端统一请求出口
//
// 以前每个组件各自 fetch，把 teacher_id / is_admin 之类的"身份"塞在 URL 里——
// 那些参数客户端可以随便改，等于没有鉴权。现在：
//   · 登录后把服务端签发的令牌存在本地，所有请求自动带上 Authorization 头；
//   · 令牌失效（401）时统一清掉本地登录态并回调，界面自动回到登录页；
//   · 身份只认服务端返回的 /api/auth/me，不信 localStorage 里的副本。
// ─────────────────────────────────────────────────────────────

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
