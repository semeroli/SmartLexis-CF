import React, { useState, useEffect, useRef } from 'react';
import {
  Users, UserCircle, BookOpen, PenTool,
  TrendingUp, Award, AlertCircle, CheckCircle2,
  Search, Filter, Download, Upload, LogOut,
  ChevronRight, BrainCircuit, Target, FileText,
  Loader2, ImageIcon, History, Square, ArrowRight,
  BarChart3, Activity, Volume2, Edit3, Trash2,
  Bookmark, Library, LayoutDashboard, Menu, X, Sparkles, KeyRound
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, RadarChart, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, Radar, Legend,
  LineChart, Line
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
// html2canvas-pro 是 html2canvas 的替代版：支持 Tailwind v4 输出的 oklch / oklab / color-mix 颜色。
// 原来的 html2canvas@1.4.1 不认识这些颜色格式，遇到就抛异常 —— 所以"导出 PDF"必然失败。
import html2canvas from 'html2canvas-pro';
import { cn, formatDay } from './lib/utils';
import { SCORE_ITEMS, LITERACY_MAX, modernReadingTotal, TOTAL_MAX } from './lib/score';
import {
  apiFetch,
  apiStream,
  clearSession,
  getStoredUser,
  getToken,
  setUnauthorizedHandler,
} from './lib/api';
import Auth from './components/Auth';
import AdminDashboard from './components/AdminDashboard';
import ChangePasswordModal from './components/ChangePasswordModal';

/**
 * 「正在生成」这句提示语的统一生成器（四处界面共用）。
 *
 * 为什么分三段：实测推理型模型会**先构思十几秒到几十秒**才写第一个正文字。
 * 那段时间如果提示语一直卡在「正在批阅…」，老师看到的就是一个不动的转圈，
 * 会以为程序死了 —— 而其实模型正在工作。所以中间这段要如实说出来。
 *
 *   chars > 0      正文已经出来了 ⇒ 报"已写 N 字"
 *   thinking > 0   只出了思考过程 ⇒ 报"正在构思（已梳理 N 字）"
 *   都没有         刚发出请求     ⇒ 只报动作名
 */
function streamingLabel(action: string, chars: number, thinking: number, prefix = '已写') {
  if (chars > 0) return `${action}${prefix} ${chars} 字`;
  if (thinking > 0) return `AI 正在构思…（已梳理 ${thinking} 字）`;
  return action;
}

/**
 * 同上，但给**按钮**用 —— 按钮位置窄，文案必须短，长了会折行把按钮撑高。
 * 信息量不能减：正文出来了报字数，只在构思就报"构思中"，两样都没有就报动作名。
 */
function buttonLabel(action: string, chars: number, thinking: number, prefix = '已写') {
  if (chars > 0) return `${action}${prefix} ${chars} 字`;
  if (thinking > 0) return `构思中…(${thinking} 字)`;
  return action;
}

// ═══════════════════════════════════════════════════════════════
// 「本机朗读」的三个零件（2026-10-10）
// ═══════════════════════════════════════════════════════════════
// 背景：朗读范文原来走服务端（Gemini 语音合成），但 GEMINI_API_KEY 一直没配，
// 而且 Gemini 需要能连通 Google 的网络 —— 国内基本用不了。
// 所以**本机朗读才是主力**，服务端那条只是"配了就用、音色更好"的加分项。
//
// 原来的兜底写法有三个坑，实测全踩到了（老师反馈"朗读范文不行"就是这个）：
//   ① 不指定 voice          → Chrome 可能选中「Google 普通话」，那是**联网语音**，
//                             国内网络下它不报错、也不出声，就那样静默地什么都不发生；
//   ② cancel() 后同步 speak() → Chrome 会把这次朗读整个吞掉（同样不报错、不出声）；
//   ③ 整篇一次塞进去        → 长文会被 Chrome 中途掐断，读一半停了。
// 下面的三个函数就是逐条对着修的。

/** 按句子切块。整篇一次性读会被 Chrome 掐断，必须拆成短句排队读。 */
function chunkForSpeech(text: string, maxLen = 110): string[] {
  const parts = text.match(/[^。！？；!?;\n]+[。！？；!?;\n]?/g) || [text];
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + p).length > maxLen) { out.push(cur); cur = p; }
    else cur += p;
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [text];
}

/**
 * 挑一个中文语音。
 * **必须优先「本地语音」(localService === true)**：微软的慧慧/康康/瑶瑶是系统自带的，
 * 离线可用；叫「Google 普通话」的那个是联网语音，国内网络下会静默失败。
 */
function pickChineseVoice(): SpeechSynthesisVoice | null {
  const ss = typeof window !== 'undefined' ? window.speechSynthesis : null;
  if (!ss) return null;
  const all = ss.getVoices() || [];
  const zh = all.filter(v => /^zh\b|^zh-/i.test(v.lang || '') || /中文|普通话|国语|汉语/i.test(v.name || ''));
  if (!zh.length) return null;
  const local = zh.filter(v => v.localService);
  const pool = local.length ? local : zh;
  return (
    pool.find(v => /Huihui|Kangkang|Yaoyao|Xiaoxiao|Xiaoyi|Yunxi|Yunyang|Hanhan/i.test(v.name || '')) ||
    pool.find(v => !/Google/i.test(v.name || '')) ||
    pool[0]
  );
}

/** getVoices() 首次调用常常返回空数组（列表还没加载完），要等 voiceschanged 事件。 */
function waitForVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const ss = typeof window !== 'undefined' ? window.speechSynthesis : null;
    if (!ss) return resolve([]);
    const now = ss.getVoices() || [];
    if (now.length) return resolve(now);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { ss.onvoiceschanged = null; } catch (_) {}
      resolve(ss.getVoices() || []);
    };
    try { ss.onvoiceschanged = finish; } catch (_) {}
    if (typeof ss.addEventListener === 'function') ss.addEventListener('voiceschanged', finish);
    setTimeout(finish, timeoutMs);
  });
}

/** 把语音引擎的英文错误码翻成老师能看懂的话。 */
function speechErrorMessage(code: string): string {
  const map: Record<string, string> = {
    'not-allowed': '浏览器没允许发声，请再点一次「朗读范文」',
    'synthesis-failed': '本机语音引擎启动失败（多半是选到了需要联网的语音）',
    'audio-busy': '音频设备被占用，请先关掉其他正在播放声音的页面',
    'audio-hardware': '没检测到可用的音箱或耳机',
    'network': '这条语音需要联网，但当前网络不可用',
    'language-unavailable': '系统里没有中文语音包',
    'voice-unavailable': '选中的语音不可用',
    'interrupted': '朗读被打断',
    'canceled': '朗读已取消',
  };
  return map[code] || `语音引擎报错（${code || '未知'}）`;
}

/**
 * 从升格输出里抽出**只该朗读的那一段**：范文本身。
 *
 * 为什么要单独抽一个函数：原来 playTTS / preGenerateTTS 各写一份一样的正则，而
 * 那三个正则只认 `【升格范文】` 这种带方括号的**原始**标记；可是页面上显示的
 * `actionContent` 是「### 升格范文 + ### 亮点解析」拼出来的，一个都匹配不上，
 * 于是退化成"从'升格范文'四个字往后全念" —— 老师会把「亮点解析」也听一遍。
 * 本地实测：总共念了 843 字，而范文只有 500 出头。
 */
function extractEssayText(text: string): string {
  const pick = (re: RegExp): string | null => {
    const m = text.match(re);
    return m && m[1] && m[1].trim().length > 10 ? m[1].trim() : null;
  };
  const out =
    pick(/【升格范文】([\s\S]*?)(?=【亮点解析】|【亮点赏析】|【金句推荐】|【|$)/) ??
    pick(/(?:^|\n)\s*(?:#{1,6}\s*)?升格范文[^\n]*\n([\s\S]*?)(?=\n\s*(?:#{1,6}\s*)?(?:亮点解析|亮点赏析|金句推荐)|$)/) ??
    pick(/范文正文([\s\S]*?)(?=亮点解析|解析|【|$)/) ??
    (text.includes('升格范文') ? text.slice(text.indexOf('升格范文') + 4) : text);
  // 兜底：不管走哪条路，「亮点解析 / 金句推荐」都只该给眼睛看，不念出来
  return out.split(/亮点解析|亮点赏析|金句推荐/)[0].replace(/[#*`]/g, '').trim();
}

// --- Types ---
interface Student {
  dbId?: number;
  id: string;
  name: string;
  choice: number;
  modernReading: number;
  classicReading: number;
  nonLinear: number;
  dictation: number;
  composition: number;
  total: number;
  teacher_id?: string;
}

// 成绩录入弹窗的字段标签（原来直接显示 choice / modernReading 这类英文键名，老师看不懂）
// 满分口径见 src/lib/score.ts，六项合计 150 分。
// 「非连续性文本」不是独立板块、属于现代文阅读的一部分：现代文那一格可以直接填
// 35 分制的总分，非连续性留空即可；两格都填也可以，统计时会自动相加。
const SCORE_INPUT_FIELDS: { key: keyof Student; label: string }[] = [
  { key: 'choice', label: '选择题 / 25' },
  { key: 'modernReading', label: '现代文阅读 / 35' },
  { key: 'classicReading', label: '文言文阅读 / 20' },
  { key: 'nonLinear', label: '非连续性（并入现代文）' },
  { key: 'dictation', label: '默写填空 / 10' },
  { key: 'composition', label: '作文 / 60' },
];

interface WritingRecord {
  id: string;
  studentId: string;
  title: string;
  analysis: string;
  /** 作文原文：阅卷接口会回传，历史记录接口暂不返回，所以是可选的 */
  essay_text?: string;
  date: string;
}

interface User {
  uid: string;
  email: string;
  name: string;
  role: 'student' | 'teacher' | 'admin';
  studentId?: string;
}

interface ScoreHistory {
  id: number;
  student_id: string;
  choice: number;
  modern_reading: number;
  classic_reading: number;
  non_linear: number;
  dictation: number;
  composition: number;
  total: number;
  created_at: string;
}

interface PracticeQuestion {
  id: number;
  type: 'choice';
  content: string;
  options: string[];
  answer: string;
  analysis: string;
}

interface PracticeData {
  title: string;
  introduction: string;
  reading_material?: string;
  questions: PracticeQuestion[];
  writing_task?: {
    title: string;
    requirement: string;
    guidance: string;
  };
}

interface WritingMaterial {
  id: number;
  student_id: string;
  content: string;
  theme: string;
  source_title: string;
  created_at: string;
}

// --- UI Components ---
// id 只用来给"引导滚动 + 高亮"定位卡片（见「智能学习处方」那张卡）。
const Card = ({ title, subtitle, children, className, delay = 0, id }: any) => (
  <motion.div
    id={id}
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.5, delay }}
    className={cn("bg-white rounded-[32px] p-8 shadow-sm border border-slate-100 hover:shadow-xl hover:shadow-indigo-500/5 transition-all duration-500", className)}
  >
    {(title || subtitle) && (
      <div className="mb-8">
        {title && <h3 className="text-xl font-bold text-slate-900 tracking-tight">{title}</h3>}
        {subtitle && <p className="text-xs text-slate-400 font-bold mt-1.5 uppercase tracking-widest">{subtitle}</p>}
      </div>
    )}
    {children}
  </motion.div>
);

const StatBox = ({ label, value, subValue, icon: Icon, colorClass, delay = 0 }: any) => (
  <motion.div
    initial={{ opacity: 0, scale: 0.95 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ duration: 0.4, delay }}
    className="bg-white p-6 rounded-[32px] border border-slate-100 shadow-sm flex items-center gap-5 group hover:border-indigo-100 transition-all duration-300"
  >
    <div className={cn("w-14 h-14 rounded-2xl flex items-center justify-center transition-transform group-hover:scale-110 duration-500", colorClass)}>
      <Icon className="w-7 h-7" />
    </div>
    <div>
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-black text-slate-900">{value}</span>
        {subValue && <span className="text-xs font-bold text-emerald-500">{subValue}</span>}
      </div>
    </div>
  </motion.div>
);

const GrowthCurve = ({ history }: { history: ScoreHistory[] }) => {
  if (!history || history.length === 0) return null;

  const data = history.map(h => ({
    // 用 formatDay 而不是 new Date：Safari 解析不了 "2026-07-03 08:30:56"
    date: formatDay(h.created_at, { month: 'short', day: 'numeric' }),
    total: h.total,
    composition: h.composition,
    reading: h.modern_reading + h.classic_reading
  }));

  return (
    <div className="h-[300px] w-full mt-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
          <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} />
          <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} />
          <Tooltip
            contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
          />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 20 }} />
          <Line type="monotone" dataKey="total" name="总分" stroke="#6366f1" strokeWidth={3} dot={{ r: 4, fill: '#6366f1' }} activeDot={{ r: 6 }} />
          <Line type="monotone" dataKey="composition" name="作文" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="reading" name="阅读" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

