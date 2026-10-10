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
  streamBudgetAfter,
  wantsStream,
} from "../../shared/api";

// 作文升格。会消耗 AI 额度，必须登录 + 过每日配额。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "POST, OPTIONS") });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "POST, OPTIONS");

  try {
    const user = await requireUser(env, request);
    await checkAiQuota(env, user, "upgrade");

    const body: any = await request.json().catch(() => ({}));
    const title = body.title || "未命名作文";
    const content = typeof body.content === "string" ? body.content.trim() : "";

    // 没有原文就升格不了。前端本该拦住，这里再兜一道，避免把空内容丢给 AI 白烧额度。
    if (!content) {
      return jsonResponse({ error: "缺少作文原文，请先完成深度诊断再升格" }, 400, cors);
    }

    const prompt = `
你是一位资深的语文特级教师。请对以下作文进行"升格"处理。

题目：《${title}》
原文内容：
${content}

任务要求：
1. 创作一篇 800 字左右的"升格版"范文，要求立意深远、文采斐然、结构严谨。
2. 挑选 3–5 句"金句"（好词好句），并为每一句标注一个主题标签（如：青春、奋斗、自然、哲思等）。
3. 详细列出"亮点解析"，说明修改了哪些地方，提升了什么境界。

输出格式（请严格遵守）：
【升格范文】
（此处为范文内容）

【金句推荐】
- 句子1 | 主题1
- 句子2 | 主题2

【亮点解析】
（此处为解析内容）
`;

    const messages = [
      { role: "system", content: "你是资深语文特级教师，擅长作文升格与教学点评。" },
      { role: "user", content: prompt },
    ];
    // 握手 45 秒、总预算 90 秒（缘由见 analyze_student.ts 的同一处注释）：
    // 2026-10-10 真机实测上游排队时光等响应头要 34.9 秒，原来 22 秒 ⇒ 全链原地被掐死。
    const AI_OPTS = { temperature: 0.7, maxTokens: 3500, timeoutMs: 45000, totalBudgetMs: 90000 };
    // 四个接口里产出最长（整篇升格范文，2000～2800 字）。
    // 安全上限按"整条响应总上限 - 握手已花掉的时间"算：
    // 实测这一份跑了 81.6 秒（首字 59.8 秒，思考 4619 字），写死 90 秒只剩 8.4 秒余量。
    const STREAM_OPTS = { progressFrames: true, diag: { env, kind: "text" } };

    // ── 流式：这个功能产出 2000～2800 字，是四个里最长的 ────────
    // 它其实早就该改流式了：一次性返回要等 30～50 秒，老师只能对着转圈等。
    // 改成流式后开头几秒就能看见字。⚠️ 注意：这里**不是**靠"突破平台上限"，
    // 那个上限经实测在普通请求上也不存在（62.8 秒的普通 JSON 请求照样返回）；
    // 真正的收益是**等待感消失**，以及长文不再被我们自己的预算掐断。
    if (wantsStream(request)) {
      const t0 = Date.now();
      const hs = await callModelscopeStream(env, "text", messages, AI_OPTS);
      console.log(`作文升格（流式）使用模型: ${hs.model}（握手 ${Date.now() - t0}ms）`);
      return pipeAiStream(hs.response, hs.model, {
        transformFinal: stripThinkingNoise,
        onComplete: async () => {
          await recordAiUsage(env, user, "upgrade");
          return {};
        },
        safetyMs: streamBudgetAfter(Date.now() - t0),
        ...STREAM_OPTS,
      });
    }

    const { content: text, model } = await callModelscope(env, "text", messages, AI_OPTS);
    console.log(`作文升格使用模型: ${model}`);

    // 确认内容可用后才记一次用量
    await recordAiUsage(env, user, "upgrade");

    return jsonResponse({ text }, 200, cors);
  } catch (err: any) {
    if (err.name === "AbortError") {
      return jsonResponse({ error: "升格超时，请稍后重试" }, 504, cors);
    }
    return errorResponse(err, request);
  }
}
