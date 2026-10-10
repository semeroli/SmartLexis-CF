// ─────────────────────────────────────────────────────────────
// SSE（Server-Sent Events）增量解析
//
// 为什么单独抽一个文件、而且刻意写成"不依赖浏览器"的纯函数：
//   流式最大的坑不在功能，而在**分块边界**。网络上到达的字节和服务器发出的帧
//   完全不对齐，会出现三种情况：
//     ① 一帧被切成两段（`data: {"type":"del` + `ta","text":"你好"}`）
//     ② 一个 chunk 里塞了好几帧
//     ③ 一个**汉字**的 UTF-8 字节被切开（3 字节只到 1～2 个）
//   这几种都不是"偶发"，而是必然发生。所以必须能离线、可重复地测 ——
//   扔给浏览器手工点几下是测不出来的。
// ─────────────────────────────────────────────────────────────

export interface SseEvent {
  type: string;
  [key: string]: any;
}

/**
 * 按行消费 SSE 文本。
 * 只认 `data:` 开头的行；`:` 开头的心跳注释、别的字段一律忽略。
 *
 * ⚠️ 关键点：**行不完整就留在缓冲区**。如果收到半行就 JSON.parse，
 *    丢掉的正是正文，而且表现为"偶尔少几个字"，最难查。
 */
export function createSseParser() {
  let buf = "";

  const drain = (allowTrailing: boolean): SseEvent[] => {
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      const ev = parseLine(line);
      if (ev) out.push(ev);
    }
    // 流结束了但最后一行没有换行符：也要认，否则会丢掉最后一帧
    if (allowTrailing && buf.trim()) {
      const ev = parseLine(buf.replace(/\r$/, ""));
      buf = "";
      if (ev) out.push(ev);
    }
    return out;
  };

  return {
    /** 喂一段文本，返回这一段里解析出的完整事件（可能 0 个、可能多个） */
    push(chunk: string): SseEvent[] {
      buf += chunk;
      return drain(false);
    },
    /** 流结束：把缓冲区里最后一个没有换行的帧也解出来 */
    end(): SseEvent[] {
      return drain(true);
    },
  };
}

function parseLine(line: string): SseEvent | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === "object" && typeof obj.type === "string") return obj as SseEvent;
  } catch (_) {
    // 走到这里说明服务器发了一帧我们解析不了的内容 —— 忽略它，
    // 但不要因此中断整个流（下一帧还是好的）。
  }
  return null;
}

/**
 * 字节流 → 事件流。把 UTF-8 解码和分行两步合在一起，
 * 是因为**汉字被切开**必须在解码层解决（`stream: true` 会让解码器
 * 把不完整的字节先留着），而分行是解析层的事。
 */
export function createSseDecoder() {
  const dec = new TextDecoder();
  const parser = createSseParser();
  return {
    push(bytes: Uint8Array): SseEvent[] {
      return parser.push(dec.decode(bytes, { stream: true }));
    },
    end(): SseEvent[] {
      // 先让解码器把残留字节吐出来，再收尾残余行
      return [...parser.push(dec.decode()), ...parser.end()];
    },
  };
}
