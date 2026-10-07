import React, { useState } from 'react';
import { LogIn, UserPlus, Sparkles, Loader2, AlertCircle } from 'lucide-react';
import { saveSession } from '../lib/api';

interface AuthProps {
  onAuthSuccess: (user: any) => void;
}

export default function Auth({ onAuthSuccess }: AuthProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [studentId, setStudentId] = useState('');
  const [role, setRole] = useState<'teacher' | 'student'>('student');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-slate-900">
      {/* 高清背景图 */}
      <img 
        src="https://imagebed.eu.cc/file/1773269643566_freenaturestock-1932.jpg"
        alt="Background"
        className="absolute inset-0 w-full h-full object-cover z-0"
        referrerPolicy="no-referrer"
      />
      
      {/* 柔和的叠加层，确保文字可读性但不遮挡高清感 */}
      <div className="absolute inset-0 z-[1] bg-black/10 backdrop-brightness-95" />

      <div className="max-w-md w-full bg-white/60 backdrop-blur-2xl rounded-[40px] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.3)] border border-white/30 overflow-hidden relative z-10 animate-in zoom-in-95 duration-700">
        <div className="bg-slate-900/95 p-12 text-center text-white relative overflow-hidden">
          {/* 动态背景装饰 */}
          <div className="absolute inset-0 opacity-10">
            <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              <path d="M0 100 C 20 80, 40 90, 60 70 S 80 80, 100 60 L 100 100 Z" fill="white" />
            </svg>
          </div>

          {/* 红色印章 - 更加精致 */}
          <div className="absolute top-6 right-6 w-10 h-10 border-[3px] border-[#C0392B] flex items-center justify-center text-[#C0392B] font-serif text-[11px] font-bold leading-none rotate-6 bg-white/10 shadow-[0_0_15px_rgba(192,57,43,0.3)] select-none">
            智<br/>语
          </div>
          
          <div className="w-24 h-24 bg-white/10 rounded-full flex items-center justify-center mx-auto mb-8 backdrop-blur-md border border-white/20 shadow-2xl relative group">
            <div className="absolute inset-0 bg-indigo-500/20 rounded-full blur-xl group-hover:bg-indigo-500/40 transition-all" />
            <Sparkles className="w-12 h-12 text-indigo-200 relative z-10" />
          </div>
          
          <h1 className="text-4xl font-serif font-bold tracking-[0.2em] mb-3 drop-shadow-lg">智语 · SmartLexis</h1>
          <div className="h-0.5 w-16 bg-gradient-to-r from-transparent via-indigo-400 to-transparent mx-auto mb-4" />
          <p className="text-indigo-100/70 text-sm font-light tracking-[0.15em] italic">博观而约取 · 厚积而薄发</p>
        </div>

        <div className="p-12">
          <div className="flex gap-6 mb-10 relative">
            <button 
              onClick={() => setIsLogin(true)}
              className={`flex-1 py-3 text-sm font-bold rounded-2xl transition-all relative z-10 ${isLogin ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
            >
              登录
              {isLogin && <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-indigo-600 rounded-full" />}
            </button>
            <button 
              onClick={() => setIsLogin(false)}
              className={`flex-1 py-3 text-sm font-bold rounded-2xl transition-all relative z-10 ${!isLogin ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
            >
              注册
              {!isLogin && <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 bg-indigo-600 rounded-full" />}
            </button>
            <div 
              className={`absolute top-0 h-full w-1/2 bg-indigo-50/50 rounded-2xl transition-transform duration-300 ease-out ${isLogin ? 'translate-x-0' : 'translate-x-full'}`}
            />
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {!isLogin && (
              <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-2">
                <div className="col-span-2">
                  <label className="block text-xs font-black text-slate-700 uppercase tracking-[0.15em] mb-2.5 ml-1">姓名 / Name</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="请输入真实姓名"
                    className="w-full px-5 py-3.5 bg-white/80 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-slate-400 text-slate-900 font-bold"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-black text-slate-700 uppercase tracking-[0.15em] mb-2.5 ml-1">身份 / Identity</label>
                  <select 
                    className="w-full px-5 py-3.5 bg-white/80 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all appearance-none cursor-pointer text-slate-900 font-bold"
                    value={role}
                    onChange={(e) => setRole(e.target.value as any)}
                  >
                    <option value="student">学生 (Student)</option>
                    <option value="teacher">教师 (Teacher)</option>
                  </select>
                </div>
                {role === 'student' && (
                  <div className="col-span-2 animate-in fade-in slide-in-from-top-2">
                    <label className="block text-xs font-black text-slate-700 uppercase tracking-[0.15em] mb-2.5 ml-1">学号 / Student ID</label>
                    <input 
                      type="text" 
                      required 
                      placeholder="请输入您的学号 (如: 2026001)"
                      className="w-full px-5 py-3.5 bg-white/80 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-slate-400 text-slate-900 font-bold"
                      value={studentId}
                      onChange={(e) => setStudentId(e.target.value)}
                    />
                    <p className="mt-2 ml-1 text-[10px] text-slate-500 font-bold leading-relaxed">请填写老师导入成绩时使用的学号，以便查看您的诊断报告。</p>
                  </div>
                )}
              </div>
            )}
            <div>
              <label className="block text-xs font-black text-slate-700 uppercase tracking-[0.15em] mb-2.5 ml-1">邮箱 / Email</label>
              <input 
                type="email" 
                required 
                placeholder="example@email.com"
                className="w-full px-5 py-3.5 bg-white/80 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-slate-400 text-slate-900 font-bold"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-black text-slate-700 uppercase tracking-[0.15em] mb-2.5 ml-1">密码 / Password</label>
              <input 
                type="password" 
                required 
                placeholder="••••••••"
                className="w-full px-5 py-3.5 bg-white/80 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-slate-400 text-slate-900 font-bold"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-rose-500 bg-rose-50 p-3 rounded-xl animate-in shake-in">
                <AlertCircle className="w-4 h-4" />
                <p className="text-[10px] font-bold">{error}</p>
              </div>
            )}

            <button 
              type="submit" 
              disabled={loading}
              className="w-full py-4 bg-[#1E293B] text-white rounded-2xl font-bold hover:bg-slate-800 transition-all flex items-center justify-center gap-3 shadow-xl shadow-slate-200 disabled:opacity-50 group"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : isLogin ? (
                <>
                  <LogIn className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  <span className="tracking-[0.3em]">开启诊断</span>
                </>
              ) : (
                <>
                  <UserPlus className="w-5 h-5 group-hover:scale-110 transition-transform" />
                  <span className="tracking-[0.3em]">创建卷宗</span>
                </>
              )}
            </button>
          </form>
          
          <div className="mt-8 text-center">
            <p className="text-[10px] text-slate-400 font-medium">
              © 2026 智语教育科技 · 传承文明 启迪智慧
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
