import { corsHeadersFor, errorResponse, jsonResponse, requireUser } from "../../shared/api";

// 作文升格。会消耗 AI 额度，必须登录。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "POST, OPTIONS") });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "POST, OPTIONS");

  try {
    await requireUser(env, request);

    const { title, content } = await request.json();

    const keys = (env.MODELSCOPE_API_KEY || "").split(",").map((k: string) => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      return jsonResponse({ error: "MODELSCOPE_API_KEY 未配置" }, 500, cors);
    }
    const apiKey = keys[Math.floor(Math.random() * keys.length)];

    const prompt = `
你是一位资深的语文特级教师。请对以下作文进行"升格"处理。

题目：《${title}》
原文内容：
${content}

任务要求：
1. 创作一篇 800 字左右的"升格版"范文，要求立意深远、文采斐然、结构严谨。
2. 挑选 3–5 句"金句"（好词好句），并为每一句标注一个主题标签（如：青春、奋斗、自然、哲思等）。
3. 详细列出"亮点解析"，说明修改了哪些地方，提升了什么境界。

输出格式（请严格遵守）：
【升格范文】
（此处为范文内容）

【金句推荐】
- 句子1 | 主题1
- 句子2 | 主题2

【亮点解析】
（此处为解析内容）
`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const res = await fetch("https://api-inference.modelscope.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-8B-Instruct",
        messages: [
          {
            role: "system",
            content: "你是资深语文特级教师，擅长作文升格与教学点评。",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: 3500,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const data = await res.json();

    if (!res.ok) {
      return jsonResponse({ error: "ModelScope API error", detail: data }, 500, cors);
    }

    const text = data?.choices?.[0]?.message?.content ?? "升格失败，请稍后重试";

    return jsonResponse({ text }, 200, cors);
  } catch (err: any) {
    if (err.name === "AbortError") {
      return jsonResponse({ error: "升格超时，请稍后重试" }, 504, cors);
    }
    return errorResponse(err, request);
  }
}
