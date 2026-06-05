const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

export async function onRequestPost(context: any) {
  const { request, env } = context;

  try {
    // 检查环境变量
    if (!env.AGNES_API_KEY) {
      console.error("AGNES_API_KEY not configured");
      return new Response(JSON.stringify({ 
        error: "AGNES_API_KEY 未配置，请在 Cloudflare Pages 环境变量中设置" 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ✅ 确保 D1 表存在且结构正确
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS writing_records (
        id TEXT PRIMARY KEY,
        studentId TEXT,
        teacherId TEXT,
        title TEXT,
        essay_text TEXT,
        analysis TEXT,
        analysis_json TEXT,
        date TEXT
      )`
    ).run();

    // 补加可能缺失的列（D1 不支持 IF NOT EXISTS，用 try-catch）
    const alterStatements = [
      "ALTER TABLE writing_records ADD COLUMN studentId TEXT",
      "ALTER TABLE writing_records ADD COLUMN teacherId TEXT", 
      "ALTER TABLE writing_records ADD COLUMN essay_text TEXT",
      "ALTER TABLE writing_records ADD COLUMN analysis_json TEXT",
    ];
    for (const sql of alterStatements) {
      try { await env.DB.prepare(sql).run(); } catch (_) {}
    }

    const formData = await request.formData();
    const title = formData.get("title") || "未命名作文";
    const studentId = formData.get("studentId") || "unknown";
    const teacherId = formData.get("teacherId") || "system";
    const imagesJson = formData.get("images");

    if (!imagesJson) {
      return new Response(JSON.stringify({ error: "缺少作文图片" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    let essayImages: string[];
    try {
      essayImages = JSON.parse(imagesJson as string);
    } catch (e) {
      return new Response(JSON.stringify({ error: "图片数据格式错误" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 限制最多 2 张图
    const safeImages = essayImages.slice(0, 2);
    
    if (safeImages.length === 0) {
      return new Response(JSON.stringify({ error: "未提供有效图片" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 构造 OpenAI 格式的消息内容
    const contentParts: any[] = [
      {
        type: "text",
        text: `请对这篇题目为《${title}》的学生手写作文进行深度诊断。
要求：
1. 先完整识别图片中的作文文字内容。
2. 从"立意深度、结构安排、语言表达、卷面书写"四个维度评分（满分60）。
3. 给出优缺点与升格建议。
4. 严格按照系统提示的 JSON 格式输出。`,
      },
    ];

    // 添加图片（OpenAI 多模态格式）
    for (let img of safeImages) {
      // 确保 base64 格式正确
      if (!img.startsWith("data:image/")) {
        img = `data:image/jpeg;base64,${img}`;
      }
      contentParts.push({
        type: "image_url",
        image_url: { url: img },
      });
    }

    console.log(`Calling agnes-ai with ${safeImages.length} images, title: ${title}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    // 调用 agnes-ai API（OpenAI 兼容格式）
    const res = await fetch("https://apihub.agnes-ai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AGNES_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "agnes-2.0-flash",
        messages: [
          {
            role: "system",
            content: `你是资深语文阅卷组组长。
请严格按照以下 JSON 格式输出，不要输出其他文字：

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
}`,
          },
          {
            role: "user",
            content: contentParts,
          },
        ],
        temperature: 0.2,
        max_tokens: 3500,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`agnes-ai API error: ${res.status} ${errText}`);
      return new Response(
        JSON.stringify({ 
          error: `agnes-ai API 错误 (${res.status})`, 
          detail: errText 
        }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const data = await res.json();
    console.log("agnes-ai response received");

    let raw = data.choices?.[0]?.message?.content || "";
    
    if (!raw) {
      console.error("agnes-ai returned empty content:", JSON.stringify(data));
      return new Response(
        JSON.stringify({ error: "agnes-ai 返回空内容", detail: data }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    raw = raw.replace(/^```json\s*/i, "").replace(/```$/, "").trim();

    let result: any;
    try {
      result = JSON.parse(raw);
    } catch (e) {
      console.error("JSON parse error:", raw.substring(0, 200));
      result = {
        essay_text: "",
        score: null,
        dimensions: {},
        strengths: [],
        weaknesses: [],
        suggestions: [],
        summary: "AI 返回格式异常",
        raw,
      };
    }

    // 写入 D1
    const id = crypto.randomUUID();
    const date = new Date().toISOString();
    const analysisText = result.summary || "";

    try {
      await env.DB.prepare(
        `INSERT INTO writing_records
         (id, studentId, teacherId, title, essay_text, analysis, analysis_json, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id, 
          studentId, 
          teacherId, 
          title, 
          result.essay_text || "", 
          analysisText,
          JSON.stringify(result), 
          date
        )
        .run();
      console.log("D1 insert success");
    } catch (dbErr: any) {
      console.error("D1 insert error:", dbErr.message);
      // 即使数据库写入失败，也返回分析结果
    }

    return new Response(
      JSON.stringify({ success: true, id, title, result, date }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } }
    );

  } catch (err: any) {
    console.error("analyze_essay error:", err);
    
    if (err.name === "AbortError") {
      return new Response(JSON.stringify({ error: "阅卷超时（60秒），请稍后重试" }), {
        status: 504,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    
    return new Response(JSON.stringify({ 
      error: err.message || "服务器内部错误",
      stack: err.stack 
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}
