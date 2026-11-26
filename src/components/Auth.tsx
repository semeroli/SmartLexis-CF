import React, { useEffect, useState } from 'react';
import {
  LogIn, UserPlus, Loader2, AlertCircle, CheckCircle2,
  HelpCircle, ArrowLeft, Send, Sun, Moon, Monitor, ChevronDown,
} from 'lucide-react';
import { saveSession } from '../lib/api';

interface AuthProps {
  onAuthSuccess: (user: any) => void;
}

// 三种模式共用一个面板：登录 / 注册 / 找回密码
type Mode = 'login' | 'register' | 'reset';
type Pref = 'dark' | 'light' | 'auto';

// 与落地页（public/welcome.html）共用同一个键，保证两处的主题选择是同一件事
const TKEY = 'sl-theme';

const readPref = (): Pref => {
  try {
    const v = localStorage.getItem(TKEY);
    if (v === 'light' || v === 'auto') return v;
  } catch (_) {}
  return 'dark';
};

// ─────────────────────────────────────────────────────────────
// 样式说明（与落地页同一套视觉语言）
//   · 所有颜色走 CSS 变量，浅色主题只换变量、不写第二套结构，
//     避免"改了浅色忘了某一块"的漏网。
//   · 背景全部用 CSS 画（网格 + 三团光晕），不依赖任何外链图片 ——
//     老版本用的那张 imagebed 图实测 naturalWidth=0，从来没加载成功过。
// ─────────────────────────────────────────────────────────────
const CSS = `
.sl-auth{
  --bg:#05070E; --bg2:#070A13;
  --ink:#E9EEF8; --ink-mid:#A8B3C7; --ink-mute:#7C8798;
  --accent:#818CF8; --accent-2:#22D3EE;
  --card:rgba(13,17,28,.74); --card-brd:rgba(255,255,255,.10);
  --card-sh:0 40px 90px -40px rgba(0,0,0,.9);
  --inp:rgba(255,255,255,.045); --inp-brd:rgba(255,255,255,.13); --inp-ink:#EAF0FA; --inp-ph:#5B6578;
  --label:#94A0B4; --tab-off:#7C8798; --pill:rgba(255,255,255,.06);
  --divider:rgba(255,255,255,.08);
  --ok-bg:rgba(16,185,129,.10); --ok-brd:rgba(16,185,129,.28); --ok-ink:#6EE7B7;
  --err-bg:rgba(244,63,94,.10); --err-brd:rgba(244,63,94,.30); --err-ink:#FDA4AF;
  --hint-bg:rgba(99,102,241,.10); --hint-brd:rgba(99,102,241,.30); --hint-ink:#C7D2FE;
  --btn:linear-gradient(135deg,#6D6AF6 0%,#4F46E5 100%);
  --btn-sh:0 14px 36px -12px rgba(79,70,229,.85);
  --grid:rgba(255,255,255,.038);
  --glow-a:.55; --glow-b:.42; --glow-c:.5;
  --alt:rgba(255,255,255,.05); --alt-brd:rgba(255,255,255,.14); --alt-ink:#C3CCDC;
}
.sl-auth[data-theme="light"]{
  --bg:#F7F8FC; --bg2:#EFF2F9;
  --ink:#0F172A; --ink-mid:#475569; --ink-mute:#8A97AB;
  --accent:#4F46E5; --accent-2:#0E7490;
  --card:#FFFFFF; --card-brd:rgba(15,23,42,.09);
  --card-sh:0 1px 2px rgba(16,24,40,.05), 0 26px 64px -30px rgba(16,24,40,.26);
  --inp:#F8FAFC; --inp-brd:rgba(15,23,42,.13); --inp-ink:#0F172A; --inp-ph:#9AA7B8;
  --label:#64748B; --tab-off:#7A8798; --pill:rgba(15,23,42,.055);
  --divider:rgba(15,23,42,.09);
  --ok-bg:rgba(16,185,129,.08); --ok-brd:rgba(16,185,129,.24); --ok-ink:#047857;
  --err-bg:rgba(244,63,94,.07); --err-brd:rgba(244,63,94,.22); --err-ink:#BE123C;
  --hint-bg:rgba(79,70,229,.06); --hint-brd:rgba(79,70,229,.20); --hint-ink:#3730A3;
  --btn:linear-gradient(135deg,#6366F1 0%,#4F46E5 100%);
  --btn-sh:0 12px 28px -12px rgba(79,70,229,.55);
  --grid:rgba(15,23,42,.045);
  --glow-a:.30; --glow-b:.22; --glow-c:.26;
  --alt:rgba(15,23,42,.04); --alt-brd:rgba(15,23,42,.12); --alt-ink:#475569;
}
.sl-auth{
  position:relative; min-height:100vh; min-height:100dvh;
  background:var(--bg); color:var(--ink); overflow-x:hidden;
  font-family:Inter,ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
/* ── 背景：网格 + 三团光晕（纯 CSS） ───────────────────── */
.sl-auth .bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.sl-auth .bg .grid{
  position:absolute;inset:-2px;
  background-image:linear-gradient(to right,var(--grid) 1px,transparent 1px),
                   linear-gradient(to bottom,var(--grid) 1px,transparent 1px);
  background-size:56px 56px;
  -webkit-mask-image:radial-gradient(ellipse 78% 62% at 50% 34%,#000 35%,transparent 100%);
  mask-image:radial-gradient(ellipse 78% 62% at 50% 34%,#000 35%,transparent 100%);
}
.sl-auth .bg .glow{position:absolute;border-radius:9999px;filter:blur(90px)}
.sl-auth .bg .g1{width:760px;height:760px;left:-220px;top:-280px;opacity:var(--glow-a);
  background:radial-gradient(circle,rgba(99,102,241,.85),transparent 68%)}
.sl-auth .bg .g2{width:620px;height:620px;right:-180px;top:-120px;opacity:var(--glow-b);
  background:radial-gradient(circle,rgba(34,211,238,.55),transparent 68%)}
.sl-auth .bg .g3{width:820px;height:560px;left:34%;bottom:-340px;opacity:var(--glow-c);
  background:radial-gradient(circle,rgba(139,92,246,.55),transparent 70%)}

/* ── 主题切换按钮 ─────────────────────────────────────── */
.sl-auth .theme-btn{
  position:fixed;top:18px;right:18px;z-index:30;
  width:40px;height:40px;display:flex;align-items:center;justify-content:center;
  border-radius:12px;border:1px solid var(--alt-brd);background:var(--alt);
  color:var(--ink-mid);cursor:pointer;transition:all .22s ease;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  box-shadow:0 6px 18px -10px rgba(0,0,0,.6);
}
.sl-auth .theme-btn:hover{color:var(--accent);border-color:var(--accent);transform:translateY(-1px)}

/* ── 版式：左品牌 / 右表单 ─────────────────────────────── */
.sl-auth .shell{
  position:relative;z-index:2;min-height:100vh;min-height:100dvh;
  display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  align-items:center;gap:48px;max-width:1240px;margin:0 auto;
  padding:46px clamp(24px,4vw,64px);
}
.sl-auth .brand{max-width:540px}
.sl-auth .logo{display:flex;align-items:center;gap:12px;margin-bottom:38px}
.sl-auth .mark{
  width:42px;height:42px;border-radius:13px;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#7C6BFF 0%,#4F46E5 100%);
  box-shadow:0 10px 26px -10px rgba(99,102,241,.9),inset 0 1px 0 rgba(255,255,255,.35);
  flex:none;
}
.sl-auth .mark svg{width:22px;height:22px;color:#fff}
.sl-auth .word{font-size:19px;font-weight:800;letter-spacing:.16em;line-height:1}
.sl-auth .word small{
  display:block;font-size:9px;font-weight:700;letter-spacing:.42em;
  color:var(--ink-mute);margin-top:7px;
}
.sl-auth h1{
  font-size:clamp(30px,3.6vw,46px);line-height:1.28;font-weight:800;
  letter-spacing:.04em;margin:0 0 18px;color:var(--ink);
}
.sl-auth h1 em{
  display:block;font-style:normal;
  background:linear-gradient(100deg,var(--accent) 0%,var(--accent-2) 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
.sl-auth .tag{font-size:14px;color:var(--ink-mid);letter-spacing:.06em;margin:0 0 34px}
.sl-auth .points{list-style:none;padding:0;margin:0 0 46px;display:flex;flex-direction:column;gap:14px}
.sl-auth .points li{display:flex;align-items:center;gap:11px;font-size:13.5px;color:var(--ink-mid)}
.sl-auth .points i{
  width:6px;height:6px;border-radius:9999px;flex:none;
  background:linear-gradient(135deg,var(--accent),var(--accent-2));
  box-shadow:0 0 10px rgba(99,102,241,.9);
}
.sl-auth .copy{font-size:11px;color:var(--ink-mute);letter-spacing:.04em;margin:0}

/* ── 表单卡 ───────────────────────────────────────────── */
.sl-auth .main{display:flex;justify-content:center}
.sl-auth .card{
  width:100%;max-width:448px;
  background:var(--card);border:1px solid var(--card-brd);
  border-radius:26px;padding:30px 30px 26px;
  box-shadow:var(--card-sh);
  backdrop-filter:blur(22px) saturate(140%);
  -webkit-backdrop-filter:blur(22px) saturate(140%);
}
.sl-auth .card-h{margin-bottom:20px}
.sl-auth .card-h b{display:block;font-size:20px;font-weight:800;letter-spacing:.02em;color:var(--ink)}
.sl-auth .card-h span{display:block;font-size:12.5px;color:var(--ink-mute);margin-top:7px;letter-spacing:.02em}

/* 顶部两页签 */
.sl-auth .tabs{position:relative;display:grid;grid-template-columns:1fr 1fr;
  background:var(--pill);border-radius:13px;padding:4px;margin-bottom:20px}
.sl-auth .tabs .knob{
  position:absolute;top:4px;left:4px;width:calc(50% - 4px);height:calc(100% - 8px);
  border-radius:10px;background:var(--alt);border:1px solid var(--alt-brd);
  transition:transform .3s cubic-bezier(.22,.8,.3,1);
}
.sl-auth .tabs.on2 .knob{transform:translateX(100%)}
.sl-auth .tabs button{
  position:relative;z-index:1;padding:9px 0;border:0;background:none;cursor:pointer;
  font-size:13px;font-weight:700;letter-spacing:.06em;color:var(--tab-off);
  border-radius:10px;transition:color .2s ease;font-family:inherit;
}
.sl-auth .tabs button:hover{color:var(--ink-mid)}
.sl-auth .tabs button.act{color:var(--ink)}

/* 字段 */
.sl-auth .f{margin-bottom:14px}
.sl-auth .f label{
  display:block;font-size:11px;font-weight:800;letter-spacing:.16em;
  color:var(--label);margin-bottom:8px;text-transform:uppercase;
}
.sl-auth .f .inp-wrap{position:relative}
.sl-auth input[type=text],.sl-auth input[type=email],.sl-auth input[type=password],.sl-auth select{
  width:100%;height:48px;padding:0 16px;border-radius:13px;
  background:var(--inp);border:1px solid var(--inp-brd);color:var(--inp-ink);
  font-size:14.5px;font-weight:600;font-family:inherit;outline:none;
  transition:border-color .2s ease,box-shadow .2s ease,background .2s ease;
  appearance:none;-webkit-appearance:none;
}
.sl-auth select{padding-right:42px;cursor:pointer}
.sl-auth input::placeholder{color:var(--inp-ph);font-weight:500}
.sl-auth input:focus,.sl-auth select:focus{
  border-color:var(--accent);
  box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 18%,transparent);
}
.sl-auth .sel-ic{
  position:absolute;right:14px;top:50%;transform:translateY(-50%);
  width:16px;height:16px;color:var(--ink-mute);pointer-events:none;
}
.sl-auth .hint{font-size:11px;color:var(--ink-mute);margin:8px 0 0;line-height:1.6}
.sl-auth .right{text-align:right;margin-top:-6px;margin-bottom:14px}
.sl-auth .link{
  border:0;background:none;padding:0;cursor:pointer;font-family:inherit;
  font-size:11.5px;font-weight:700;color:var(--ink-mute);
  text-decoration:underline;text-underline-offset:4px;transition:color .2s ease;
}
.sl-auth .link:hover{color:var(--accent)}

/* 提示框 */
.sl-auth .note{display:flex;align-items:flex-start;gap:9px;padding:13px 14px;border-radius:13px;
  font-size:11.5px;line-height:1.65;margin-bottom:16px;font-weight:600}
.sl-auth .note svg{width:15px;height:15px;flex:none;margin-top:2px}
.sl-auth .note.ok{background:var(--ok-bg);border:1px solid var(--ok-brd);color:var(--ok-ink)}
.sl-auth .note.err{background:var(--err-bg);border:1px solid var(--err-brd);color:var(--err-ink)}
.sl-auth .note.info{background:var(--hint-bg);border:1px solid var(--hint-brd);color:var(--hint-ink)}
.sl-auth .note i{font-style:normal;font-weight:800}
.sl-auth .note p{margin:0}

/* 主按钮 */
.sl-auth .go{
  width:100%;height:50px;margin-top:6px;border:0;border-radius:14px;cursor:pointer;
  background:var(--btn);color:#fff;font-family:inherit;font-size:14px;font-weight:800;
  letter-spacing:.22em;display:flex;align-items:center;justify-content:center;gap:10px;
  box-shadow:var(--btn-sh);transition:transform .2s ease,box-shadow .2s ease,opacity .2s ease;
}
.sl-auth .go:hover:not(:disabled){transform:translateY(-1px)}
.sl-auth .go:active:not(:disabled){transform:translateY(0)}
.sl-auth .go:disabled{opacity:.55;cursor:default}
.sl-auth .go svg{width:17px;height:17px;transition:transform .2s ease}
.sl-auth .go:hover:not(:disabled) svg{transform:translateX(2px)}
.sl-auth .back{
  width:100%;margin-top:14px;border:0;background:none;cursor:pointer;font-family:inherit;
  display:flex;align-items:center;justify-content:center;gap:6px;
  font-size:11.5px;font-weight:700;color:var(--ink-mute);transition:color .2s ease;
}
.sl-auth .back:hover{color:var(--accent)}
.sl-auth .back svg{width:13px;height:13px}
.sl-auth .foot{margin-top:16px;padding-top:13px;border-top:1px solid var(--divider);
  font-size:10.5px;color:var(--ink-mute);text-align:center;letter-spacing:.03em}

/* 进场：终态一定是 opacity:1，避免截图/弱设备停在透明帧 */
@keyframes slAuthIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes slSpin{to{transform:rotate(360deg)}}
.sl-auth .spin{animation:slSpin .9s linear infinite}
.sl-auth .brand{animation:slAuthIn .55s cubic-bezier(.22,.8,.3,1) both}
.sl-auth .card{animation:slAuthIn .55s .08s cubic-bezier(.22,.8,.3,1) both}

/* ── 窄屏：品牌收成一行，表单占满 ─────────────────────── */
@media (max-width:960px){
  .sl-auth .shell{
    grid-template-columns:1fr;gap:26px;align-content:center;
    padding:64px 18px 40px;
  }
  .sl-auth .brand{max-width:none;text-align:left}
  .sl-auth .logo{margin-bottom:0}
  .sl-auth h1,.sl-auth .points{display:none}
  .sl-auth .tag{margin:10px 0 0;font-size:11.5px;letter-spacing:.04em}
  .sl-auth .copy{display:none}
  .sl-auth .card{padding:26px 20px 24px;border-radius:22px}
}
@media (max-width:400px){
  .sl-auth .shell{padding:58px 14px 32px}
}
@media (prefers-reduced-motion:reduce){
  .sl-auth .brand,.sl-auth .card{animation:none}
  .sl-auth .tabs .knob{transition:none}
}
`;

