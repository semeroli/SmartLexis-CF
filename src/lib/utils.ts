import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 Tailwind 类名的工具函数
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 解析后端返回的时间。
 *
 * 数据库里的时间由 SQLite 的 `datetime('now','localtime')` 写出，形如
 * `"2026-07-03 08:30:56"`（在 Cloudflare 上 "localtime" 其实就是 UTC）。
 * 这种「空格分隔、无时区」的格式，**Safari 直接 new Date() 会得到 Invalid Date**，
 * 表现是成长曲线横轴出现 "Invalid Date"；Chrome 能容错，所以本机很难测出来。
 *
 * 这里统一处理：空格换 T；缺时区的按 UTC 解析（服务器写的就是 UTC）。
 * 拿不到合法时间时返回 null，由调用方决定兜底文案。
 */
export function parseDbDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  let s = String(value).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    s += 'Z';
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 日期显示：拿不到合法时间就显示 "—"，绝不显示 "Invalid Date" */
export function formatDay(value: unknown, opts?: Intl.DateTimeFormatOptions): string {
  const d = parseDbDate(value);
  if (!d) return '—';
  try {
    return d.toLocaleDateString('zh-CN', opts);
  } catch (_) {
    return '—';
  }
}
