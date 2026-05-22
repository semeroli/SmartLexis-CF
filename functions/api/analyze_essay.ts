export const onRequestPost: PagesFunction<{ MODELSCOPE_API_KEY: string; DB: D1Database }> = async (context) => {
  const { request, env } = context;

  try {
    const formData = await request.formData();
    const title = formData.get("title") || "未命名作文";
    const studentId = formData.get("studentId") || "N/A";
    const teacherId = formData.get("teacherId") || "system";
    const imagesJson = formData.get("images");

    if (!imagesJson) {
      return new Response(JSON.stringify({ error: "缺少作文图片" }), { status: 400 });
    }

    const essayImages: string[] = JSON.parse(imagesJson as string);
    const apiKey = env.MODELSCOPE_API_KEY;
    if (!apiKey) throw new Error("未配置 MODELSCOPE_API_KEY");

    const contentParts: any[] = [
      {
        type: "text",
        text: `请对这篇题目为《${title}》的学生手写作文进行分析。
要求：
1. 先完整识别图片中的作文文字（尽量还原原文）。
2. 从“立意深度、结构安排、语言表达、卷面书写”四个维度评分（满分60）。
3. 给出优缺点与升格建议。
4. 严格按照系统提示中的 JSON 格式输出。`,
      },
    ];

    for (const imgBase64 of essayImages) {
      contentParts.push({
        type: "image_url",
        image_url: { url: imgBase64 },
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

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
            content: `
你是一位资深语文阅卷组组长。
请先识别作文原文，再进行评分。

评分规则：
- 总分：60 分
- 四个维度：立意深度、结构安排、语言表达、卷面书写

输出格式（JSON，不要输出其他文字）：
{
  "essay_text": "作文原文内容",
  "score": 52,
  "dimensions": {
    "立意深度": 14,
    "结构安排": 13,
    "语言表达": 14,
    "卷面书写": 11
  },
  "strengths": ["优点1", "优点2"],
  "weaknesses": ["不足1", "不足2"],
  "suggestions": ["建议1", "建议2"],
  "summary": "总体评价（100字以内）"
}
`.trim(),
          },
          { role: "user", content: contentParts },
        ],
        temperature: 0.3,
        max_tokens: 4000,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    let raw = data?.choices?.[0]?.message?.content ?? "";
    raw = raw.replace(/^```json/, "").replace(/```$/, "").trim();

    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      result = {
        essay_text: "",
        score: null,
        dimensions: {},
        strengths: [],
        weaknesses: [],
        suggestions: [],
        summary: "解析失败",
        raw,
      };
    }

    // ✅ D1
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS writing_records (
        id TEXT PRIMARY KEY,
        studentId TEXT,
        teacherId TEXT,
        title TEXT,
        essay_text TEXT,
        analysis_json TEXT,
        date DATETIME
      )`
    ).run();

    const id = crypto.randomUUID();
    const date = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO writing_records
       (id, studentId, teacherId, title, essay_text, analysis_json, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        studentId,
        teacherId,
        title,
        result.essay_text || "",
        JSON.stringify(result),
        date
      )
      .run();

    return new Response(
      JSON.stringify({ success: true, id, title, result, date }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    if (err.name === "AbortError") {
      return new Response(JSON.stringify({ error: "阅卷超时，请稍后重试" }), { status: 504 });
    }
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
