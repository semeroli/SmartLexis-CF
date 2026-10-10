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
    // 这个接口产出最长（整篇升格范文，maxTokens 3500），所以单模型给到 22 秒。
    const AI_OPTS = { temperature: 0.7, maxTokens: 3500, timeoutMs: 22000, totalBudgetMs: 31000 };

    // ── 流式：这个功能产出 2000～2800 字，是四个里最长的 ────────
    // 按实测 30～45 字/秒，一次吐完要 50 秒以上 —— **远超平台单请求上限**，
    // 所以它其实早就该改流式了。改成流式后，第一句话 1～2 秒就出现，
    // 老师可以边看边读，不用盯着转圈等一分钟。
    if (wantsStream(request)) {
      const hs = await callModelscopeStream(env, "text", messages, AI_OPTS);
      console.log(`作文升格（流式）使用模型: ${hs.model}`);
      return pipeAiStream(hs.response, hs.model, {
        transformFinal: stripThinkingNoise,
        onComplete: async () => {
          await recordAiUsage(env, user, "upgrade");
          return {};
        },
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
