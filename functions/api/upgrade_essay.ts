export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { title, content } = await request.json();

    // ✅ 支持多个 API Key 轮询（与你原逻辑一致）
    const keys = env.MODELSCOPE_API_KEY.split(',').map(k => k.trim());
    const apiKey = keys[Math.floor(Math.random() * keys.length)];

    // ✅ 构造升格 Prompt（完全保留你原来的教学语义）
    const prompt = `
你是一位资深的语文特级教师。请对以下作文进行“升格”处理。

题目：《${title}》
原文内容：
${content}

任务要求：
1. 创作一篇 800 字左右的“升格版”范文，要求立意深远、文采斐然、结构严谨。
2. 挑选 3–5 句“金句”（好词好句），并为每一句标注一个主题标签（如：青春、奋斗、自然、哲思等）。
3. 详细列出“亮点解析”，说明修改了哪些地方，提升了什么境界。

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
    const timeout = setTimeout(() => controller.abort(), 60000); // 60 秒超时

    const res = await fetch("https://api-inference.modelscope.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-VL-8B-Instruct", // ✅ 替换为你当前可用的模型
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
      return new Response(
        JSON.stringify({ error: "ModelScope API error", detail: data }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const text =
      data?.choices?.[0]?.message?.content ?? "升格失败，请稍后重试";

    return new Response(JSON.stringify({ text }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    if (err.name === "AbortError") {
      return new Response(
        JSON.stringify({ error: "升格超时，请稍后重试" }),
        { status: 504, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
