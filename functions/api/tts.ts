import { GoogleGenAI, Modality } from "@google/genai";
import { checkAiQuota, corsHeadersFor, errorResponse, jsonResponse, recordAiUsage, requireUser } from "../../shared/api";

// 语音合成（朗读范文）。会消耗 Gemini 额度，必须登录 + 过每日配额。

export const onRequestOptions = (context: any) =>
  new Response(null, { status: 204, headers: corsHeadersFor(context.request, "POST, OPTIONS") });

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, "POST, OPTIONS");

  try {
    const user = await requireUser(env, request);
    await checkAiQuota(env, user, "tts");

    const body: any = await request.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return jsonResponse({ error: "缺少要朗读的文字" }, 400, cors);
    }

    if (!env.GEMINI_API_KEY) {
      // ⚠️ 这里刻意返回 **200** 而不是 500。
      //  Gemini 语音合成要 Google 账号 + 能连通 google 的网络，国内基本用不上，
      //  所以"没配"是常态、不算故障。返回 500 会带来两个坏处：
      //    ① 浏览器控制台每次朗读都刷一条红色报错（老师截图里就是一片红，
      //       他会当成程序坏了）；
      //    ② 前端没法区分"没配置"（该安静地走本机朗读）和"真出错"（该报给用户）。
      //  真正的朗读由前端用浏览器自带语音合成完成 —— 那条路零配置、离线可用。
      return jsonResponse(
        {
          audio: null,
          configured: false,
          error: "未配置 GEMINI_API_KEY，已改用浏览器本机朗读",
        },
        200,
        cors
      );
    }

    const keys = env.GEMINI_API_KEY.split(",").map((k: string) => k.trim());
    const apiKey = keys[Math.floor(Math.random() * keys.length)];

    const genAI = new GoogleGenAI({ apiKey });

    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [
        {
          parts: [
            {
              text: `请作为一名专业的播音员，准确、自然地朗读以下文字。特别注意多音字在上下文中的正确发音，保持语速适中：\n\n${text}`,
            },
          ],
        },
      ],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Zephyr" },
          },
        },
      },
    });

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      throw new Error("Gemini 未返回音频数据");
    }

    // 确认真的拿到音频后才记一次用量
    await recordAiUsage(env, user, "tts");

    return jsonResponse({ audio: base64Audio }, 200, cors);
  } catch (err: any) {
    console.error("TTS API Error:", err);
    return errorResponse(err, request);
  }
}
