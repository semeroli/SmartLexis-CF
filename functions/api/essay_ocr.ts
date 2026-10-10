import {
  AuthError,
  assertStudentAccess,
  callModelscope,
  checkAiQuota,
  corsHeadersFor,
  errorResponse,
  isPlaceholderStudentId,
  jsonResponse,
  parseOcrOutput,
  recordAiUsage,
  requireUser,
} from "../../shared/api";

// ─────────────────────────────────────────────────────────────
// 作文「第一步：只认字」
//
// 2026-10-10 拆出来的。原来是「一次调用里让视觉模型既认字又评分」，问题是：
//   · 输出量极大（原文 ＋ 四维评分 ＋ 优缺点 ＋ 升格建议），而大模型是一个字
//     一个字吐出来的 —— 输出量几乎线性决定等待时长，实测一次要 20～35 秒；
//   · 手写作文认错字是常态，可老师**看不见**：评分基于错字给出，还显得头头是道；
//   · 评分失败 = 照片白拍，只能重新传图再等一次。
//
// 拆开之后这个接口只做一件事：**把字认出来**。不评价、不改错、不补全。
// 认完把原文摊在老师面前，她核对／改错，再走第二步评分。
//
// ⚠️ 除了原文，还要一句**卷面描述** —— 因为四维评分里有一项"卷面书写"，
//    那是纯文本模型看不见的东西。少这一句，这一步就把信息弄丢了。
// ─────────────────────────────────────────────────────────────

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "POST, OPTIONS") });

const SYSTEM_PROMPT = `你是语文老师的助手，专门把学生手写作文的照片**逐字转写**成文字。

严格按要求做：
1. 只做转写。**不要评价、不要打分、不要改错别字、不要补全句子、不要分段改写。**
2. 保留原文的自然段，段与段之间空一行。
3. 遇到确实认不清的字，用【?】占位 —— 不要猜、不要编。
4. 图片里如果有作文标题，作为第一行写出来。
5. 不要输出任何解释、说明或客套话。

另外，用**一句话**（不超过 30 字）描述这份卷面的书写情况（字迹是否工整、有无涂改、整体观感）。

输出格式必须是这样两段，标记照抄：

===卷面===
字迹工整，偶有涂改。
===原文===
（这里是从第一行到最后一行的作文原文）`;

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "POST, OPTIONS");

  try {
    const user = await requireUser(env, request);

    const formData = await request.formData();
    const title = String(formData.get("title") || "未命名作文");
    const requestedStudentId = String(formData.get("studentId") || "").trim();
    const imagesJson = formData.get("images");

    if (!imagesJson) throw new AuthError(400, "缺少作文图片");

    let essayImages: string[];
    try {
      essayImages = JSON.parse(imagesJson as string);
    } catch (e) {
      throw new AuthError(400, "图片数据格式错误");
    }

    const safeImages = essayImages.slice(0, 2);
    if (safeImages.length === 0) throw new AuthError(400, "未提供有效图片");

    // 体量闸门：和阅卷接口同一套理由 —— 解析超大 base64、再拼成几 MB 的请求体
    // 转发给 AI 都是实打实的 CPU 开销，而 Cloudflare 免费版单请求只有 10ms，
    // 超了会被**直接掐断**，前端只看到一句"服务器错误"。宁可在这里说清楚。
    const totalChars = safeImages.reduce(
      (n: number, s: any) => n + (typeof s === "string" ? s.length : 0),
      0
    );
    const MAX_TOTAL_CHARS = 8 * 1024 * 1024;
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new AuthError(
        413,
        `图片过大（约 ${(totalChars / 1024 / 1024).toFixed(1)}MB），请重新拍摄或选择更小的图片后再试`
      );
    }

    // 教师只能给本班学生识别（学生还没导入名单时按占位学号放行）
    if (user.role === "teacher" && !isPlaceholderStudentId(requestedStudentId)) {
      await assertStudentAccess(env, user, requestedStudentId);
    }

    await checkAiQuota(env, user, "ocr");

    const contentParts: any[] = [
      { type: "text", text: `请转写这张手写作文照片的内容（题目：《${title}》）。` },
    ];
    for (let img of safeImages) {
      if (!img.startsWith("data:image/")) img = `data:image/jpeg;base64,${img}`;
      contentParts.push({ type: "image_url", image_url: { url: img } });
    }

    console.log(`作文识别：${safeImages.length} 张图，题目《${title}》`);

    const { content, model: usedModel, attempts, finishReason } = await callModelscope(
      env,
      "vision",
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: contentParts },
      ],
      // ⚠️ 2026-10-10 真机实测修正：原来是「单模型 20 秒、整条链 30 秒」，
      //    但上游排队时光等响应头就要 34.9 秒 ⇒ 第一枪 20 秒被掐死、第二枪只剩 10 秒
      //    也必然超时，认字整体不可用（当天实测确实这样失败过一次）。
      //    而且 20 秒 × 2 个模型 = 40 秒 > 30 秒预算，本来就自相矛盾。
      // 现在：单模型 45 秒、整条链 90 秒 ⇒ 视觉链两个模型各能握满一次。
      { temperature: 0.1, maxTokens: 2500, timeoutMs: 45000, totalBudgetMs: 90000 }
    );

    console.log(
      `作文识别使用模型: ${usedModel}（finish=${finishReason || "?"}）` +
        (attempts.length ? `，此前失败：${attempts.map((a) => `${a.model}:${a.result}`).join("、")}` : "")
    );

    const { text, handwriting } = parseOcrOutput(content);

    if (!text || text.length < 5) {
      console.error("作文识别：没能拿到有效原文 —", content.slice(0, 200));
      return jsonResponse(
        {
          error:
            "这张图里没能认出作文内容。请换一张更清晰、光线更好的照片重试" +
            "（尽量只拍作文那一页，拍正、把字迹拍清楚）",
        },
        502,
        cors
      );
    }

    // 认字这一步就算走到了有效结果，记一次用量
    await recordAiUsage(env, user, "ocr");

    // ⚠️ 被长度上限截断时，老师手里会是**半篇作文**，而界面上完全看不出异常 ——
    //    评分接着基于半篇作文给出，还显得头头是道。宁可明说，让她自己决定要不要用。
    const truncated = finishReason === "length";

    return jsonResponse(
      {
        text,
        handwriting,
        truncated,
        chars: text.length,
        warning: truncated
          ? "识别到的内容可能被长度上限截断（图片里的作文较长）。请核对一下末尾是否完整，必要时分两张图重新识别。"
          : "",
        model: usedModel,
      },
      200,
      cors
    );
  } catch (err: any) {
    console.error("essay_ocr error:", err);
    if (err.name === "AbortError") {
      return jsonResponse({ error: "识别超时，请稍后重试" }, 504, cors);
    }
    return errorResponse(err, request);
  }
}
