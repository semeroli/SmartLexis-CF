export const onRequestPost: PagesFunction<{ MODELSCOPE_API_KEY: string; DB: D1Database }> = async (context) => {
  const { request, env } = context;

  try {
    const formData = await request.formData();
    const title = formData.get("title") || "未命名作文";
    const studentId = formData.get("studentId") || "N/A";
    const teacherId = formData.get("teacherId") || "system";
    const imagesJson = formData.get("images");

    if (!imagesJson) {
      return new Response(
        JSON.stringify({ error: "Missing images" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const essayImages = JSON.parse(imagesJson as string);
    const apiKey = env.MODELSCOPE_API_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "MODELSCOPE_API_KEY is missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const parts: any[] = [
      {
        text: `你是一位资深的语文阅卷组组长。请对这篇题目为《${title}》的学生手写作文进行深度诊断。
要求：
1. 识别图片中的文字内容（如果清晰）。
2. 从“立意深度”、“结构安排”、“语言表达”、“卷面书写”四个维度进行评分（满分50）。
3. 给出具体的“升格建议”（即如何修改能拿到更高分）。
请使用 Markdown 格式输出。`,
      },
    ];

    for (const imgBase64 of essayImages) {
      const base64Data = imgBase64.split(",")[1];
      const mimeType = imgBase64.split(",")[0].split(":")[1].split(";")[0];
      parts.push({
        inlineData: {
          data: base64Data,
          mimeType: mimeType,
        },
      });
    }

    const res = await fetch("https://api-inference.modelscope.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "ZhipuAI/GLM-5.1", // ✅ 更换为魔塔 GLM-5.1
        messages: [
          { role: "system", content: "你是资深语文阅卷老师。" },
          { role: "user", content: parts.map(p => p.text || "[图片]").join("\n") },
        ],
        temperature: 0.7,
        max_tokens: 3000,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("ModelScope error:", data);
      return new Response(
        JSON.stringify({ error: "ModelScope API error", detail: data }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const analysis =
      data?.choices?.[0]?.message?.content ?? "阅卷失败";

    // 确保表存在
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS writing_records (
        id TEXT PRIMARY KEY,
        studentId TEXT,
        teacherId TEXT,
        title TEXT,
        analysis TEXT,
        date DATETIME
      )`
    ).run();

    // 检查并修复表结构
    const tableInfo = await env.DB.prepare("PRAGMA table_info(writing_records)").all();
    const columns = tableInfo.results.map((column: any) => column.name);

    if (!columns.includes("teacherId")) {
      try {
        await env.DB.prepare("ALTER TABLE writing_records ADD COLUMN teacherId TEXT").run();
      } catch (e) {
        console.error("Error adding teacherId column:", e);
      }
    }

    if (!columns.includes("studentId")) {
      try {
        await env.DB.prepare("ALTER TABLE writing_records ADD COLUMN studentId TEXT").run();
      } catch (e) {
        console.error("Error adding studentId column:", e);
      }
    }

    const id = crypto.randomUUID();
    const date = new Date().toISOString();

    // 保存到 D1
    await env.DB.prepare(
      "INSERT INTO writing_records (id, studentId, teacherId, title, analysis, date) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(id, studentId, teacherId, title, analysis, date)
      .run();

    return new Response(
      JSON.stringify({ id, title, analysis, date }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