export default function Auth({ onAuthSuccess }: AuthProps) {
  const [mode, setMode] = useState<Mode>('login');
  const isLogin = mode === 'login';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [studentId, setStudentId] = useState('');
  const [role, setRole] = useState<'teacher' | 'student'>('student');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 找回密码专用：提交结果（成功文案 / 是否重复提交）
  const [resetDone, setResetDone] = useState(false);
  const [resetMessage, setResetMessage] = useState('');

  // ── 主题：默认深色，三态循环，与落地页共用 sl-theme ──────────
  const [pref, setPref] = useState<Pref>(readPref);
  const [sysLight, setSysLight] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const sync = () => setSysLight(!!mq.matches);
    sync();
    // addEventListener 在旧 Safari 上不支持，退化成 addListener
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else mq.addListener(sync);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', sync);
      else mq.removeListener(sync);
    };
  }, []);

  const theme: 'dark' | 'light' = pref === 'auto' ? (sysLight ? 'light' : 'dark') : pref;

  const cycleTheme = () => {
    const order: Pref[] = ['dark', 'light', 'auto'];
    const next = order[(order.indexOf(pref) + 1) % order.length];
    setPref(next);
    try { localStorage.setItem(TKEY, next); } catch (_) {}
  };

  const themeLabel =
    pref === 'dark' ? '当前：深色（点击切换浅色）'
      : pref === 'light' ? '当前：浅色（点击切换跟随系统）'
        : '当前：跟随系统（点击切换深色）';

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setResetDone(false);
    setResetMessage('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    // 模拟延迟
    await new Promise(resolve => setTimeout(resolve, 800));

    try {
      if (isLogin) {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await response.json();
        if (response.ok && data.token && data.user) {
          // 令牌存在本地，之后所有接口请求都会自动带上它
          saveSession(data.token, data.user);
          onAuthSuccess(data.user);
        } else {
          setError(data.error || '登录失败');
        }
      } else {
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name, studentId, role })
        });
        const data = await response.json();
        if (response.ok && data.token && data.user) {
          saveSession(data.token, data.user);
          onAuthSuccess(data.user);
        } else {
          setError(data.error || '注册失败');
        }
      }
    } catch (err: any) {
      setError('操作失败，请重试。');
    } finally {
      setLoading(false);
    }
  };

  // 找回密码：只提交申请，真正改密码由管理员在后台点一下才会发生
  const handleResetRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    await new Promise(resolve => setTimeout(resolve, 600));

    try {
      const response = await fetch('/api/auth/request_reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data?.error || '提交失败，请重试');
        return;
      }
      setResetMessage(data?.message || '申请已提交');
      setResetDone(true);
    } catch (err: any) {
      setError('网络异常，请重试。');
    } finally {
      setLoading(false);
    }
  };

  const head =
    mode === 'register'
      ? { t: '创建账号', d: '学生请用老师导入成绩时的学号，才能看到自己的报告' }
      : mode === 'reset'
        ? { t: '找回密码', d: '系统不发邮件，由管理员为你生成临时密码' }
        : { t: '欢迎回来', d: '登录后继续你的教学诊断' };

  return (
    <div className="sl-auth" data-theme={theme}>
      <style>{CSS}</style>

      {/* 背景层：网格 + 三团光晕，纯 CSS */}
      <div className="bg" aria-hidden="true">
        <div className="grid" />
        <div className="glow g1" />
        <div className="glow g2" />
        <div className="glow g3" />
      </div>

      <button type="button" className="theme-btn" onClick={cycleTheme} title={themeLabel} aria-label={themeLabel}>
        {pref === 'dark' ? <Moon size={17} /> : pref === 'light' ? <Sun size={17} /> : <Monitor size={17} />}
      </button>

      <div className="shell">
        {/* ── 左：品牌 ─────────────────────────────────── */}
        <aside className="brand">
          <div className="logo">
            <span className="mark">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 1.6l2.35 6.55a3 3 0 0 0 1.8 1.8L22.7 12l-6.55 2.35a3 3 0 0 0-1.8 1.8L12 22.7l-2.35-6.55a3 3 0 0 0-1.8-1.8L1.3 12l6.55-2.05a3 3 0 0 0 1.8-1.8z" />
              </svg>
            </span>
            <span className="word">
              智语
              <small>SMARTLEXIS</small>
            </span>
          </div>

          <h1>
            博观而约取
            <em>厚积而薄发</em>
          </h1>
          <p className="tag">AI 语文教学诊断平台 · 从一次考试到一份可执行的处方</p>

          <ul className="points">
            <li><i />成绩录入与智能清洗，八个口径一次对齐</li>
            <li><i />六维学情诊断，看得见每个学生卡在哪</li>
            <li><i />专项练习与作文升格，练什么有据可依</li>
          </ul>

          <p className="copy">© 2026 智语教育科技 · 传承文明 启迪智慧</p>
        </aside>

        {/* ── 右：表单卡 ───────────────────────────────── */}
        <main className="main">
          <div className="card">
            <div className="card-h">
              <b>{head.t}</b>
              <span>{head.d}</span>
            </div>

            <div className={'tabs' + (mode === 'register' ? ' on2' : '')}>
              <div className="knob" />
              <button
                type="button"
                className={mode !== 'register' ? 'act' : ''}
                onClick={() => switchMode('login')}
              >
                登录
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'act' : ''}
                onClick={() => switchMode('register')}
              >
                注册
              </button>
            </div>

            <form onSubmit={mode === 'reset' ? handleResetRequest : handleSubmit}>
              {mode === 'reset' && (
                <div className="note info">
                  <HelpCircle />
                  <p>
                    系统不发送邮件验证码。请填写<strong>注册时用的邮箱和姓名</strong>，提交后由管理员（老师）
                    为你重置成一个临时密码；用临时密码登录后，可在「修改密码」里换成自己的密码。
                  </p>
                </div>
              )}

              {mode === 'register' && (
                <>
                  <div className="f">
                    <label>姓名 / Name</label>
                    <input
                      type="text"
                      required
                      placeholder="请输入真实姓名"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                  <div className="f">
                    <label>身份 / Identity</label>
                    <div className="inp-wrap">
                      <select value={role} onChange={(e) => setRole(e.target.value as any)}>
                        <option value="student">学生 (Student)</option>
                        <option value="teacher">教师 (Teacher)</option>
                      </select>
                      <ChevronDown className="sel-ic" />
                    </div>
                  </div>
                  {role === 'student' && (
                    <div className="f">
                      <label>学号 / Student ID</label>
                      <input
                        type="text"
                        required
                        placeholder="请输入您的学号（如 2026001）"
                        value={studentId}
                        onChange={(e) => setStudentId(e.target.value)}
                      />
                      <p className="hint">请填写老师导入成绩时使用的学号，以便查看您的诊断报告。</p>
                    </div>
                  )}
                </>
              )}

              <div className="f">
                <label>邮箱 / Email</label>
                <input
                  type="email"
                  required
                  placeholder="example@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              {mode === 'reset' && (
                <div className="f">
                  <label>姓名 / Name</label>
                  <input
                    type="text"
                    required
                    placeholder="注册时填写的真实姓名"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <p className="hint">姓名要和注册时填的完全一致，才能通过核对。</p>
                </div>
              )}

              {mode !== 'reset' && (
                <>
                  <div className="f">
                    <label>密码 / Password</label>
                    <input
                      type="password"
                      required
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  {isLogin && (
                    <div className="right">
                      <button type="button" className="link" onClick={() => switchMode('reset')}>
                        忘记密码？
                      </button>
                    </div>
                  )}
                </>
              )}

              {resetDone && (
                <div className="note ok">
                  <CheckCircle2 />
                  <div>
                    <p><i>{resetMessage}</i></p>
                    <p style={{ marginTop: 4 }}>
                      管理员处理后会给您一个临时密码。拿到后请尽快在「修改密码」里换成自己的密码。
                    </p>
                  </div>
                </div>
              )}

              {error && (
                <div className="note err">
                  <AlertCircle />
                  <p>{error}</p>
                </div>
              )}

              {!resetDone && (
                <button type="submit" className="go" disabled={loading}>
                  {loading ? (
                    <Loader2 className="spin" />
                  ) : mode === 'reset' ? (
                    <><Send />提交申请</>
                  ) : isLogin ? (
                    <><LogIn />开启诊断</>
                  ) : (
                    <><UserPlus />创建账号</>
                  )}
                </button>
              )}

              {mode === 'reset' && (
                <button type="button" className="back" onClick={() => switchMode('login')}>
                  <ArrowLeft /> 返回登录
                </button>
              )}
            </form>

            <div className="foot">智语 SmartLexis · 数据仅用于本班教学诊断</div>
          </div>
        </main>
      </div>
    </div>
  );
}
