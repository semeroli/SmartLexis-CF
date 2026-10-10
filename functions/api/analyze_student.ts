import {
  callModelscope,
  checkAiQuota,
  corsHeadersFor,
  errorResponse,
  jsonResponse,
  recordAiUsage,
  requireUser,
} from "../../shared/api";

interface StudentInput {
  name: string;
  choice: number;
  modernReading: number;
  classicReading: number;
  nonLinear: number;
  dictation: number;
  composition: number;
  total: number;
}

// 智能学情分析。这个接口会消耗 AI 额度，必须登录后才能调用——
// 否则任何人都能拿它当免费的 AI 代理刷额度。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "POST, OPTIONS") });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "POST, OPTIONS");

  try {
    const user = await requireUser(env, request);
    // 先过每日配额闸门，再花钱调 AI
    await checkAiQuota(env, user, "analyze");

    const body: any = await request.json().catch(() => ({}));
    const student: StudentInput = body.student;
    if (!student) return jsonResponse({ error: "缺少学生数据" }, 400, cors);

    // 满分口径与前端 src/lib/score.ts 保持一致：
    // 选择25 + 现代文35 + 文言20 + 默写10 + 作文60 = 150。
    // 注意「非连续性文本」不是独立板块，它的分数并入现代文阅读（Excel 里仍是独立一列）。
    const modernTotal = (Number(student.modernReading) || 0) + (Number(student.nonLinear) || 0);
    const prompt = `你是一位资深的语文教育专家。请根据以下学生的考试数据进行深度学情分析，并给出具体的提升建议。
学生姓名：${student.name}
各项得分（括号内为该项满分）：
- 选择题：${student.choice}/25
- 现代文阅读：${modernTotal}/35（含非连续性文本）
- 文言文阅读：${student.classicReading}/20
- 默写填空：${student.dictation}/10
- 作文：${student.composition}/60
总分：${student.total}/150

请以 Markdown 格式输出，包含：
1. 总体评价
2. 优势分析
3. 薄弱环节
4. 针对性提升方案（分阶段、可操作）`;

    // 模型名不再写死：交给 shared/api 的「模型降级链」——
    // 平台下架 / 改名模型时自动换到下一个可用的，不用改代码。
    const { content: analysis, model } = await callModelscope(
      env,
      "text",
      [
        { role: "system", content: "你是资深语文教育专家。" },
        { role: "user", content: prompt },
      ],
      // 单个模型最多 15 秒、总预算 30 秒 —— 保证排在后面的模型也有公平机会
      // （详细缘由见 analyze_essay.ts 的同一处注释）
      { temperature: 0.7, maxTokens: 2500, timeoutMs: 20000, totalBudgetMs: 30000 }
    );
    console.log(`学情分析使用模型: ${model}`);

    // 只有真的拿到内容才记一次用量
    await recordAiUsage(env, user, "analyze");

    return jsonResponse({ status: "ok", analysis }, 200, cors);
  } catch (err: any) {
    return errorResponse(err, request);
  }
}