const InteractivePractice = ({ data }: { data: PracticeData }) => {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [showAnalysis, setShowAnalysis] = useState<Record<number, boolean>>({});

  return (
    <div className="space-y-8">
      <div className="bg-indigo-50 p-6 rounded-3xl border border-indigo-100">
        <h4 className="text-lg font-bold text-indigo-900 mb-2">{data.title}</h4>
        <p className="text-sm text-indigo-700 leading-relaxed">{data.introduction}</p>
      </div>

      {data.reading_material && (
        <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm">
          <h5 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">阅读材料</h5>
          <div className="text-slate-700 leading-loose text-lg font-serif italic">
            {data.reading_material}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {data.questions.map((q, idx) => (
          <div key={q.id} className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm hover:border-indigo-100 transition-colors">
            <div className="flex items-start gap-4">
              <span className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold text-sm shrink-0">
                {idx + 1}
              </span>
              <div className="flex-1">
                <p className="text-slate-900 font-medium mb-6 text-lg">{q.content}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {q.options.map((opt) => {
                    const optKey = opt.charAt(0);
                    const isSelected = answers[q.id] === optKey;
                    const isCorrect = q.answer === optKey;
                    const showResult = showAnalysis[q.id];

                    return (
                      <button
                        key={opt}
                        onClick={() => !showResult && setAnswers(prev => ({ ...prev, [q.id]: optKey }))}
                        className={cn(
                          "px-6 py-4 rounded-2xl text-left text-sm font-medium transition-all border-2",
                          isSelected
                            ? (showResult ? (isCorrect ? "bg-emerald-50 border-emerald-500 text-emerald-700" : "bg-rose-50 border-rose-500 text-rose-700") : "bg-indigo-50 border-indigo-500 text-indigo-700")
                            : "bg-slate-50 border-transparent text-slate-600 hover:bg-slate-100"
                        )}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-6 flex items-center gap-4">
                  <button
                    onClick={() => setShowAnalysis(prev => ({ ...prev, [q.id]: !prev[q.id] }))}
                    className="text-xs font-bold text-indigo-600 hover:text-indigo-700 flex items-center gap-2"
                  >
                    {showAnalysis[q.id] ? "隐藏解析" : "查看解析"}
                    <ChevronRight className={cn("w-4 h-4 transition-transform", showAnalysis[q.id] && "rotate-90")} />
                  </button>
                  {answers[q.id] && !showAnalysis[q.id] && (
                    <span className="text-xs font-bold text-emerald-500 flex items-center gap-1">
                      <CheckCircle2 className="w-4 h-4" /> 已选择
                    </span>
                  )}
                </div>

                <AnimatePresence>
                  {showAnalysis[q.id] && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-6 pt-6 border-t border-slate-100">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">正确答案:</span>
                          <span className="text-lg font-black text-emerald-500">{q.answer}</span>
                        </div>
                        <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-2xl">
                          {q.analysis}
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        ))}
      </div>

      {data.writing_task && (
        <div className="bg-white p-8 rounded-3xl border-2 border-dashed border-indigo-100">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-2xl bg-indigo-500 flex items-center justify-center">
              <PenTool className="text-white w-5 h-5" />
            </div>
            <h5 className="text-xl font-bold text-slate-900">{data.writing_task.title}</h5>
          </div>
          <div className="space-y-4">
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">写作要求</p>
              <p className="text-slate-700 leading-relaxed">{data.writing_task.requirement}</p>
            </div>
            <div className="bg-indigo-50/50 p-6 rounded-2xl">
              <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest mb-2">写作指导</p>
              <p className="text-indigo-900 text-sm leading-relaxed">{data.writing_task.guidance}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const ClassHeatmap = ({ students }: { students: Student[] }) => {
  if (!students.length) return null;

  const data = SCORE_ITEMS.map((t) => {
    const avg = students.reduce((acc, s) => acc + t.get(s), 0) / students.length;
    const rate = Math.round((avg / t.max) * 100);
    return { name: t.label, rate };
  });

  return (
    <div className="h-[300px] w-full mt-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
          <XAxis type="number" domain={[0, 100]} hide />
          <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#64748b', fontWeight: 'bold' }} width={80} />
          <Tooltip
            cursor={{ fill: '#f8fafc' }}
            contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
            formatter={(value) => [`${value}%`, '掌握率']}
          />
          <Bar dataKey="rate" radius={[0, 12, 12, 0]} barSize={24}>
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.rate >= 80 ? '#10b981' : entry.rate >= 60 ? '#6366f1' : '#f43f5e'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

const MaterialLibrary = ({ materials, onDelete }: { materials: WritingMaterial[]; onDelete: (id: number) => void }) => {
  const [filterTheme, setFilterTheme] = useState('全部');
  const themes = ['全部', ...Array.from(new Set(materials.map(m => m.theme)))];

  const filtered = filterTheme === '全部' ? materials : materials.filter(m => m.theme === filterTheme);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight">作文素材库</h2>
          <p className="text-slate-500 font-bold mt-1">积累 AI 升格范文中的精彩表达</p>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2 max-w-md">
          {themes.map(t => (
            <button
              key={t}
              onClick={() => setFilterTheme(t)}
              className={cn(
                "px-4 py-2 rounded-full text-xs font-black transition-all whitespace-nowrap",
                filterTheme === t ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-slate-500 hover:bg-slate-50"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {filtered.length > 0 ? filtered.map((m, idx) => (
          <motion.div
            key={m.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.05 }}
            className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm hover:shadow-xl hover:shadow-indigo-500/5 transition-all group relative"
          >
            <div className="flex justify-between items-start mb-4">
              <span className="px-3 py-1 bg-indigo-50 text-indigo-600 rounded-full text-[10px] font-black uppercase tracking-widest">{m.theme}</span>
              <button onClick={() => onDelete(m.id)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100"><Trash2 className="w-4 h-4" /></button>
            </div>
            <p className="text-slate-700 leading-loose font-serif italic text-lg mb-6">"{m.content}"</p>
            <div className="flex items-center justify-between text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <span>来源: {m.source_title}</span>
              <span>{formatDay(m.created_at)}</span>
            </div>
          </motion.div>
        )) : (
          <div className="col-span-full py-24 text-center opacity-30">
            <Bookmark className="w-20 h-20 text-slate-300 mx-auto mb-4" />
            <p className="text-base text-slate-400 font-black">暂无收藏素材，快去 AI 升格范文中看看吧</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [view, setView] = useState<'teacher' | 'student' | 'admin' | 'materials'>('teacher');
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isPwdModalOpen, setIsPwdModalOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiPrescription, setAiPrescription] = useState<string | null>(null);
  // 学情分析这一趟是不是**失败**收场的。
  // ⚠️ 以前是拿 `aiPrescription.includes("失败")` 现算的 —— 那是个全文匹配：
  //    报告正文里只要正常出现"失败"二字（比如老师常看到的"失分/失败原因分析"），
  //    「开始专项练习」就会被**永久**禁用（按钮变灰且不给任何提示）。
  //    2026-10-10 本地实测确认了这个机制，所以改成由 catch 分支显式置位。
  const [analysisFailed, setAnalysisFailed] = useState(false);
  // 「开始专项练习」需要一份学习处方才出得了题。没处方时点了会被引导到这里，
  // 把处方卡高亮一下，让老师一眼看到该点哪儿。
  const [rxNudge, setRxNudge] = useState(false);
  // ── 「边生成边显示」（2026-10-10）────────────────────────────
  // 免费模型只有 30～45 字/秒，长文（学情分析 / 专项练习 / 升格范文）等它一次吐完
  // 要 30～60 秒，还顶着平台单请求上限。改成流式后文字一点点出来，等待感基本消失。
  // streamChars 只用于"JSON 类输出"（题目、评分报告）—— 那些正文没法直接看，
  // 就显示"已生成 xxx 字"让老师知道确实在跑。
  const [streamChars, setStreamChars] = useState(0);
  // thinkingChars：模型正在「思考」时累计的字数。
  // 实测推理型模型会先思考十几秒到几十秒才写第一个正文字 ——
  // 那段时间如果不给个动静，界面看起来就是"卡住了"。
  const [thinkingChars, setThinkingChars] = useState(0);
  const [activeAction, setActiveAction] = useState<'practice' | 'essay' | 'graph' | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [actionContent, setActionContent] = useState<string | null>(null);
  const [goldenSentences, setGoldenSentences] = useState<{ content: string; theme: string }[]>([]);
  const [practiceData, setPracticeData] = useState<PracticeData | null>(null);
  const [scoreHistory, setScoreHistory] = useState<ScoreHistory[]>([]);
  const [materials, setMaterials] = useState<WritingMaterial[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [essayTitle, setEssayTitle] = useState('');
  const [essayImages, setEssayImages] = useState<string[]>([]);
  const [isAnalyzingEssay, setIsAnalyzingEssay] = useState(false);
  // ── 作文批阅拆成两步（2026-10-10）──────────────────────────────
  // ① 扫描识别文字（只认字）→ ② 老师核对后批阅（只评分）。
  // 原来是一次调用里让视觉模型"边认字边评分"：输出量大所以慢，而且认错字
  // 老师看不见、评分就跟着错。拆开后中间多一道人工核对。
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [ocrHandwriting, setOcrHandwriting] = useState('');
  const [ocrWarning, setOcrWarning] = useState('');
  const [ocrModel, setOcrModel] = useState('');
  const [essayAnalysis, setEssayAnalysis] = useState<WritingRecord | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<WritingRecord[]>([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isTTSLoading, setIsTTSLoading] = useState(false);
  const [preGeneratedAudio, setPreGeneratedAudio] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 服务端语音合成（Gemini）确认不可用时置位。置位后本次会话不再去请求它 ——
  // 免得每点一次朗读就白跑一个必然失败的请求（老师看到控制台一片红会以为程序坏了）。
  const serverTtsOffRef = useRef(false);
  // 老师按「停止朗读」时置位，用来把"用户主动停"和"真报错"区分开：
  // 主动停止时语音引擎也会回调 onerror('interrupted')，那不算失败。
  const ttsStopRef = useRef(false);

  // 启动时校验本地登录态：令牌有效才认，并且身份以服务端返回的为准。
  // 只看 localStorage 是不算数的——那里面用户能自己改。
  useEffect(() => {
    // 任何请求遇到 401 都会走到这里：清掉本地状态，退回登录页
    setUnauthorizedHandler(() => {
      setUser(null);
      setView('teacher');
    });

    const applyUser = (userData: any) => {
      setUser(userData);
      if (userData.role === 'student') {
        setView('student');
        setSelectedStudentId(userData.studentId || userData.uid);
      } else if (userData.role === 'admin') {
        setView('admin');
      } else {
        setView('teacher');
      }
    };

    (async () => {
      if (!getToken()) {
        // 老版本登录过、本地只有 user 没有令牌的情况：残留一律清掉
        if (getStoredUser()) clearSession();
        setAuthLoading(false);
        return;
      }
      try {
        const res = await apiFetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          if (data?.user) applyUser(data.user);
        } else {
          clearSession();
        }
      } catch (e) {
        // 401：apiFetch 已经清掉本地状态；网络异常：先用本地缓存的身份顶一下
        const cached = getStoredUser();
        if (cached) applyUser(cached);
      } finally {
        setAuthLoading(false);
      }
    })();

    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!user || user.role === 'admin') return;

    // 拿哪个范围的数据由服务端按令牌判定：
    // 教师 → 自己名下的班级；学生 → 只有自己那一条。前端不再传身份参数。
    apiFetch('/api/students')
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        if (!Array.isArray(data)) return;
        const mapped = data.map((s: any) => ({
          dbId: s.id,
          id: s.student_id || 'N/A',
          name: s.name,
          choice: s.choice || 0,
          modernReading: s.modern_reading || 0,
          classicReading: s.classic_reading || 0,
          nonLinear: s.non_linear || 0,
          dictation: s.dictation || 0,
          composition: s.composition || 0,
          total: s.total || 0,
          teacher_id: s.teacher_id,
        }));

        if (user.role === 'student') {
          setStudents(mapped.length > 0 ? [mapped[0]] : []);
          if (mapped.length > 0) setSelectedStudentId(mapped[0].id);
        } else {
          setStudents(mapped);
        }
      })
      .catch(() => setStudents([]));
  }, [user]);

  useEffect(() => {
    if (selectedStudentId && user?.uid) {
      setAiPrescription(null);
      setActionContent(null);
      setEssayAnalysis(null);
      setEssayTitle('');
      setEssayImages([]);
      // 换学生就清掉上一位的识别结果 —— 否则文字留着，容易把 A 的作文批到 B 名下
      setOcrText('');
      setOcrHandwriting('');
      setOcrWarning('');
      setOcrModel('');
      setPreGeneratedAudio(null);
      if (isPlayingAudio && audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
        setIsPlayingAudio(false);
      }

      if (user.role === 'teacher') {
        fetchAnalysisHistory(selectedStudentId, user.uid);
        fetchScoreHistory(selectedStudentId);
        fetchMaterials(selectedStudentId);
      } else {
        // 学生的可见范围由服务端把关（只能是自己），这里不必再看 teacher_id——
        // 否则名单里缺 teacher_id 的学生会什么都加载不出来
        fetchAnalysisHistory(selectedStudentId);
        fetchScoreHistory(selectedStudentId);
        fetchMaterials(selectedStudentId);
      }
    }
  }, [selectedStudentId, user, students]);

  const fetchAnalysisHistory = async (studentId: string, _teacherId?: string) => {
    if (!studentId) return;
    try {
      // teacherId 不用再传：服务端按令牌里的身份决定能看到哪些记录
      const res = await apiFetch(`/api/history?studentId=${encodeURIComponent(studentId)}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setAnalysisHistory(data);
      }
    } catch (err) { console.error(err); }
  };

  const fetchScoreHistory = async (studentId: string) => {
    try {
      const res = await apiFetch(`/api/students?student_id=${encodeURIComponent(studentId)}&history=true`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setScoreHistory(data);
      }
    } catch (err) { console.error(err); }
  };

  const fetchMaterials = async (studentId: string) => {
    try {
      const res = await apiFetch(`/api/materials?student_id=${encodeURIComponent(studentId)}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setMaterials(data);
      }
    } catch (err) { console.error(err); }
  };

  const saveMaterial = async (content: string, theme: string, sourceTitle: string) => {
    if (!selectedStudentId) return;
    try {
      const res = await apiFetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_id: selectedStudentId,
          content,
          theme,
          source_title: sourceTitle
        })
      });
      if (res.ok) {
        fetchMaterials(selectedStudentId);
        alert("收藏成功！已存入素材库。");
      }
    } catch (err) { console.error(err); }
  };

  const deleteMaterial = async (id: number) => {
    try {
      // 归属校验交给服务端（它按数据库里的记录判定），前端不再自己声明 student_id
      const res = await apiFetch(`/api/materials?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        setMaterials(prev => prev.filter(m => m.id !== id));
      }
    } catch (err) { console.error(err); }
  };

  const exportToPDF = async (elementId: string, filename: string) => {
    const element = document.getElementById(elementId);
    if (!element) {
      alert("没有找到要导出的内容，请稍后重试");
      return;
    }

    try {
      // 浏览器单张画布有大小上限，报告很长时降为 1 倍分辨率，避免截出空白图
      const scale = element.scrollHeight * 2 > 16000 ? 1 : 2;
      const canvas = await html2canvas(element, { scale, backgroundColor: '#ffffff' });
      const imgData = canvas.toDataURL('image/png');

      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgProps = pdf.getImageProperties(imgData);
      const imgHeight = (imgProps.height * pageWidth) / imgProps.width;

      // 按 A4 高度切成多页：否则整份报告只会输出一页，后面的内容直接丢掉
      let heightLeft = imgHeight;
      let position = 0;
      pdf.addImage(imgData, 'PNG', 0, position, pageWidth, imgHeight);
      heightLeft -= pageHeight;
      while (heightLeft > 0) {
        position -= pageHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, pageWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      pdf.save(filename);
    } catch (err) {
      console.error("PDF Export Error:", err);
      alert("导出 PDF 失败，请重试");
    }
  };

  const handleLogout = () => {
    // 先在服务端把这条会话作废。只清浏览器本地是没用的——
    // 令牌在有效期内仍然能调用接口，必须让服务端也把它删掉。
    apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearSession();
    setUser(null);
    setStudents([]);
    setView('teacher');
  };

  const handleSaveStudent = async (student: Student) => {
    const sid = (student.id || '').trim();
    const sname = (student.name || '').trim();
    if (!sid || !sname) {
      alert("请填写学号和姓名");
      return;
    }
    try {
      const res = await apiFetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 归属教师由服务端按令牌写入，不再由前端声明 teacher_id
        body: JSON.stringify({
          students: [{ ...student, id: sid, name: sname }]
        })
      });
      if (res.ok) {
        const saved: any = await res.json().catch(() => ({}));
        const r = await apiFetch('/api/students');
        const data = await r.json();
        if (Array.isArray(data)) {
          setStudents(data.map((s: any) => ({
            dbId: s.id,
            id: s.student_id || 'N/A',
            name: s.name,
            choice: s.choice || 0,
            modernReading: s.modern_reading || 0,
            classicReading: s.classic_reading || 0,
            nonLinear: s.non_linear || 0,
            dictation: s.dictation || 0,
            composition: s.composition || 0,
            total: s.total || 0
          })));

        }
        setIsEditModalOpen(false);
        setEditingStudent(null);
        // 值没变时服务端不会写历史，如实告诉老师，避免她以为白点了
        if (saved && saved.unchanged && !saved.updated && !saved.inserted) {
          alert("成绩与原来一致，未产生新的记录。");
        }
      } else {
        const errData = await res.json().catch(() => ({ error: '服务器错误' }));
        alert(`保存失败：${errData.error || '请稍后重试'}`);
      }
    } catch (err) {
      console.error(err);
      alert("网络错误，保存失败");
    }
  };

  const handleDeleteStudent = async (dbId: number) => {
    if (window.confirm('确定要删除该学生成绩吗？此操作不可撤销。')) {
      try {
        const res = await apiFetch(`/api/students?id=${dbId}`, {
          method: 'DELETE'
        });
        if (res.ok) {
          setStudents(prev => prev.filter(s => s.dbId !== dbId));
        } else {
          const errData = await res.json().catch(() => ({ error: '未知错误' }));
          alert(`删除失败: ${errData.error || '服务器错误'}`);
        }
      } catch (err) {
        console.error(err);
        alert("网络错误，删除失败");
      }
    }
  };

  /**
   * 把选中的图片压缩后再上传。
   *
   * 原先的写法是把手机原图（常见 3～8MB）直接转成 base64 传上去，服务端要解析
   * 这么大的表单、再拼一个几 MB 的请求体转发给 AI。而 Cloudflare 免费版给单个
   * 请求的 CPU 时间只有 10 毫秒 —— 处理这么大的字符串很容易超限，请求会被平台
   * 直接掐断，前端只能看到一个没有原因的失败（"阅卷失败 (服务器错误)"）。
   *
   * 压到长边 1600px / JPEG 0.82 后通常只剩 200～500KB，读手写作文完全够用。
   */
  const compressImage = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('无法处理这张图片')); return; }
        // 先铺白底：作文多是白纸，而 JPEG 不支持透明（透明区域会变黑）
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });

  // 图片上传：最多 2 张（与后端一致），且**先压缩再进 state**
  const handleEssayImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    e.target.value = ''; // 清空，方便连续选同一张图
    for (const file of files) {
      let dataUrl = '';
      try {
        dataUrl = await compressImage(file);
      } catch {
        // 压缩失败就退回原图 —— 至少别让老师传不上去
        dataUrl = await new Promise<string>((res) => {
          const r = new FileReader();
          r.onload = (ev) => res(String(ev.target?.result || ''));
          r.readAsDataURL(file);
        });
      }
      if (!dataUrl) continue;
      // 在 setState 里再判一次上限：state 是异步的，外面读到的 length 可能是旧值
      setEssayImages(prev => (prev.length >= 2 ? prev : [...prev, dataUrl]));
    }
    // 换了图，上一次的识别结果就作废了 —— 否则老师可能拿着旧文字去批阅新照片
    setOcrText('');
    setOcrHandwriting('');
    setOcrWarning('');
    setOcrModel('');
  };

  const selectedStudent = students.find(s => s.id === selectedStudentId) || students[0] || {
    id: 'N/A', name: '未选择', choice: 0, modernReading: 0, classicReading: 0, nonLinear: 0, dictation: 0, composition: 0, total: 0
  };

  // 「开始专项练习」出题要拿处方里的薄弱点当依据，所以先得有处方。
  // ⚠️ 判据是「有正文且不是失败收场」，**不再**对正文做 "失败" 关键词匹配 ——
  //    见 analysisFailed 的注释。
  const hasPrescription = !!aiPrescription && aiPrescription.trim().length > 0 && !analysisFailed;

  /** 把页面滚到「智能学习处方」卡并闪一下 —— 老师点错了地方时，直接告诉他该点哪儿。 */
  const nudgeToPrescription = () => {
    try {
      document.getElementById('ai-prescription-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) { /* 滚动失败不影响主流程 */ }
    setRxNudge(true);
    window.setTimeout(() => setRxNudge(false), 2200);
  };

  const generateAIAnalysis = async (student: Student) => {
    setIsGenerating(true);
    setStreamChars(0);
    setThinkingChars(0);
    setAnalysisFailed(false);
    // 先置空串而不是 null：置空后界面立刻切到"正在显示"分支，
    // 第一个字一到就能渲染，不会再多一次状态切换。
    setAiPrescription('');
    try {
      await apiStream(
        '/api/analyze_student?stream=1',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student }),
        },
        {
          // 报告是 Markdown，边到边渲染 —— 老师能看到它是"写"出来的，不是卡住了
          onDelta: (full) => {
            setAiPrescription(full);
            setStreamChars(full.length);
          },
          onThinking: (n) => setThinkingChars(n),
          // 收尾时以服务端给的最终正文为准：它会顺手剥掉个别模型混进来的"思考过程"
          onDone: (payload) => {
            if (typeof payload?.text === 'string' && payload.text.trim()) {
              setAiPrescription(payload.text);
            }
          },
        }
      );
    } catch (err: any) {
      console.error('AI Analysis Error:', err);
      setAnalysisFailed(true);
      setAiPrescription('分析失败: ' + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  // ── 第一步：只认字 ────────────────────────────────────────────
  // 抽出来单独一步，是为了让老师**看见**模型认成了什么。手写作文认错字是常态，
  // 以前认错字评分跟着错、老师还看不出来；现在原文摊在眼前，顺手就能改。
  const recognizeEssay = async () => {
    if (!essayTitle.trim() || essayImages.length === 0) return;
    setIsOcrRunning(true);
    setOcrWarning('');
    try {
      const formData = new FormData();
      formData.append('title', essayTitle);
      formData.append('studentId', selectedStudent.id || 'N/A');
      formData.append('images', JSON.stringify(essayImages));

      const res = await apiFetch('/api/essay_ocr', { method: 'POST', body: formData });

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        let msg = '';
        try {
          msg = String(JSON.parse(raw)?.error || '');
        } catch {
          msg = raw.trim().startsWith('<')
            ? `请求被服务器中途中断（HTTP ${res.status}）—— 多半是图片过大或处理超时，换张小一点的图再试`
            : '';
        }
        throw new Error(msg || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setOcrText(String(data.text || ''));
      setOcrHandwriting(String(data.handwriting || ''));
      setOcrModel(String(data.model || ''));
      setOcrWarning(String(data.warning || ''));
      // 新识别出来的文字，之前的报告就过期了
      setEssayAnalysis(null);
    } catch (err: any) {
      console.error('Essay OCR Error:', err);
      alert('识别失败: ' + err.message);
    } finally {
      setIsOcrRunning(false);
    }
  };

  // ── 第二步：只评分 ────────────────────────────────────────────
  // 提交的是**老师核对过的文字**，不再传图。这一步走文本链：候选更多、更快。
  const analyzeEssay = async () => {
    if (!essayTitle.trim() || !ocrText.trim()) return;
    setIsAnalyzingEssay(true);
    setStreamChars(0);
    setThinkingChars(0);
    try {
      // 只告诉服务端"要批阅哪个学生"；批阅人是谁、记录归谁，由服务端按令牌决定
      const formData = new FormData();
      formData.append('title', essayTitle);
      formData.append('studentId', selectedStudent.id || 'N/A');
      formData.append('text', ocrText);
      formData.append('handwriting', ocrHandwriting);

      await apiStream(
        '/api/analyze_essay?stream=1',
        { method: 'POST', body: formData },
        {
          // 评分报告是 JSON，直接显示没意义 —— 只算进度。
          // 但流式在这里仍有两个实打实的好处：
          //   ① 请求全程在传字节，不再"上游闷头算 14 秒"，不容易被平台掐断；
          //   ② 老师能看出确实在跑，而不是怀疑卡死了。
          onDelta: (full) => setStreamChars(full.length),
          onThinking: (n) => setThinkingChars(n),
          onDone: (payload) => {
            const record = payload?.result;
            if (!record) return;
            setEssayAnalysis(record);
            setAnalysisHistory(prev => [record, ...prev]);
          },
        }
      );
      // ⚠️ 这里**不再清空图片和原文**：批阅失败或想重批时，不用重新拍照、重新识别。
      //    要开始下一篇，老师自己删掉图片即可（删图会自动清掉识别结果）。
    } catch (err: any) {
      console.error("Essay Analysis Error:", err);
      alert("批阅失败: " + err.message);
    }
    finally { setIsAnalyzingEssay(false); }
  };

  /**
   * 把升格输出拆成「范文 / 亮点解析 / 金句」，并顺手预生成朗读音频。
   *
   * 抽出来是因为它现在有两个调用时机：流式结束后拿最终正文调一次（正式结果），
   * 而流中间显示的是**原始文本**（带【升格范文】这类标记）—— 那是给老师看
   * "确实在写"，不是最终结果。所以解析只在收尾做一次。
   */
  const applyUpgradedEssay = (text: string) => {
    const essayMatch = text.match(/【升格范文】([\s\S]*?)(?=【金句推荐】|【亮点解析】|$)/);
    const goldenMatch = text.match(/【金句推荐】([\s\S]*?)(?=【亮点解析】|【升格范文】|$)/);
    const analysisMatch = text.match(/【亮点解析】([\s\S]*?)(?=【金句推荐】|【升格范文】|$)/);

    const essayContent = essayMatch ? essayMatch[1].trim() : "";
    const analysisContent = analysisMatch ? analysisMatch[1].trim() : "";
    const goldenSection = goldenMatch ? goldenMatch[1].trim() : "";

    let displayContent = "";
    if (essayContent) displayContent += `### 升格范文\n\n${essayContent}\n\n`;
    if (analysisContent) displayContent += `### 亮点解析\n\n${analysisContent}`;

    if (!displayContent) displayContent = text;

    let sentences: { content: string; theme: string }[] = [];
    if (goldenSection) {
      sentences = goldenSection.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
          const match = line.match(/^[-*•\d.]*\s*(.*?)\s*[|:：]\s*(.*)$/);
          if (match) {
            return { content: match[1].trim(), theme: match[2].trim() };
          }
          const simpleMatch = line.match(/^[-*•\d.]*\s*(.*)$/);
          if (simpleMatch && simpleMatch[1].trim()) {
            return { content: simpleMatch[1].trim(), theme: '其他' };
          }
          return null;
        })
        .filter((s): s is { content: string; theme: string } => s !== null);
    }

    setGoldenSentences(sentences);
    setActionContent(displayContent);
    if (essayContent) preGenerateTTS(essayContent);
  };

  const fetchUpgradedEssay = async () => {
    if (!essayAnalysis) {
      alert("请先提交作文并完成深度诊断，再查看范文升格。");
      return;
    }
    setIsActionLoading(true);
    setActiveAction('essay');
    setPreGeneratedAudio(null);
    setGoldenSentences([]);
    setStreamChars(0);
    setThinkingChars(0);
    setActionContent(''); // 立刻切到"流式显示"分支
    try {
      await apiStream(
        '/api/upgrade_essay?stream=1',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 优先送**作文原文**。原来送的是"分析全文"（含标题、评分、评语、建议），
          // 等于让模型对着一堆评语去升格作文，出来的范文自然不对味。
          body: JSON.stringify({
            title: essayAnalysis.title,
            content: essayAnalysis.essay_text || essayAnalysis.analysis
          })
        },
        {
          // 升格范文 2000～2800 字，是四个功能里最长的 —— 一次吐完要 50 秒以上，
          // 早就超过平台单请求上限。流式下第一句话 1～2 秒就出现。
          onDelta: (full) => {
            setActionContent(full);
            setStreamChars(full.length);
          },
          onThinking: (n) => setThinkingChars(n),
          onDone: (payload) => {
            const text = typeof payload?.text === 'string' ? payload.text : '';
            if (text.trim()) applyUpgradedEssay(text);
          },
        }
      );
    } catch (err: any) {
      console.error("Upgrade Essay Error:", err);
      setActionContent("生成失败: " + err.message);
    }
    finally { setIsActionLoading(false); }
  };

  const fetchPractice = async () => {
    if (!hasPrescription) {
      // ⚠️ 这里以前是 `alert(...); return;`，但按钮同时被 `disabled` 挡着 ——
      //    禁用的按钮根本不会触发 onClick，所以老师看到的是「点了完全没反应」，
      //    连这句提示都弹不出来（2026-10-10 本地实测确认）。
      //    现在按钮不再禁用，改成"点了就明确告诉你下一步做什么"。
      alert(
        analysisFailed
          ? "上一次学情分析没有成功，先重新点「生成处方」拿到有效的学习处方，再开始专项练习。"
          : "专项练习是按这个学生的薄弱点出题的，得先有一份学习处方。\n\n" +
            "请点上方「智能学习处方」卡右上角的『生成处方』，生成完再回来点这里。"
      );
      nudgeToPrescription();
      return;
    }
    setIsActionLoading(true);
    setActiveAction('practice');
    setPracticeData(null);
    setStreamChars(0);
    setThinkingChars(0);
    try {
      await apiStream(
        '/api/generate_practice?stream=1',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student: selectedStudent })
        },
        {
          // ⚠️ 这个接口产出的是 JSON（题目＋选项＋解析），把原始 JSON 直接显示出来
          //    对老师毫无意义。所以这里**只拿增量算进度**，让老师看出"确实在生成"，
          //    真正的题目等收尾解析完再渲染。
          onDelta: (full) => setStreamChars(full.length),
          onThinking: (n) => setThinkingChars(n),
          onDone: (payload) => {
            if (payload?.result) setPracticeData(payload.result);
          },
        }
      );
    } catch (err: any) {
      console.error("Generate Practice Error:", err);
      alert("生成失败: " + err.message);
    }
    finally { setIsActionLoading(false); }
  };

  // ✅ 预生成 TTS 音频（升格范文）
  const preGenerateTTS = async (text: string) => {
    const textToRead = extractEssayText(text).substring(0, 2000);

    try {
      const res = await apiFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToRead })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.audio) {
          setPreGeneratedAudio(data.audio);
        } else if (data.configured === false) {
          // 服务端没配语音合成 —— 记下来，点「朗读范文」时直接走本机朗读
          serverTtsOffRef.current = true;
        }
      } else {
        serverTtsOffRef.current = true;
      }
    } catch (err) {
      console.error("语音预生成失败:", err);
    }
  };

  /**
   * 本机朗读（主力方案）。三处关键点，逐条都是实测踩出来的：
   *   ① 显式挑**本地**中文语音 —— 不指定 voice 时 Chrome 可能选中「Google 普通话」，
   *      那是联网语音，国内网络下不报错也不出声（静默失败）；
   *   ② cancel() 之后要让出一次事件循环再 speak()，否则这次朗读会被整个吞掉；
   *   ③ 长文按句切块排队 —— 整篇塞进一条 utterance 会被 Chrome 中途掐断。
   * 失败时抛带中文说明的错误，由调用方弹给老师（不再静默）。
   */
  const speakWithBrowser = async (text: string) => {
    const ss = typeof window !== 'undefined' ? window.speechSynthesis : null;
    if (!ss) throw new Error('这个浏览器不支持语音朗读，建议改用 Chrome 或 Edge');

    await waitForVoices();
    const voice = pickChineseVoice();

    ss.cancel();
    await new Promise(r => setTimeout(r, 120)); // 见 ②
    ttsStopRef.current = false;

    const chunks = chunkForSpeech(text);
    setIsPlayingAudio(true);

    // Chrome 的长朗读会在十几秒后自己"睡着"（paused=true 但不结束）。
    // 我们这只按钮是「停止朗读」、没有暂停功能，所以只要发现它自己睡着了就唤醒。
    const watchdog = window.setInterval(() => {
      if (!ttsStopRef.current && ss.speaking && ss.paused) ss.resume();
    }, 4000);

    try {
      await new Promise<void>((resolve, reject) => {
        let i = 0;
        const next = () => {
          if (ttsStopRef.current || i >= chunks.length) return resolve();
          const u = new SpeechSynthesisUtterance(chunks[i++]);
          u.lang = 'zh-CN';
          u.rate = 0.95;
          u.pitch = 1.0;
          if (voice) u.voice = voice;
          u.onend = next;
          u.onerror = (e: any) => {
            const code = e?.error || 'unknown';
            // 老师主动按「停止朗读」时也会回调 onerror('interrupted')，那不算失败
            if (ttsStopRef.current || code === 'interrupted' || code === 'canceled') return resolve();
            reject(new Error(speechErrorMessage(code)));
          };
          ss.speak(u);
        };
        next();
      });
    } finally {
      window.clearInterval(watchdog);
      setIsPlayingAudio(false);
    }
  };

  const playTTS = async (text: string, skipExtract = false) => {
    // 正在朗读 → 再点一次是「停止」
    if (isPlayingAudio) {
      ttsStopRef.current = true;
      if (audioRef.current) { try { audioRef.current.pause(); } catch (_) {} audioRef.current = null; }
      window.speechSynthesis?.cancel();
      setIsPlayingAudio(false);
      return;
    }

    if (preGeneratedAudio) {
      playAudioFromBase64(preGeneratedAudio);
      return;
    }

    setIsTTSLoading(true);
    let textToRead = text;

    if (!skipExtract) {
      textToRead = extractEssayText(text);
    }

    textToRead = textToRead.replace(/[#*`]/g, '').trim().substring(0, 2000);

    try {
      // ① 服务端语音（配了 GEMINI_API_KEY 才有，音色更好）。
      //    没配就安静地跳过 —— 不再每次都发一个必然失败的请求，
      //    也不再往控制台刷红色报错让老师以为程序坏了。
      if (!serverTtsOffRef.current) {
        try {
          const res = await apiFetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textToRead })
          });
          const data = await res.json().catch(() => null);
          if (data?.audio) {
            playAudioFromBase64(data.audio);
            return;
          }
          if (data?.configured === false) serverTtsOffRef.current = true;
          if (!res.ok) serverTtsOffRef.current = true;
        } catch (err: any) {
          // 网络层失败：记下来，本次会话不再重试，直接走本机朗读
          console.info("服务端语音不可用，改用本机朗读:", err?.message || err);
          serverTtsOffRef.current = true;
        }
      }

      // ② 本机朗读兜底（主力）
      await speakWithBrowser(textToRead);
    } catch (err: any) {
      // ⚠️ 这里必须报出来。原来的降级是**静默失败** —— 语音引擎报错只写进 console，
      //    老师点了按钮、没声音、也没提示，只知道"朗读范文不行"。
      alert(`朗读失败：${err?.message || err}\n\n提示：可在系统「设置 → 时间和语言 → 语音」里确认已安装中文语音包。`);
    } finally {
      setIsTTSLoading(false);
    }
  };

  // ✅ 使用 AudioContext 解码播放（替代手动 WAV 头）
  const playAudioFromBase64 = (base64: string) => {
    try {
      const binaryString = window.atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // 尝试直接作为 WAV 播放
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onplay = () => setIsPlayingAudio(true);
      audio.onerror = (e) => {
        console.error("Audio playback error:", e);
        setIsPlayingAudio(false);
        setIsTTSLoading(false);
        // 如果 WAV 失败，尝试用 AudioContext 解码
        fallbackPlayWithAudioContext(bytes);
      };
      audio.onended = () => {
        setIsPlayingAudio(false);
        audioRef.current = null;
        URL.revokeObjectURL(url);
      };
      audio.play().catch(err => {
        console.error("Play error:", err);
        setIsPlayingAudio(false);
        setIsTTSLoading(false);
        fallbackPlayWithAudioContext(bytes);
      });
    } catch (err) {
      console.error("Base64 decode error:", err);
      alert("音频数据解析失败");
      setIsTTSLoading(false);
    }
  };

  // ✅ 降级：用 AudioContext 播放 PCM 数据
  const fallbackPlayWithAudioContext = async (pcmBytes: Uint8Array) => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const audioBuffer = audioCtx.createBuffer(1, pcmBytes.length / 2, 24000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < channelData.length; i++) {
        const low = pcmBytes[i * 2];
        const high = pcmBytes[i * 2 + 1];
        channelData[i] = (high << 8 | low) / 32768;
      }
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.onended = () => {
        setIsPlayingAudio(false);
        audioCtx.close();
      };
      source.start();
      setIsPlayingAudio(true);
    } catch (err) {
      console.error("AudioContext fallback failed:", err);
      setIsPlayingAudio(false);
    }
  };

  const downloadTemplate = () => {
    // 表头写上各项满分，老师填的时候心里有数。
    // 导入是按表头名字找列的，所以列的顺序可以随便调，
    // 也不存在"删掉某一列导致后面整行分数错位"的问题。
    const data = [
      ["学号", "姓名", "选择题(25)", "现代文阅读(35)", "文言文阅读(20)", "非连续性文本（并入现代文，可留空）", "默写填空(10)", "作文(60)"],
      ["2026001", "张三", 20, 20, 15, 8, 8, 42],
      ["2026002", "李四", 18, 18, 12, 7, 9, 38]
    ];

    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "成绩模板");

    XLSX.writeFile(wb, "智语系统_成绩导入模板.xlsx");
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = new Uint8Array(event.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

        // 按「表头名字」找列，而不是认第几列。
        // 原来按位置取值，老师一旦删掉或调换某一列，后面的分数会整列错位
        // （比如默写的分数被记到作文上），而且不会报任何错。
        const header = (jsonData[0] || []).map((v) => String(v ?? '').trim());
        const findCol = (...names: string[]): number => {
          for (const n of names) {
            const exact = header.findIndex((h) => h === n);
            if (exact >= 0) return exact;
          }
          for (const n of names) {
            const loose = header.findIndex((h) => h.includes(n));
            if (loose >= 0) return loose;
          }
          return -1;
        };
        const COL = {
          id: findCol('学号'),
          name: findCol('姓名'),
          choice: findCol('选择题'),
          modern: findCol('现代文阅读', '现代文'),
          classic: findCol('文言文阅读', '文言文'),
          nonLinear: findCol('非连续性文本', '非连续性'),
          dictation: findCol('默写填空', '默写'),
          composition: findCol('作文'),
        };
        // 万一表头认不出来（例如老师手写的 CSV 没有表头），退回按原来的列顺序解析
        if (COL.id < 0 || COL.name < 0) {
          COL.id = 0; COL.name = 1; COL.choice = 2; COL.modern = 3;
          COL.classic = 4; COL.nonLinear = 5; COL.dictation = 6; COL.composition = 7;
        }

        const rows = jsonData.slice(1);
        const newStudents = rows.map(row => {
          if (!row || row.length < 2) return null;

          const cell = (i: number): string => (i >= 0 ? String(row[i] ?? '').trim() : '');
          const id = cell(COL.id);
          const name = cell(COL.name);
          if (!id || !name) return null;

          const s = {
            id,
            name,
            choice: parseInt(cell(COL.choice)) || 0,
            modernReading: parseInt(cell(COL.modern)) || 0,
            classicReading: parseInt(cell(COL.classic)) || 0,
            nonLinear: parseInt(cell(COL.nonLinear)) || 0,
            dictation: parseInt(cell(COL.dictation)) || 0,
            composition: parseInt(cell(COL.composition)) || 0,
            total: 0
          };
          s.total = s.choice + s.modernReading + s.classicReading + s.nonLinear + s.dictation + s.composition;
          return s;
        }).filter(Boolean) as Student[];

        if (newStudents.length > 0) {
          apiFetch('/api/students', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              students: newStudents
            })
          }).then(async res => {
            const saved: any = await res.json().catch(() => ({}));
            if (res.ok) {
              apiFetch('/api/students')
                .then(r => r.json())
                .then(data => {
                  if (Array.isArray(data)) {
                    setStudents(data.map((s: any) => ({
                      dbId: s.id,
                      id: s.student_id || 'N/A',
                      name: s.name,
                      choice: s.choice || 0,
                      modernReading: s.modern_reading || 0,
                      classicReading: s.classic_reading || 0,
                      nonLinear: s.non_linear || 0,
                      dictation: s.dictation || 0,
                      composition: s.composition || 0,
                      total: s.total || 0
                    })));
                  }
                });
              // 按服务端返回的实际结果提示：重复导入同一份表格时，
              // 值没变的不会写历史，这里如实说"无变化 N 条"，老师才不会被误导
              const parts: string[] = [];
              if (saved.inserted) parts.push(`新增 ${saved.inserted} 条`);
              if (saved.updated) parts.push(`更新 ${saved.updated} 条`);
              if (saved.unchanged) parts.push(`无变化 ${saved.unchanged} 条`);
              alert(`导入完成：${parts.length ? parts.join('，') : '没有需要写入的数据'}。`);
            } else {
              alert(`导入失败: ${saved.error || '服务器错误，请检查网络或联系管理员'}`);
            }
          }).catch(err => {
            console.error("Upload error:", err);
            alert("网络连接失败，请检查您的网络设置。");
          });
        } else {
          alert("未发现有效数据，请检查模板格式。");
        }
      } catch (err) {
        console.error("Import error:", err);
        alert("文件解析失败，请确保使用标准的 Excel 或 CSV 模板。");
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const classStats = {
    avg: students.length ? Math.round(students.reduce((acc, s) => acc + s.total, 0) / students.length) : 0,
    passRate: students.length ? Math.round((students.filter(s => s.total >= 90).length / students.length) * 100) : 0,
    excellentRate: students.length ? Math.round((students.filter(s => s.total >= 120).length / students.length) * 100) : 0,
    attentionCount: students.filter(s => s.total < 90).length
  };

  const getScoreDistribution = () => {
    const ranges = [
      { range: '130+', min: 130, max: TOTAL_MAX + 1 },
      { range: '120-130', min: 120, max: 130 },
      { range: '110-120', min: 110, max: 120 },
      { range: '100-110', min: 100, max: 110 },
      { range: '90-100', min: 90, max: 100 },
      { range: '<90', min: 0, max: 90 }
    ];
    return ranges.map(r => ({
      range: r.range,
      count: students.filter(s => s.total >= r.min && s.total < r.max).length
    }));
  };

  const getTypePerformance = () => {
    if (!students.length) return [];
    return SCORE_ITEMS.map(t => {
      const avg = students.reduce((acc, s) => acc + t.get(s), 0) / students.length;
      const rate = Math.round((avg / t.max) * 100);
      let color = 'bg-indigo-500';
      if (rate >= 85) color = 'bg-emerald-500';
      else if (rate >= 75) color = 'bg-emerald-400';
      else if (rate >= 60) color = 'bg-amber-500';
      else color = 'bg-rose-500';
      return { label: t.label, val: rate, color };
    }).sort((a, b) => b.val - a.val);
  };

  const getLiteracyData = (s: Student) => [
    { subject: '语言建构', value: Math.round(((s.choice + s.dictation) / LITERACY_MAX.language) * 100) || 0 },
    { subject: '思维发展', value: Math.round((modernReadingTotal(s) / LITERACY_MAX.thinking) * 100) || 0 },
    { subject: '审美鉴赏', value: Math.round((s.composition / LITERACY_MAX.aesthetics) * 100) || 0 },
    { subject: '文化传承', value: Math.round((s.classicReading / LITERACY_MAX.culture) * 100) || 0 },
    { subject: '表达创作', value: Math.round(((s.composition + modernReadingTotal(s)) / LITERACY_MAX.expression) * 100) || 0 },
  ];

  const filteredStudents = students.filter(s => s.name.includes(searchTerm) || s.id.includes(searchTerm));

  if (authLoading) return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-4">
      <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
      <p className="text-slate-500 font-medium animate-pulse">正在加载智语系统...</p>
    </div>
  );

  if (!user) return <Auth onAuthSuccess={(userData) => {
    // 令牌已在 Auth 组件里存好，这里只负责切换界面
    setUser(userData);
    if (userData.role === 'student') {
      setView('student');
      setSelectedStudentId(userData.studentId || userData.uid);
    } else if (userData.role === 'admin') setView('admin');
    else setView('teacher');
  }} />;

  if (view === 'admin') return <AdminDashboard onLogout={handleLogout} />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
      {/* Mobile Top Bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-white border-b border-slate-100 z-[60] flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center">
            <Sparkles className="text-white w-5 h-5" />
          </div>
          <span className="font-bold text-lg tracking-tight">智语 SmartLexis</span>
        </div>
        <button onClick={() => setIsSidebarOpen(true)} className="p-2 text-slate-500 hover:bg-slate-50 rounded-xl transition-all">
          <Menu className="w-6 h-6" />
        </button>
      </div>

      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] lg:hidden"
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 left-0 h-full w-72 bg-slate-900 text-white z-[80] flex flex-col p-8 lg:hidden"
            >
              <div className="flex items-center justify-between mb-12">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-indigo-500 rounded-xl flex items-center justify-center">
                    <Sparkles className="text-white w-6 h-6" />
                  </div>
                  <span className="font-bold text-lg">智语系统</span>
                </div>
                <button onClick={() => setIsSidebarOpen(false)} className="p-2 text-slate-400 hover:text-white"><X className="w-6 h-6" /></button>
              </div>
              <nav className="space-y-2 flex-1">
                {user?.role === 'teacher' && (
                  <button onClick={() => { setView('teacher'); setIsSidebarOpen(false); }} className={cn("w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold transition-all", view === 'teacher' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-slate-400 hover:bg-slate-800 hover:text-white")}>
                    <BarChart3 className="w-5 h-5" /> 班级看板
                  </button>
                )}
                <button onClick={() => { setView('student'); setIsSidebarOpen(false); }} className={cn("w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold transition-all", view === 'student' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-slate-400 hover:bg-slate-800 hover:text-white")}>
                  <Activity className="w-5 h-5" /> {user?.role === 'teacher' ? '学情诊断' : '我的诊断'}
                </button>
                <button onClick={() => { setView('materials'); setIsSidebarOpen(false); }} className={cn("w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold transition-all", view === 'materials' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-slate-400 hover:bg-slate-800 hover:text-white")}>
                  <Bookmark className="w-5 h-5" /> {user?.role === 'teacher' ? '学生素材库' : '我的素材库'}
                </button>
                {user?.role === 'teacher' && (
                  <>
                    <div className="pt-8 pb-3 px-5 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">数据中心</div>
                    <button onClick={downloadTemplate} className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold text-slate-400 hover:bg-slate-800 hover:text-white transition-all">
                      <Download className="w-5 h-5" /> 下载模板
                    </button>
                    <label className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold text-slate-400 hover:bg-slate-800 hover:text-white transition-all cursor-pointer">
                      <Upload className="w-5 h-5" /> 成绩导入
                      <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFileUpload} />
                    </label>
                  </>
                )}
              </nav>
              <div className="mt-auto p-5 bg-slate-800/50 rounded-[32px] border border-slate-700/50">
                <div className="flex items-center justify-between">
                  <div className="truncate mr-4">
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 font-black">{user?.role === 'teacher' ? '教师' : '学生'}</p>
                    <p className="text-sm font-bold truncate">{user?.name}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => { setIsPwdModalOpen(true); setIsSidebarOpen(false); }} title="修改密码" aria-label="修改密码" className="p-2.5 text-slate-400 hover:text-indigo-300 transition-colors"><KeyRound className="w-5 h-5" /></button>
                    <button onClick={handleLogout} title="退出登录" aria-label="退出登录" className="p-2.5 text-slate-400 hover:text-rose-400 transition-colors"><LogOut className="w-5 h-5" /></button>
                  </div>
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Desktop Sidebar */}
      <aside className="fixed top-0 left-0 h-full w-64 bg-slate-900 text-white hidden lg:flex flex-col p-8 z-50">
        <div className="flex items-center gap-4 mb-12 px-2">
          <div className="w-12 h-12 bg-indigo-500 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-500/20">
            <Sparkles className="text-white w-7 h-7" />
          </div>
          <span className="font-bold text-xl tracking-tight">智语·SmartLexis</span>
        </div>
        <nav className="space-y-3 flex-1">
          {user?.role === 'teacher' && (
            <button onClick={() => setView('teacher')} className={cn("w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold transition-all", view === 'teacher' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-slate-400 hover:bg-slate-800 hover:text-white")}>
              <BarChart3 className="w-5 h-5" /> 班级看板
            </button>
          )}
          <button onClick={() => setView('student')} className={cn("w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold transition-all", view === 'student' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-slate-400 hover:bg-slate-800 hover:text-white")}>
            <Activity className="w-5 h-5" /> {user?.role === 'teacher' ? '学情诊断' : '我的诊断'}
          </button>
          <button onClick={() => setView('materials')} className={cn("w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold transition-all", view === 'materials' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-slate-400 hover:bg-slate-800 hover:text-white")}>
            <Bookmark className="w-5 h-5" /> {user?.role === 'teacher' ? '学生素材库' : '我的素材库'}
          </button>
          {user?.role === 'teacher' && (
            <>
              <div className="pt-8 pb-3 px-5 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">数据中心</div>
              <button onClick={downloadTemplate} className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold text-slate-400 hover:bg-slate-800 hover:text-white transition-all">
                <Download className="w-5 h-5" /> 下载模板
              </button>
              <label className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-sm font-bold text-slate-400 hover:bg-slate-800 hover:text-white transition-all cursor-pointer">
                <Upload className="w-5 h-5" /> 成绩导入
                <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFileUpload} />
              </label>
            </>
          )}
        </nav>
        <div className="mt-auto p-5 bg-slate-800/50 rounded-[32px] border border-slate-700/50">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 font-black">{user?.role === 'teacher' ? '教师' : '学生'}</p>
              <p className="text-sm font-bold truncate max-w-[120px]">{user?.name}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => setIsPwdModalOpen(true)} title="修改密码" aria-label="修改密码" className="p-2.5 text-slate-400 hover:text-indigo-300 transition-colors"><KeyRound className="w-5 h-5" /></button>
              <button onClick={handleLogout} title="退出登录" aria-label="退出登录" className="p-2.5 text-slate-400 hover:text-rose-400 transition-colors"><LogOut className="w-5 h-5" /></button>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile Bottom Nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 h-20 bg-white border-t border-slate-100 z-50 flex items-center justify-around px-4 pb-2">
        {user?.role === 'teacher' && (
          <button onClick={() => setView('teacher')} className={cn("flex flex-col items-center gap-1.5 px-4 py-2 rounded-2xl transition-all", view === 'teacher' ? "text-indigo-600" : "text-slate-400")}>
            <BarChart3 className="w-6 h-6" />
            <span className="text-[10px] font-black uppercase tracking-widest">看板</span>
          </button>
        )}
        <button onClick={() => setView('student')} className={cn("flex flex-col items-center gap-1.5 px-4 py-2 rounded-2xl transition-all", view === 'student' ? "text-indigo-600" : "text-slate-400")}>
          <Activity className="w-6 h-6" />
          <span className="text-[10px] font-black uppercase tracking-widest">诊断</span>
        </button>
        <button onClick={() => setView('materials')} className={cn("flex flex-col items-center gap-1.5 px-4 py-2 rounded-2xl transition-all", view === 'materials' ? "text-indigo-600" : "text-slate-400")}>
          <Bookmark className="w-6 h-6" />
          <span className="text-[10px] font-black uppercase tracking-widest">素材</span>
        </button>
        <button onClick={() => setIsPwdModalOpen(true)} className="flex flex-col items-center gap-1.5 px-4 py-2 rounded-2xl text-slate-400">
          <KeyRound className="w-6 h-6" />
          <span className="text-[10px] font-black uppercase tracking-widest">密码</span>
        </button>
        <button onClick={handleLogout} className="flex flex-col items-center gap-1.5 px-4 py-2 rounded-2xl text-slate-400">
          <LogOut className="w-6 h-6" />
          <span className="text-[10px] font-black uppercase tracking-widest">退出</span>
        </button>
      </nav>

      {/* Main Content */}
      <main className="lg:ml-64 p-6 md:p-12 pt-24 lg:pt-12 max-w-7xl mx-auto pb-32 lg:pb-12">
        <AnimatePresence mode="wait">
          {view === 'teacher' ? (
            <motion.div key="teacher" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="space-y-10">
              <header className="flex flex-col md:flex-row md:items-end justify-between gap-8">
                <div>
                  <h1 className="text-5xl font-black text-slate-900 tracking-tighter">班级学情看板</h1>
                  <p className="text-slate-500 mt-3 font-bold text-lg">{user?.name}的班级 · 实时学情诊断分析</p>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="relative">
                    <Search className="w-5 h-5 absolute left-5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input type="text" placeholder="搜索姓名或学号..." className="pl-14 pr-6 py-4 bg-white border border-slate-200 rounded-[24px] text-sm font-bold focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none w-80 transition-all shadow-sm" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                  </div>
                  <button
                    onClick={() => {
                      // 新增学生：给一个空白草稿（没有 dbId），弹窗会切到"新增"模式
                      setEditingStudent({
                        id: '', name: '',
                        choice: 0, modernReading: 0, classicReading: 0,
                        nonLinear: 0, dictation: 0, composition: 0, total: 0,
                      });
                      setIsEditModalOpen(true);
                    }}
                    title="新增学生"
                    aria-label="新增学生"
                    className="p-4 bg-indigo-600 text-white rounded-[24px] shadow-2xl shadow-indigo-200 hover:bg-indigo-700 transition-all"
                  ><Users className="w-6 h-6" /></button>
                </div>
              </header>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatBox label="班级平均分" value={classStats.avg} subValue={students.length > 0 ? "实时计算" : "暂无数据"} icon={TrendingUp} colorClass="bg-indigo-50 text-indigo-600" delay={0.1} />
                <StatBox label="及格率 (90+)" value={`${classStats.passRate}%`} subValue={classStats.passRate >= 80 ? "表现优秀" : "需提升"} icon={CheckCircle2} colorClass="bg-emerald-50 text-emerald-600" delay={0.2} />
                <StatBox label="优秀率 (120+)" value={`${classStats.excellentRate}%`} subValue={classStats.excellentRate >= 20 ? "稳定" : "待突破"} icon={Award} colorClass="bg-amber-50 text-amber-600" delay={0.3} />
                <StatBox label="待关注人数" value={classStats.attentionCount} subValue="需辅导" icon={AlertCircle} colorClass="bg-rose-50 text-rose-600" delay={0.4} />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <Card title="分数段分布" subtitle="全班成绩正态分布" className="lg:col-span-2" delay={0.5}>
                  <div className="h-[360px] mt-6">
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                      <BarChart data={getScoreDistribution()}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis dataKey="range" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#94a3b8', fontWeight: 600 }} />
                        <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#94a3b8', fontWeight: 600 }} />
                        <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: '24px', border: 'none', boxShadow: '0 20px 50px rgba(0,0,0,0.05)' }} />
                        <Bar dataKey="count" fill="#6366f1" radius={[12, 12, 0, 0]} barSize={50}>
                          {[0, 1, 2, 3, 4, 5].map((_, index) => <Cell key={`cell-${index}`} fill={index === 5 ? '#f43f5e' : '#6366f1'} fillOpacity={0.8} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
                <Card title="题型得分率排行" subtitle="全班平均表现" delay={0.6}>
                  <div className="space-y-8 mt-6">
                    {getTypePerformance().map(item => (
                      <div key={item.label}>
                        <div className="flex justify-between text-xs font-black mb-3"><span className="text-slate-600">{item.label}</span><span className="text-slate-900">{item.val}%</span></div>
                        <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${item.val}%` }} transition={{ duration: 1, delay: 0.8 }} className={cn("h-full rounded-full", item.color)} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
              <Card title="知识点掌握热力图" subtitle="全班薄弱环节分布" delay={0.65} className="mb-8">
                <ClassHeatmap students={students} />
              </Card>
              <Card title="学生成绩明细" subtitle={`共 ${filteredStudents.length} 条记录`} delay={0.7}>
                <div className="overflow-x-auto mt-6">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] border-b border-slate-100">
                        <th className="pb-6">排名</th><th className="pb-6">姓名</th><th className="pb-6 text-center">选择</th><th className="pb-6 text-center">现代文</th><th className="pb-6 text-center">文言文</th><th className="pb-6 text-center">作文</th><th className="pb-6 text-right">总分</th><th className="pb-6 text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {filteredStudents.map((s, idx) => (
                        <tr key={s.id} className="group hover:bg-slate-50/80 transition-all duration-300">
                          <td className="py-6 text-sm font-black text-slate-300">#{(idx + 1).toString().padStart(2, '0')}</td>
                          <td className="py-6"><div className="font-black text-slate-900 text-base">{s.name}</div><div className="text-[10px] text-slate-400 font-bold tracking-wider">{s.id}</div></td>
                          <td className="py-6 text-center text-sm font-bold text-slate-600">{s.choice}</td>
                          <td className="py-6 text-center text-sm font-bold text-slate-600">{s.modernReading}</td>
                          <td className="py-6 text-center text-sm font-bold text-slate-600">{s.classicReading}</td>
                          <td className="py-6 text-center text-sm font-bold text-indigo-600">{s.composition}</td>
                          <td className="py-6 text-right"><span className="px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-black shadow-lg shadow-slate-900/10">{s.total}</span></td>
                          <td className="py-6">
                            <div className="flex items-center justify-center gap-1">
                              <button onClick={() => { setSelectedStudentId(s.id); setView('student'); }} className="p-2.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"><ChevronRight className="w-5 h-5" /></button>
                              <button onClick={() => { setEditingStudent(s); setIsEditModalOpen(true); }} className="p-2.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-xl transition-all"><Edit3 className="w-5 h-5" /></button>
                              <button onClick={() => s.dbId && handleDeleteStudent(s.dbId)} className="p-2.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-all"><Trash2 className="w-5 h-5" /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </motion.div>
          ) : view === 'materials' ? (
            <motion.div key="materials" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-10">
              <header className="flex items-center gap-8">
                {user?.role === 'teacher' && (
                  <button onClick={() => setView('teacher')} className="w-14 h-14 shrink-0 flex items-center justify-center bg-white border border-slate-200 rounded-[24px] hover:bg-slate-50 transition-all shadow-sm hover:shadow-md"><ArrowRight className="w-6 h-6 rotate-180" /></button>
                )}
                <div>
                  <h1 className="text-4xl font-black text-slate-900 tracking-tighter">{user?.role === 'teacher' ? '学生素材库' : '我的素材库'}</h1>
                  <p className="text-slate-500 mt-3 font-bold">升格范文里点「收藏到素材库」的金句会汇总到这里 · 共 {materials.length} 条</p>
                </div>
              </header>
              <MaterialLibrary materials={materials} onDelete={deleteMaterial} />
            </motion.div>
          ) : (
            <motion.div key="student" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-10">
              <header className="flex items-center justify-between">
                <div className="flex items-center gap-8">
                  {user?.role === 'teacher' && (
                    <button onClick={() => setView('teacher')} className="w-14 h-14 flex items-center justify-center bg-white border border-slate-200 rounded-[24px] hover:bg-slate-50 transition-all shadow-sm hover:shadow-md"><ArrowRight className="w-6 h-6 rotate-180" /></button>
                  )}
                  <div>
                    <h1 className="text-4xl font-black text-slate-900 tracking-tighter">{user?.role === 'student' ? '我的诊断报告' : `${selectedStudent.name} 的诊断报告`}</h1>
                    <div className="flex items-center gap-4 mt-3">
                      <span className="text-[10px] font-black bg-indigo-100 text-indigo-700 px-4 py-1.5 rounded-full uppercase tracking-[0.15em]">学号: {selectedStudent.id}</span>
                      <span className="text-[10px] font-black bg-slate-100 text-slate-600 px-4 py-1.5 rounded-full uppercase tracking-[0.15em]">2026年春季月考</span>
                      <button onClick={() => exportToPDF('student-report', `${selectedStudent.name}_全项学情报告.pdf`)} className="flex items-center gap-2 px-4 py-1.5 bg-white border border-slate-200 rounded-full text-[10px] font-black text-slate-500 hover:bg-slate-50 transition-all uppercase tracking-widest">
                        <Download className="w-3 h-3" /> 导出 PDF 报告
                      </button>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-6xl font-black text-indigo-600 leading-none tracking-tighter">{selectedStudent.total}</div>
                  <div className="text-[10px] text-slate-400 font-black uppercase tracking-[0.3em] mt-3">Total Score</div>
                </div>
              </header>

              <div id="student-report" className="space-y-10">
                {/* 三栏：作文诊断占 2/3，学习处方占 1/3。
                    原来是四栏（作文 3 + 处方 1），处方卡只有 248px 宽，
                    卡内标题被压到每行两个字、「生成处方」按钮竖着撑成 94×104 的方块。 */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  <Card className="md:col-span-3 lg:col-span-2 bg-emerald-50/30 border-emerald-100/50" delay={0.1}>
                    <div className="flex items-center justify-between mb-10">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-emerald-100 rounded-[20px] flex items-center justify-center"><PenTool className="w-6 h-6 text-emerald-600" /></div>
                        <div><h3 className="text-xl font-bold text-slate-900">AI 作文深度诊断</h3><p className="text-xs text-slate-500 font-bold">多维度自动阅卷与修改建议</p></div>
                      </div>
                      {essayAnalysis && <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-widest"><History className="w-4 h-4" /> {formatDay(essayAnalysis.date)}</div>}
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                      <div className="space-y-8">
                        <div className="space-y-6">
                          <div className="relative">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-3 block ml-1">作文题目 / Essay Title</label>
                            <input type="text" placeholder="请输入作文题目..." className="w-full px-6 py-4 bg-white border border-slate-200 rounded-[24px] text-sm font-bold outline-none focus:ring-8 focus:ring-emerald-500/5 focus:border-emerald-500 transition-all shadow-sm" value={essayTitle} onChange={(e) => setEssayTitle(e.target.value)} />
                          </div>
                          <div className="grid grid-cols-3 gap-4">
                            {essayImages.map((img, idx) => (
                              <motion.div key={idx} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="relative aspect-[3/4] rounded-[24px] overflow-hidden border border-slate-200 group shadow-lg">
                                <img src={img} alt="Essay" className="w-full h-full object-cover" />
                                <button onClick={() => {
                                  setEssayImages(prev => prev.filter((_, i) => i !== idx));
                                  // 图变了，识别结果就作废：不能拿着旧文字去批阅新照片
                                  setOcrText(''); setOcrHandwriting(''); setOcrWarning(''); setOcrModel('');
                                }} className="absolute top-3 right-3 p-2 bg-rose-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-all shadow-xl"><AlertCircle className="w-4 h-4" /></button>
                              </motion.div>
                            ))}
                            {/* ✅ 修复：上传上限改为 2 张，与后端对齐 */}
                            {essayImages.length < 2 && (
                              <label className="aspect-[3/4] rounded-[24px] border-2 border-dashed border-slate-200 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-emerald-400 hover:bg-emerald-50 transition-all group">
                                <ImageIcon className="w-10 h-10 text-slate-300 group-hover:text-emerald-400 transition-colors" />
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">添加图片</span>
                                <input type="file" accept="image/*" multiple className="hidden" onChange={handleEssayImageUpload} />
                              </label>
                            )}
                          </div>
                        </div>

                        {/* ── ① 先只认字 ── */}
                        <button
                          onClick={recognizeEssay}
                          disabled={isOcrRunning || isAnalyzingEssay || essayImages.length < 1 || !essayTitle.trim()}
                          className="w-full py-4 bg-white border-2 border-emerald-500 text-emerald-700 rounded-[24px] font-black text-base hover:bg-emerald-50 transition-all flex items-center justify-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {isOcrRunning ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
                          {isOcrRunning ? "正在识别文字…" : ocrText ? "重新识别文字" : "① 扫描识别文字"}
                        </button>

                        {ocrText ? (
                          <div className="rounded-[24px] border border-emerald-100 bg-emerald-50/40 p-5 space-y-4">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-[10px] font-black text-emerald-700 uppercase tracking-[0.2em]">
                                ② 核对原文
                              </span>
                              <span className="text-[10px] font-bold text-slate-400">
                                {ocrText.length} 字{ocrModel ? ` · ${ocrModel.split('/').pop()}` : ''}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500 leading-relaxed">
                              下面是 AI 认出来的原文。<strong className="text-slate-700">手写体难免认错字，请顺手改一下</strong>
                              —— 改完再批阅，评分才准。认错一个字而没改，后面的点评就跟着错了。
                            </p>
                            {ocrWarning && (
                              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 leading-relaxed">
                                {ocrWarning}
                              </p>
                            )}
                            <textarea
                              value={ocrText}
                              onChange={(e) => setOcrText(e.target.value)}
                              placeholder="识别出的作文原文"
                              className="w-full h-52 p-4 bg-white border border-slate-200 rounded-[20px] text-sm leading-relaxed outline-none focus:ring-8 focus:ring-emerald-500/5 focus:border-emerald-500 transition-all custom-scrollbar resize-none"
                            />
                            <div className="flex items-center gap-3">
                              <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] whitespace-nowrap">
                                卷面
                              </label>
                              <input
                                type="text"
                                value={ocrHandwriting}
                                onChange={(e) => setOcrHandwriting(e.target.value)}
                                placeholder="字迹是否工整、有无涂改"
                                className="flex-1 px-4 py-2.5 bg-white border border-slate-200 rounded-full text-xs font-bold outline-none focus:border-emerald-500 transition-all"
                              />
                            </div>
                            <button
                              onClick={analyzeEssay}
                              disabled={isAnalyzingEssay || !ocrText.trim()}
                              className="w-full py-5 bg-emerald-600 text-white rounded-[24px] font-black text-lg hover:bg-emerald-700 transition-all flex items-center justify-center gap-4 shadow-2xl shadow-emerald-200 disabled:opacity-50 disabled:shadow-none"
                            >
                              {isAnalyzingEssay ? <Loader2 className="w-6 h-6 animate-spin" /> : <Sparkles className="w-6 h-6" />}
                              {isAnalyzingEssay
                                ? buttonLabel('AI 正在批阅…', streamChars, thinkingChars, '已输出')
                                : "② 开始批阅"}
                            </button>
                          </div>
                        ) : (
                          <p className="text-[11px] text-slate-400 leading-relaxed text-center">
                            上传作文照片后，先点上面的「① 扫描识别文字」，
                            <br />
                            核对并改好原文，再点「② 开始批阅」。
                          </p>
                        )}
                      </div>

                      <div className="bg-white rounded-[32px] border border-slate-100 p-8 min-h-[450px] flex flex-col shadow-inner overflow-hidden">
                        {isAnalyzingEssay ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6">
                            <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center animate-bounce"><Sparkles className="w-10 h-10 text-emerald-600" /></div>
                            <p className="text-lg text-slate-500 font-black animate-pulse">AI 正在批阅这篇作文…</p>
                            {streamChars > 0 && (
                              <p className="text-xs font-bold text-emerald-600">
                                模型已输出 {streamChars} 字，收尾时会自动整理成评分报告
                              </p>
                            )}
                          </div>
                        ) : essayAnalysis ? (
                          <div className="flex-1 overflow-y-auto pr-4 custom-scrollbar prose prose-sm prose-indigo max-w-none prose-p:leading-relaxed">
                            <ReactMarkdown>{essayAnalysis.analysis}</ReactMarkdown>
                          </div>
                        ) : ocrText ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-4 opacity-60">
                            <FileText className="w-20 h-20 text-emerald-300" />
                            <p className="text-base text-emerald-700 font-black">文字已识别</p>
                            <p className="text-xs text-slate-500 font-bold leading-relaxed max-w-[240px]">
                              请在左边核对原文、改正认错的字，然后点「② 开始批阅」
                            </p>
                          </div>
                        ) : (
                          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-4 opacity-30">
                            <FileText className="w-20 h-20 text-slate-300" />
                            <p className="text-base text-slate-400 font-black">暂无分析报告，请先上传作文并识别文字</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </Card>

                  <Card
                    id="ai-prescription-card"
                    className={cn(
                      "md:col-span-3 lg:col-span-1 bg-indigo-50/30 border-indigo-100/50 transition-shadow duration-500",
                      // 「专项练习」缺处方时，老师会被引导到这里 —— 闪一圈光圈指个路
                      rxNudge && "ring-4 ring-indigo-400/60 shadow-xl shadow-indigo-200"
                    )}
                    delay={0.2}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-12 h-12 bg-indigo-100 rounded-[20px] flex items-center justify-center"><BrainCircuit className="w-6 h-6 text-indigo-600" /></div>
                        <div className="min-w-0"><h3 className="text-xl font-bold text-slate-900">智能学习处方</h3><p className="text-xs text-slate-500 font-bold">基于大模型的个性化提升建议</p></div>
                      </div>
                      <button onClick={() => generateAIAnalysis(selectedStudent)} disabled={isGenerating} className="shrink-0 whitespace-nowrap px-6 py-3 bg-indigo-600 text-white rounded-[24px] font-black text-sm hover:bg-indigo-700 transition-all flex items-center gap-3 shadow-lg shadow-indigo-200 disabled:opacity-50">
                        {isGenerating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Target className="w-5 h-5" />}
                        {/* ⚠️ 顺序不能反：正文一旦开始出来，就必须切回"已写 N 字"。
                            真机验证时踩过 —— 写成 thinkingChars 优先的话，
                            正文都写了一千字了，按钮还停在"构思中"，反而误导老师。 */}
                        {isGenerating ? buttonLabel('生成中…', streamChars, thinkingChars) : '生成处方'}
                      </button>
                    </div>
                    <div className="prose prose-sm max-w-none text-slate-700 leading-loose min-h-[120px]">
                      {aiPrescription ? (
                        <>
                          <ReactMarkdown>{aiPrescription}</ReactMarkdown>
                          {isGenerating && (
                            <div className="flex items-center gap-3 pt-4 text-xs font-bold text-indigo-500">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              {streamingLabel('正在生成…', aiPrescription.length, 0)}
                            </div>
                          )}
                        </>
                      ) : isGenerating ? (
                        <div className="flex items-center justify-center py-10"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>
                      ) : (
                        <p className="text-slate-400 italic">点击右上角按钮，让 AI 为您生成专属学习处方。</p>
                      )}
                    </div>
                  </Card>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  <Card title="🚀 专项提分练习" subtitle="巩固薄弱知识点" delay={0.3}>
                    {/* ⚠️ 这里过去是 `disabled={isActionLoading || !aiPrescription || aiPrescription.includes("失败")}`。
                        禁用的按钮**不会触发 onClick**，所以老师点了以后连提示都弹不出来，
                        看到的正是「点击按键后无反应」（2026-10-10 实测确认）。
                        现在只在"正在生成"时才禁用；缺处方由 fetchPractice 明确告知并指路。 */}
                    <button onClick={fetchPractice} disabled={isActionLoading} className="w-full py-5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-[24px] font-black text-lg hover:from-indigo-700 hover:to-purple-700 transition-all flex items-center justify-center gap-4 shadow-2xl shadow-indigo-200 disabled:opacity-50">
                      {isActionLoading && activeAction === 'practice' ? <Loader2 className="w-6 h-6 animate-spin" /> : <BookOpen className="w-6 h-6" />}
                      {isActionLoading && activeAction === 'practice'
                        ? buttonLabel('AI 正在出题…', streamChars, thinkingChars, '已输出')
                        : '开始专项练习'}
                    </button>
                    {!hasPrescription && !(isActionLoading && activeAction === 'practice') && (
                      <p className="mt-3 text-[11px] leading-relaxed text-slate-500 text-center">
                        {analysisFailed
                          ? '上次学情分析没成功 —— 请先重新点上方「智能学习处方」里的「生成处方」。'
                          : <>这份练习按学生的薄弱点出题，请先点上方「智能学习处方」卡里的 <strong className="text-indigo-600">「生成处方」</strong>。</>}
                      </p>
                    )}
                    {practiceData && <InteractivePractice data={practiceData} />}
                  </Card>

                  <Card title="📖 范文升格赏析" subtitle="AI 生成升格范文与金句" delay={0.4}>
                    {/* 同上：把"没批阅过作文"的静默禁用改成点击后明确提示（守卫在 fetchUpgradedEssay 里已有） */}
                    <button onClick={fetchUpgradedEssay} disabled={isActionLoading} className="w-full py-5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-[24px] font-black text-lg hover:from-emerald-700 hover:to-teal-700 transition-all flex items-center justify-center gap-4 shadow-2xl shadow-emerald-200 disabled:opacity-50">
                      {isActionLoading && activeAction === 'essay' ? <Loader2 className="w-6 h-6 animate-spin" /> : <Sparkles className="w-6 h-6" />}
                      {isActionLoading && activeAction === 'essay'
                        ? buttonLabel('AI 正在写范文…', streamChars, thinkingChars)
                        : '生成升格范文'}
                    </button>
                    {!essayAnalysis && !(isActionLoading && activeAction === 'essay') && (
                      <p className="mt-3 text-[11px] leading-relaxed text-slate-500 text-center">
                        升格要基于原文改，请先在左边「AI 作文深度诊断」里上传作文并完成批阅。
                      </p>
                    )}
                    {actionContent && (
                      <div className="mt-8 space-y-6">
                        <div className="flex items-center justify-between">
                          <h4 className="text-lg font-bold text-slate-900">升格范文</h4>
                          {/* 生成中不让点朗读：这时显示的还是带标记的原始文本，
                              读出来会把「【金句推荐】」念一遍。等收尾整理完再读。 */}
                          <button onClick={() => playTTS(actionContent)} disabled={isTTSLoading || isActionLoading} className="flex items-center gap-2 px-4 py-2 bg-slate-100 rounded-full text-sm font-bold text-slate-600 hover:bg-slate-200 transition-all disabled:opacity-50">
                            {isPlayingAudio ? <Square className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                            {isTTSLoading ? '生成中...' : isPlayingAudio ? '停止朗读' : '朗读范文'}
                          </button>
                        </div>
                        <div className="prose prose-sm max-w-none text-slate-700 leading-loose">
                          <ReactMarkdown>{actionContent}</ReactMarkdown>
                        </div>
                        {isActionLoading && activeAction === 'essay' && (
                          <div className="flex items-center gap-3 pt-2 text-xs font-bold text-emerald-600">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            正在生成…上面这条范文是边写边显示的，还没写完
                          </div>
                        )}

                        {goldenSentences.length > 0 && (
                          <div className="mt-8">
                            <h4 className="text-lg font-bold text-slate-900 mb-4">🌟 金句收藏</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {goldenSentences.map((gs, idx) => (
                                <div key={idx} className="bg-amber-50 p-5 rounded-2xl border border-amber-100">
                                  <p className="text-slate-800 font-serif italic mb-2">"{gs.content}"</p>
                                  <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">{gs.theme}</span>
                                    <button onClick={() => saveMaterial(gs.content, gs.theme, "AI升格范文")} className="text-xs font-bold text-emerald-600 hover:text-emerald-700">
                                      收藏到素材库
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  <Card title="📜 历史诊断记录" subtitle="过往作文分析存档" className="lg:col-span-2" delay={0.5}>
                    <div className="space-y-4">
                      {analysisHistory.length > 0 ? analysisHistory.map((record, idx) => (
                        <div key={record.id} className="p-6 bg-slate-50 rounded-2xl border border-slate-100 hover:border-indigo-100 transition-all">
                          <div className="flex justify-between items-start mb-3">
                            <h4 className="font-bold text-slate-900">{record.title}</h4>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{formatDay(record.date)}</span>
                          </div>
                          <div className="prose prose-sm max-w-none text-slate-600 leading-relaxed line-clamp-3">
                            <ReactMarkdown>{record.analysis}</ReactMarkdown>
                          </div>
                        </div>
                      )) : (
                        <div className="text-center py-12 text-slate-400">
                          <History className="w-12 h-12 mx-auto mb-4 opacity-30" />
                          <p className="font-black">暂无历史记录</p>
                        </div>
                      )}
                    </div>
                  </Card>

                  <Card title="📊 成长曲线" subtitle="历次考试总分趋势" delay={0.6}>
                    <GrowthCurve history={scoreHistory} />
                  </Card>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Edit Modal */}
      <AnimatePresence>
        {isEditModalOpen && editingStudent && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-6"
            onClick={() => setIsEditModalOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-[32px] p-10 w-full max-w-2xl shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-2xl font-black text-slate-900 mb-8">{editingStudent.dbId ? '编辑学生成绩' : '新增学生'}</h3>

              {!editingStudent.dbId && (
                <div className="mb-8">
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-2">学号</label>
                      <input
                        type="text"
                        placeholder="例如 2026007"
                        value={editingStudent.id}
                        onChange={(e) => setEditingStudent({ ...editingStudent, id: e.target.value })}
                        className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-2">姓名</label>
                      <input
                        type="text"
                        placeholder="学生姓名"
                        value={editingStudent.name}
                        onChange={(e) => setEditingStudent({ ...editingStudent, name: e.target.value })}
                        className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10"
                      />
                    </div>
                  </div>
                  <p className="text-xs font-bold text-slate-400 mt-3">学号与姓名要和成绩表里的一致，学生才能用这个学号注册账号。</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-6">
                {SCORE_INPUT_FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-2">{label}</label>
                    <input
                      type="number"
                      value={(editingStudent as any)[key] || 0}
                      onChange={(e) => setEditingStudent({ ...editingStudent, [key]: parseInt(e.target.value) || 0 })}
                      className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10"
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs font-bold text-slate-400 mt-4">每格后面的数字是该项满分，六项合计 150 分。「非连续性文本」已并入现代文阅读：现代文那一格直接填总分即可，非连续性留空。</p>
              <div className="flex justify-end gap-4 mt-10">
                <button onClick={() => setIsEditModalOpen(false)} className="px-8 py-4 bg-slate-100 text-slate-600 rounded-2xl font-black hover:bg-slate-200 transition-all">取消</button>
                <button onClick={() => handleSaveStudent(editingStudent)} className="px-8 py-4 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all">保存</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {isPwdModalOpen && <ChangePasswordModal onClose={() => setIsPwdModalOpen(false)} />}
    </div>
  );
}
