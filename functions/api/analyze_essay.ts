import {
  AuthError,
  assertStudentAccess,
  buildEssayReport,
  callModelscope,
  checkAiQuota,
  corsHeadersFor,
  errorResponse,
  isPlaceholderStudentId,
  jsonResponse,
  recordAiUsage,
  requireUser,
  resolveOwnerTeacherId,
} from "../../shared/api";

// 作文阅卷。身份与归属全部由令牌推导：
//   学生  → 只能给自己批阅，记录归本班教师名下
//   教师  → 只能给本班学生批阅（学生还没导入名单时按占位学号放行，不打断正常使用）
//   管理员 → 不限
// 前端传来的 studentId / teacherId 只当作"想批阅哪个学生"的意图，不再当作身份凭据。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "POST, OPTIONS") });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "POST, OPTIONS");

  try {
    const user = await requireUser(env, request);

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
    const requestedStudentId = String(formData.get("studentId") || "").trim();
    const imagesJson = formData.get("images");

    if (!imagesJson) throw new AuthError(400, "缺少作文图片");

    let essayImages: string[];
    try {
      essayImages = JSON.parse(imagesJson as string);
    } catch (e) {
      throw new AuthError(400, "图片数据格式错误");
    }

    // 限制最多 2 张图
    const safeImages = essayImages.slice(0, 2);
    if (safeImages.length === 0) throw new AuthError(400, "未提供有效图片");

    // 体量闸门。Cloudflare 免费版给单个请求的 CPU 时间只有 10 毫秒，而解析超大
    // base64、再 JSON.stringify 成一个几 MB 的请求体转发给 AI，都是实打实的 CPU
    // 开销 —— 一旦超限，平台会**直接掐断请求**，前端只能看到一句"服务器错误"，
    // 排查起来毫无线索。与其被平台默默掐断，不如在这里明确告诉老师"图太大了"。
    // （前端现在会先把图压到长边 1600px，正常一张约 200～500KB；走到这条说明
    //   压缩没生效，例如浏览器太老或手动绕过了前端。）
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

    // ── 归属与身份：服务端说了算 ────────────────────
    let studentId: string;
    let teacherId: string;

    if (user.role === "student") {
      // 学生只能给自己批阅，即使请求体里写了别人的学号也没用
      studentId = user.studentId || user.uid;
      // 记录归到本班教师名下，这样教师在班级里能看到这条批阅记录
      teacherId = (await resolveOwnerTeacherId(env, studentId)) || user.uid;
    } else if (user.role === "admin") {
      studentId = requestedStudentId || "N/A";
      teacherId = String(formData.get("teacherId") || user.uid);
    } else {
      // 教师
      if (!isPlaceholderStudentId(requestedStudentId)) {
        await assertStudentAccess(env, user, requestedStudentId);
      }
      studentId = requestedStudentId || "N/A";
      teacherId = user.uid;
    }

    // 真正开始烧额度之前，先过每日配额闸门
    await checkAiQuota(env, user, "essay");

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

    console.log(`作文阅卷：${safeImages.length} 张图，题目《${title}》`);

    // 阅卷要「读图」，所以走 vision 这条候选链（魔搭的视觉模型）。
    // 原先用的是第三方中转站 apihub.agnes-ai.com —— 2026-10-08 起它对我们的
    // 请求持续回 429（Cloudflare error code 1015 = 被限流），阅卷因此整个失效。
    // 索性统一到魔搭：和另外三个 AI 功能同一家，少一个要单独维护的账号。
    const { content, model: usedModel, attempts } = await callModelscope(
      env,
      "vision",
      [
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
      // 时间安排：单个模型最多等 50 秒（视觉大模型首次唤醒要冷启动，短了等不到），
      // 整条链最多 75 秒。之所以不是"每个都等 50 秒"—— 候选链有好几个，逐个等满
      // 会让老师对着转圈十几分钟。留 25 秒余量是因为 Cloudflare 边缘对源站的等待
      // 上限是 100 秒（超了会回 524），必须在边缘放弃之前自己先收手。
      { temperature: 0.2, maxTokens: 3500, timeoutMs: 50000, totalBudgetMs: 75000 }
    );

    // 记下是哪个模型出的卷、路上还试过谁 ——
    // 以后平台再下架 / 改名模型，看日志就知道发生了什么。
    console.log(
      `作文阅卷使用模型: ${usedModel}` +
        (attempts.length ? `（此前失败：${attempts.map((a) => `${a.model}:${a.result}`).join("、")}）` : "")
    );

    // 把 JSON 从模型回答里「抠」出来。
    // 不能只剥开头的 ```json —— 预览版模型常写成「好的，以下是分析：\n```json\n{...}\n```」，
    // 那样 JSON.parse 必失败。所以三步走：先截代码块，再从第一个 { 取到最后一个 }。
    let raw = String(content).trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1].trim()) raw = fence[1].trim();
    const braceOpen = raw.indexOf("{");
    const braceClose = raw.lastIndexOf("}");
    if (braceOpen >= 0 && braceClose > braceOpen) raw = raw.slice(braceOpen, braceClose + 1);

    let result: any;
    try {
      result = JSON.parse(raw);
    } catch (e) {
      // 以前这里会把"格式异常"当成一份分析结果返回 200 —— 老师看到的就是一张
      // 满屏 "?" 的空报告，还会被当成 AI 的结论。宁可明确报错让她重试一次。
      console.error("JSON parse error:", raw.substring(0, 200));
      return jsonResponse({
        error: "AI 返回的报告格式异常（可能被截断），请重新提交一次",
      }, 502, cors);
    }

    // 连分数和原文都没有，说明这次识别基本没成功，同样不该当成结果返回
    const hasScore = result && result.score !== null && result.score !== undefined;
    const hasText = !!(result && typeof result.essay_text === "string" && result.essay_text.trim());
    if (!hasScore && !hasText) {
      console.error("作文阅卷结果为空:", JSON.stringify(result).slice(0, 200));
      return jsonResponse({
        error: "没能识别出作文内容或评分，请换一张更清晰的照片重试",
      }, 502, cors);
    }

    // 到这里才算一次有效调用
    await recordAiUsage(env, user, "essay");

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

    // ✅ 返回前端期望的 WritingRecord 格式
    // 报告文本由 shared/api 的 buildEssayReport 统一拼装 —— history 接口读历史时
    // 用的是同一个函数，两处不会各写一份而对不上。
    const analysisMarkdown = buildEssayReport(result);

    return jsonResponse({
      id,
      studentId,
      teacherId,
      title,
      essay_text: result.essay_text || '',
      analysis: analysisMarkdown,
      analysis_json: JSON.stringify(result),
      date,
    }, 200, cors);

  } catch (err: any) {
    console.error("analyze_essay error:", err);

    if (err.name === "AbortError") {
      return jsonResponse({ error: "阅卷超时（60秒），请稍后重试" }, 504, cors);
    }
    return errorResponse(err, request);
  }
}
