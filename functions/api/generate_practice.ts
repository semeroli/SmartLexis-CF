export const onRequestPost: PagesFunction<{ MODELSCOPE_API_KEY: string }> = async (context) => {
  const { request, env } = context;

  try {
    const { student } = await request.json<any>();
    const s = student || {};

    const weakPoints = [];
    if ((s.classicReading || 0) < 12) weakPoints.push("文言文阅读理解");
    if ((s.modernReading || 0) < 20) weakPoints.push("现代文深度鉴赏");
    if ((s.composition || 0) < 35) weakPoints.push("作文立意与素材运用");
    if ((s.dictation || 0) < 8) weakPoints.push("名句名篇默写");
    if ((s.nonLinear || 0) < 7) weakPoints.push("非连续性文本分析");

    const focusArea = weakPoints.length > 0 ? weakPoints.join("、") : "语文综合素养提升";

    const apiKey = env.MODELSCOPE_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "MODELSCOPE_API_KEY is missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const prompt = `你是一位资深的语文特级教师。根据该学生的考试表现（重点提升：${focusArea}），请生成一份“专项练习”试题集。
    
请严格按照以下 JSON 格式返回练习内容，不要包含任何其他文字：
{
  "title": "专项提分练习标题",
  "introduction": "练习说明和鼓励语",
  "reading_material": "阅读材料内容",
  "questions": [
    {
      "id": 1,
      "type": "choice",
      "content": "题目内容",
      "options": ["A. 选项1", "B. 选项2", "C. 选项3", "D. 选项4"],
      "answer": "A",
      "analysis": "题目解析"
    }
  ],
  "writing_task": {
    "title": "写作练习题目",
    "requirement": "写作要求",
    "guidance": "写作指导"
  }
}

要求：
1. 题目要具有针对性，紧扣薄弱环节。
2. 难度适中，符合高考/中考水平。
3. 必须返回合法的 JSON 格式。`;

    const res = await fetch("https://api-inference.modelscope.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "ZhipuAI/GLM-5.1", // ✅ 更换为魔塔 GLM-5.1
        messages: [
          { role: "system", content: "你是语文出题专家。" },
          { role: "user", content: prompt },
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

    const practice =
      data?.choices?.[0]?.message?.content ?? "{}";

    // 直接返回 AI 生成的 JSON 字符串
    return new Response(practice, {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
