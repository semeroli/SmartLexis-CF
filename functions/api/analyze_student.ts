import {
  callModelscope,
  callModelscopeStream,
  checkAiQuota,
  corsHeadersFor,
  errorResponse,
  jsonResponse,
  pipeAiStream,
  recordAiUsage,
  requireUser,
  stripThinkingNoise,
  wantsStream,
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
    const messages = [
      { role: "system", content: "你是资深语文教育专家。" },
      { role: "user", content: prompt },
    ];
    // 握手 20 秒（开不起流就换下一个模型）、总预算 60 秒。
    // ⚠️ timeoutMs 只管**握手**，不再限制正文能写多久 —— 那归 safetyMs / stallMs。
    //    实测同一个模型两次差 7 倍，拿总时长判生死会误杀"慢但正常"的生成。
    // 总预算放宽到 60 秒：2026-10-11 线上实测握手偶尔要 32 秒（限流时排队），
    //    30 秒会一次全链失败，60 秒够后面的候选模型也有机会被握上。
    const AI_OPTS = { temperature: 0.7, maxTokens: 2500, timeoutMs: 20000, totalBudgetMs: 60000 };
    // 这份报告约 1000～2500 字。实测出字速度约 90～110 字/秒，加上开头思考几秒，
    // 满打满算 30 秒上下；70 秒的安全上限留足余量（平台实测能撑 120 秒以上）。
    const STREAM_OPTS = { safetyMs: 70000, progressFrames: true };

    // ── 流式：老师要边生成边看 ──────────────────────────────
    // 学情分析是一份 1000 字上下的长报告，等它一次性吐完要 20～30 秒。
    // 改成流式之后，字一个一个出来，等待感基本没了，也不再贴着平台单请求上限。
    if (wantsStream(request)) {
      const hs = await callModelscopeStream(env, "text", messages, AI_OPTS);
      console.log(`学情分析（流式）使用模型: ${hs.model}`);
      return pipeAiStream(hs.response, hs.model, {
        // 兜一层"思考过程"污染的网：流里没法提前判断，收尾时统一剥。
        transformFinal: stripThinkingNoise,
        onComplete: async () => {
          await recordAiUsage(env, user, "analyze");
          return { status: "ok" };
        },
        ...STREAM_OPTS,
      });
    }

    const { content: analysis, model } = await callModelscope(env, "text", messages, AI_OPTS);
    console.log(`学情分析使用模型: ${model}`);

    // 只有真的拿到内容才记一次用量
    await recordAiUsage(env, user, "analyze");

    return jsonResponse({ status: "ok", analysis }, 200, cors);
  } catch (err: any) {
    return errorResponse(err, request);
  }
}
