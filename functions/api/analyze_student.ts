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
  streamBudgetAfter,
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
    // ⚠️ 提示词里的「总字数 1500 字以内」是**必需的一条**，不是客套话，别删。
    //    2026-10-10 线上真机实测（管理员账号）：
    //      maxTokens 2500 → 正文写到 3853 字被截断（finish=length）
    //      maxTokens 4000 → 写到 6082 字**仍然**被截断
    //    也就是说：不约束字数的话，模型会一直写下去，老师拿到的报告是"半句话结尾"。
    //    光加"1500 字以内"效果一般，所以又给了**分段配额** —— 模型会照着配额分配篇幅，
    //    比只给一个总数管用得多。（改这条会改变老师看到的内容，是王老师拍板后的决定。）
    const prompt = `你是一位资深的语文教育专家。请根据以下学生的考试数据进行深度学情分析，并给出具体的提升建议。
学生姓名：${student.name}
各项得分（括号内为该项满分）：
- 选择题：${student.choice}/25
- 现代文阅读：${modernTotal}/35（含非连续性文本）
- 文言文阅读：${student.classicReading}/20
- 默写填空：${student.dictation}/10
- 作文：${student.composition}/60
总分：${student.total}/150

请以 Markdown 格式输出，**全文总字数必须控制在 1500 字以内**。请按下述配额写，写完即止，不要重复、不要凑字数：
1. 总体评价（约 200 字）：这个分数段整体处在什么水平，最突出的一个特点
2. 优势分析（约 250 字）：结合上面的得分指出真正的强项，不要泛泛而谈
3. 薄弱环节（约 300 字）：按失分多少排序，指出最该补的两三处
4. 针对性提升方案（约 750 字）：分阶段、可操作，每阶段给出具体做法`;

    // 模型名不再写死：交给 shared/api 的「模型降级链」——
    // 平台下架 / 改名模型时自动换到下一个可用的，不用改代码。
    const messages = [
      { role: "system", content: "你是资深语文教育专家。" },
      { role: "user", content: prompt },
    ];
    // ⚠️ timeoutMs 只管**握手**（多久之内必须把流开起来），不限制正文能写多久
    //    —— 那归 safetyMs / stallMs。实测同一个模型两次差 7 倍，拿总时长判生死
    //    只会误杀"慢但正常"的生成。
    // 2026-10-10 线上真机实测（管理员账号）：
    //    · 上游排队时，**光等响应头就要 34.9 秒**（正常时 3 秒）；
    //      原来给 20 秒 ⇒ 四个模型全部在原地被掐死，60 秒预算被吃光，老师拿到 502。
    //    · 这一份报告实测跑了 67.7 秒（其中前 35.7 秒在"构思"，思考了 2034 字）。
    // 所以握手放宽到 45 秒、总预算放宽到 90 秒（够两个模型各试一次）。
    const AI_OPTS = { temperature: 0.7, maxTokens: 4000, timeoutMs: 45000, totalBudgetMs: 90000 };
    // maxTokens 2500 → 4000：实测 2500 时正文写到 3853 字被截断（finish=length），
    // 报告是不完整的。放宽后能自然收尾。
    //
    // safetyMs 不再写死一个数，而是「整条响应总上限 - 握手已花掉的时间」
    //（见 shared/api.ts 的 STREAM_TOTAL_CAP_MS）—— 因为握手排队多久是不可控的，
    // 写死 70 秒时实测已经用到 67.7 秒，余量只剩 2.3 秒，再慢一点就被自己掐断。
    const STREAM_OPTS = { progressFrames: true, diag: { env, kind: "text" } };

    // ── 流式：老师要边生成边看 ──────────────────────────────
    // 学情分析是一份 1000 字上下的长报告，等它一次性吐完要 20～30 秒。
    // 改成流式之后，字一个一个出来，等待感基本没了，也不再贴着平台单请求上限。
    if (wantsStream(request)) {
      const t0 = Date.now();
      const hs = await callModelscopeStream(env, "text", messages, AI_OPTS);
      console.log(`学情分析（流式）使用模型: ${hs.model}（握手 ${Date.now() - t0}ms）`);
      return pipeAiStream(hs.response, hs.model, {
        // 兜一层"思考过程"污染的网：流里没法提前判断，收尾时统一剥。
        transformFinal: stripThinkingNoise,
        onComplete: async () => {
          await recordAiUsage(env, user, "analyze");
          return { status: "ok" };
        },
        safetyMs: streamBudgetAfter(Date.now() - t0),
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
