import {
  AuthError,
  assertStudentAccess,
  buildEssayReport,
  callModelscope,
  callModelscopeStream,
  checkAiQuota,
  corsHeadersFor,
  errorResponse,
  HttpError,
  isPlaceholderStudentId,
  jsonResponse,
  pipeAiStream,
  recordAiUsage,
  requireUser,
  resolveOwnerTeacherId,
  wantsStream,
} from "../../shared/api";

// 作文阅卷（**第二步：只评分**，2026-10-10 从"一遍过"拆出来）。
// 第一步是 /api/essay_ocr（只认字），原文经老师核对后传到这里。
// 身份与归属全部由令牌推导：
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
    const title = String(formData.get("title") || "未命名作文");
    const requestedStudentId = String(formData.get("studentId") || "").trim();

    // ── 2026-10-10 改成「两步走」的第二步：只评分 ───────────────────
    // 原文由第一步（/api/essay_ocr）认出来、经老师核对修改后传进来。
    // 这一步不再读图，因此可以走**文本链**（候选更多、更快、输出更干净），
    // 也不会再出现"视觉模型慢到把预算吃光"的情况。
    const essayText = String(formData.get("text") || "").trim();
    const handwriting = String(formData.get("handwriting") || "").trim();

    if (!essayText) {
      throw new AuthError(400, "缺少作文原文，请先完成「扫描识别文字」这一步");
    }
    // 原文是老师核对过的，理论上不会太长；给个上限防止被塞进来一整本书
    if (essayText.length > 20000) {
      throw new AuthError(413, `作文原文过长（${essayText.length} 字），请检查是否粘贴了多余内容`);
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

    // 构造消息。原文以**引用块**的形式给出，并在首尾加标记 ——
    // 原文里有引号、顿号、书名号，不加边界的话模型容易把指令和正文搅在一起。
    const parts = [
      `下面是一位学生的作文（文字稿已由老师核对）。`,
      ``,
      `题目：《${title}》`,
    ];
    if (handwriting) {
      // ⚠️ 四维评分里有一项「卷面书写」，而文字模型看不见卷面 ——
      // 所以把第一步认字时拿到的卷面描述一并交给它。少这一句，这一项就只能瞎猜。
      parts.push(`卷面情况（由识别步骤提供）：${handwriting}`);
    }
    parts.push(``, `作文原文：`, `<<<<<<<<<<`, essayText, `>>>>>>>>>>`, ``);
    parts.push(
      `请从"立意深度、结构安排、语言表达、卷面书写"四个维度评分（满分60），`,
      `给出优缺点与升格建议，并严格按照系统提示的 JSON 格式输出。`
    );

    // 不读图了 ⇒ 走文本链。今天实测文本链里最快的模型 4～5 秒就有结果，
    // 而且不会像视觉模型那样把整条链的时间预算吃光。
    const messages = [
      {
        role: "system",
        content: `你是资深语文阅卷组组长。
请严格按照以下 JSON 格式输出，不要输出其他文字：

{
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
}

注意：不要再输出作文原文（我们已经有了），只输出上面这些评分内容。`,
      },
      { role: "user", content: parts.join("\n") },
    ];

    // 2026-10-10 线上实测（公开体检接口打同一模型/同一平台）：
    //   评分 JSON（约 416 字）→ Qwen3.8-Flash-Next 13.9 秒
    //   评分 JSON（约 629 字）→ DeepSeek-V4.1-Flash 13.4 秒
    //
    // 握手 18 秒：多久之内必须把流开起来；开不起来就快速换下一个模型。
    // ⚠️ `timeoutMs` 从此只管**握手**，不再限制正文能写多久 —— 那归流式转发层的
    //    safetyMs / stallMs 管。因为实测同一个模型两次可以差 7 倍
    //    （同一提示词，首字 8.2 秒 vs 61.6 秒），拿总时长判生死只会误杀"慢但正常"的生成。
    // 总预算 60 秒：2026-10-11 线上实测握手偶尔要 32 秒（免费额度被限流时排队），
    //    只给 30 秒会一次全链失败；60 秒够每个候选模型各被握一次（典型 5～8 秒）。
    const AI_OPTS = { temperature: 0.2, maxTokens: 2000, timeoutMs: 18000, totalBudgetMs: 60000 };
    // 这个接口出的是短 JSON（几百字），45 秒的安全上限绰绰有余。
    const STREAM_OPTS = { safetyMs: 45000, progressFrames: true, diag: { env, kind: "text" } };

    /**
     * 从模型回答里把 JSON「抠」出来、校验、落库，最后拼出前端要的记录。
     *
     * 抽成函数是为了让**普通返回**和**流式收尾**两条路走完全一样的收尾逻辑 ——
     * 否则很容易出现"流式能存、普通模式不存"这类只在线上某条路径出现的差异。
     * 校验不通过就抛 HttpError，文案直接给老师看。
     */
    const finalizeEssayResult = async (content: string) => {
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
        throw new HttpError(502, "AI 返回的报告格式异常（可能被截断），请重新提交一次");
      }

      // ── 把「老师核对过的原文」钉回结果里 ──────────────────────────
      // 拆分之后模型只负责评分，不再回传原文；而落库、历史记录、报告拼装
      // 这三处都依赖 result.essay_text。所以在解析成功后统一注回去，
      // 而且**以老师核对过的版本为准**（模型即便回了一段也一律覆盖）。
      result.essay_text = essayText;
      if (handwriting && !result.handwriting) result.handwriting = handwriting;

      // 有原文是前提（上面已校验非空），所以只要看有没有分数就够了
      const hasScore = result && result.score !== null && result.score !== undefined;
      if (!hasScore) {
        console.error("作文阅卷结果为空:", JSON.stringify(result).slice(0, 200));
        throw new HttpError(502, "AI 没能给出评分，请重新点一次「开始批阅」重试");
      }

      // ⚠️ 不能让「模型说它评不了」混成一份 0 分报告。
      // 原文现在由第一步提供、老师核对过，所以"认不出字"不再走这条路；
      // 但模型仍可能回一句"无法评分"同时给 score=0 —— 直接落库展示的话，
      // 老师会以为这篇作文被判了 0 分，比明确报错更糟。
      const scoringStallWords =
        /无法评分|不能评分|无法进行内容分析|内容不足|无法评价|无法给出评分|无法判断/;
      const summaryRaw = String(result?.summary || "") + String(result?.weaknesses?.[0] || "");
      const noContent =
        Array.isArray(result?.strengths) &&
        result.strengths.length === 0 &&
        Array.isArray(result?.suggestions) &&
        result.suggestions.length === 0;
      if (Number(result?.score) === 0 && (scoringStallWords.test(summaryRaw) || noContent)) {
        console.error("作文阅卷：模型表示无法评分 —", summaryRaw.slice(0, 120));
        throw new HttpError(
          502,
          "AI 这次没能完成评分（可能认为原文内容不完整）。请检查原文是否完整，或重新点一次「开始批阅」"
        );
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
            essayText,
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

      return {
        id,
        studentId,
        teacherId,
        title,
        essay_text: essayText,
        analysis: analysisMarkdown,
        analysis_json: JSON.stringify(result),
        date,
      };
    };

    // ── 流式 ────────────────────────────────────────────────
    // 评分报告是 JSON，正文没法直接看，所以前端拿增量算进度、收尾再渲染。
    // 收益主要在"不贴着平台单请求上限"和"能看出确实在跑"。
    if (wantsStream(request)) {
      const hs = await callModelscopeStream(env, "text", messages, AI_OPTS);
      console.log(`作文阅卷（流式）使用模型: ${hs.model}`);
      return pipeAiStream(hs.response, hs.model, {
        onComplete: async (full) => ({ result: await finalizeEssayResult(full) }),
        ...STREAM_OPTS,
      });
    }

    const { content, model: usedModel, attempts } = await callModelscope(env, "text", messages, AI_OPTS);

    // 记下是哪个模型出的卷、路上还试过谁 ——
    // 以后平台再下架 / 改名模型，看日志就知道发生了什么。
    console.log(
      `作文阅卷使用模型: ${usedModel}` +
        (attempts.length ? `（此前失败：${attempts.map((a) => `${a.model}:${a.result}`).join("、")}）` : "")
    );

    const record = await finalizeEssayResult(content);
    return jsonResponse(record, 200, cors);
  } catch (err: any) {
    console.error("analyze_essay error:", err);

    if (err.name === "AbortError") {
      return jsonResponse({ error: "批阅超时，请稍后重试" }, 504, cors);
    }
    return errorResponse(err, request);
  }
}
