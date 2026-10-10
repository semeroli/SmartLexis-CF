import {
  callModelscope,
  callModelscopeStream,
  checkAiQuota,
  corsHeadersFor,
  errorResponse,
  HttpError,
  jsonResponse,
  pipeAiStream,
  recordAiUsage,
  requireUser,
  wantsStream,
} from "../../shared/api";

// 专项练习生成。会消耗 AI 额度，必须登录 + 过每日配额。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "POST, OPTIONS") });

/**
 * 把模型输出的"差不多是 JSON"变成真 JSON。
 * 模型经常把 JSON 包在 ```json 围栏里，或前后附一句"好的，以下是练习："——
 * 直接 JSON.parse 会失败，前端拿到的是"生成失败"这种没头没脑的提示。
 */
function parseLooseJson(raw: string): any | null {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const candidates = [unfenced];
  const a = unfenced.indexOf("{");
  const b = unfenced.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(unfenced.slice(a, b + 1));

  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === "object") return o;
    } catch (_) { /* 换下一个候选 */ }
  }
  return null;
}

const str = (v: any, fallback = ""): string => (typeof v === "string" ? v : fallback);

/**
 * 「模型输出的一坨文字」→「可用的练习数据」。
 *
 * 抽成函数是因为它现在有两条调用路径（普通 JSON 返回 / 流式收尾），
 * 两条路必须用完全一样的解析与校验 —— 否则流式和普通模式会出现
 * 「一个能过、一个报格式错」这种最难查的差异。
 *
 * 失败时抛 HttpError，文案是给老师看的。
 */
function buildPractice(raw: string) {
  const parsed = parseLooseJson(raw);
  if (!parsed) {
    console.error("专项练习返回的不是合法 JSON:", raw.slice(0, 200));
    throw new HttpError(502, "AI 返回的练习格式异常，请重新生成一次");
  }
  const practice = normalizePractice(parsed);
  if (!practice.questions.length && !practice.writing_task) {
    console.error("专项练习内容为空:", JSON.stringify(practice).slice(0, 200));
    throw new HttpError(502, "AI 返回的练习内容不完整，请重新生成一次");
  }
  return practice;
}

/**
 * 补齐字段并保证类型正确。
 * 关键点：`questions` / `options` 在前端是直接 .map() 的，
 * 模型少给一个字段就会让整个页面白屏 —— 所以这里必须兜住。
 */
function normalizePractice(p: any) {
  const questions = Array.isArray(p.questions)
    ? p.questions
        .filter((q: any) => q && typeof q === "object")
        .map((q: any, i: number) => ({
          id: Number.isFinite(Number(q.id)) ? Number(q.id) : i + 1,
          type: str(q.type, "choice") || "choice",
          content: str(q.content),
          options: Array.isArray(q.options) ? q.options.filter((o: any) => typeof o === "string") : [],
          answer: str(q.answer),
          analysis: str(q.analysis),
        }))
    : [];

  const writing_task = p.writing_task && typeof p.writing_task === "object"
    ? {
        title: str(p.writing_task.title),
        requirement: str(p.writing_task.requirement),
        guidance: str(p.writing_task.guidance),
      }
    : null;

  return {
    title: str(p.title, "专项提分练习") || "专项提分练习",
    introduction: str(p.introduction),
    reading_material: str(p.reading_material),
    questions,
    writing_task,
  };
}

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "POST, OPTIONS");

  try {
    const user = await requireUser(env, request);
    await checkAiQuota(env, user, "practice");

    const body: any = await request.json().catch(() => ({}));
    const s = body.student || {};

    const weakPoints = [];
    if ((s.classicReading || 0) < 12) weakPoints.push("文言文阅读理解");
    if ((s.modernReading || 0) < 20) weakPoints.push("现代文深度鉴赏");
    if ((s.composition || 0) < 35) weakPoints.push("作文立意与素材运用");
    if ((s.dictation || 0) < 8) weakPoints.push("名句名篇默写");
    if ((s.nonLinear || 0) < 7) weakPoints.push("非连续性文本分析");

    const focusArea = weakPoints.length > 0 ? weakPoints.join("、") : "语文综合素养提升";

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

    const messages = [
      { role: "system", content: "你是语文出题专家。" },
      { role: "user", content: prompt },
    ];
    // 握手 20 秒、总预算 60 秒（缘由见 analyze_essay.ts 的同一处注释）
    const AI_OPTS = { temperature: 0.7, maxTokens: 3000, timeoutMs: 20000, totalBudgetMs: 60000 };
    // 题目＋选项＋解析，可能要 3000 字，给 80 秒安全上限。
    const STREAM_OPTS = { safetyMs: 80000, progressFrames: true };

    // ── 流式 ────────────────────────────────────────────────
    // 这个接口产出的是 JSON（题目＋选项＋解析），正文没法直接看，
    // 所以前端只拿增量**算进度**（"已生成 xxx 字"），真正的题目等收尾解析完再渲染。
    // 好处是老师能看出"确实在生成"，而不是对着一个转圈的按钮怀疑卡死了；
    // 而且请求全程在传字节，不容易被平台的空闲判断掐断。
    if (wantsStream(request)) {
      const hs = await callModelscopeStream(env, "text", messages, AI_OPTS);
      console.log(`专项练习（流式）使用模型: ${hs.model}`);
      return pipeAiStream(hs.response, hs.model, {
        onComplete: async (full) => {
          const practice = buildPractice(full);
          await recordAiUsage(env, user, "practice");
          return { result: practice };
        },
        ...STREAM_OPTS,
      });
    }

    const { content: raw, model } = await callModelscope(env, "text", messages, AI_OPTS);
    console.log(`专项练习使用模型: ${model}`);

    const practice = buildPractice(raw);

    // 确认内容可用后才记一次用量
    await recordAiUsage(env, user, "practice");

    return jsonResponse(practice, 200, cors);
  } catch (err: any) {
    return errorResponse(err, request);
  }
}
