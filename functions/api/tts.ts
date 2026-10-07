import { GoogleGenAI, Modality } from "@google/genai";

// 仅允许本站域名（含本地开发端口）跨域调用，替代原先对全网开放的 "*"
const ALLOWED_ORIGINS = [
  "https://smartlexis-cf.pages.dev",
  "http://localhost:5173",
  "http://localhost:8788",
];
function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

export async function onRequestOptions(context: any) {
  return new Response(null, { headers: corsHeadersFor(context.request) });
}

export async function onRequestPost(context: any) {
  const { request, env } = context;
  try {
    const { text } = await request.json();

    if (!env.GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "未配置 GEMINI_API_KEY 环境变量" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeadersFor(request) } }
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

    return new Response(JSON.stringify({ audio: base64Audio }), {
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    });
  } catch (err: any) {
    console.error("TTS API Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    });
  }
}
