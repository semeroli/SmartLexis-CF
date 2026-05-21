export const onRequestPost: PagesFunction<{ MODELSCOPE_API_KEY: string }> = async (context) => {
  const { request, env } = context;

  try {
    const { student } = await request.json<any>();

    const apiKey = env.MODELSCOPE_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "MODELSCOPE_API_KEY is missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const prompt = `你是一位资深的语文教育专家。请根据以下学生的考试数据进行深度学情分析，并给出具体的提升建议。
学生姓名：${student.name}
各项得分：
- 选择题：${student.choice}/30
- 现代文阅读：${student.modernReading}/30
- 文言文阅读：${student.classicReading}/20
- 非连续性文本：${student.nonLinear}/10
- 默写填空：${student.dictation}/10
- 作文：${student.composition}/50
总分：${student.total}/150

请以 Markdown 格式输出，包含：
1. 总体评价
2. 优势分析
3. 薄弱环节
4. 针对性提升方案（分阶段、可操作）`;

    const res = await fetch("https://api-inference.modelscope.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "ZhipuAI/GLM-5.1", // ✅ 更换为魔塔 GLM-5.1
        messages: [
          { role: "system", content: "你是资深语文教育专家。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 2500,
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
      data?.choices?.[0]?.message?.content ?? "分析失败";

    return new Response(
      JSON.stringify({ status: "ok", analysis }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
