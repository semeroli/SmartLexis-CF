import React, { useState } from 'react';
import { KeyRound, Loader2, AlertCircle, CheckCircle2, X } from 'lucide-react';
import { apiFetch, getStoredUser, saveSession } from '../lib/api';

/**
 * 修改密码弹窗（教师端 / 学生端 / 管理后台共用）。
 *
 * 服务端在改完密码后会把这个账号的所有旧会话作废，并回一张新令牌，
 * 所以这里成功之后必须把新令牌写回本地 —— 不然当前这台设备会被自己踢下线。
 */

interface ChangePasswordModalProps {
  onClose: () => void;
}

export default function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < 6) { setError('新密码至少 6 位'); return; }
    if (newPassword !== confirmPassword) { setError('两次输入的新密码不一致'); return; }
    if (newPassword === oldPassword) { setError('新密码不能和原密码一样'); return; }

    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/change_password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error || '修改失败，请重试');
        return;
      }

      // 服务端签了新令牌：立刻换上，否则下一次请求就会 401 被打回登录页
      const current = getStoredUser();
      if (current && data?.token) saveSession(data.token, current);

      setDone(true);
    } catch (err: any) {
      setError(err?.message || '网络异常，请重试');
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-full px-5 py-3.5 bg-white border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-slate-400 text-slate-900 font-bold';

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="w-full max-w-md bg-white rounded-[32px] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-8 py-6 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-50 rounded-2xl flex items-center justify-center">
              <KeyRound className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-900">修改密码</h3>
              <p className="text-[11px] text-slate-400 font-bold">改完其它设备需要重新登录</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-700 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {done ? (
          <div className="p-8 space-y-6">
            <div className="flex items-start gap-3 p-4 bg-emerald-50 border border-emerald-100 rounded-2xl">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-emerald-800">密码已修改</p>
                <p className="text-xs text-emerald-700 mt-1 leading-relaxed">
                  您在这台设备上不用重新登录。其它已经登录过的设备（比如手机）
                  上的登录已经失效，需要重新输入新密码。
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-full py-3.5 bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all"
            >
              知道了
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-8 space-y-5">
            <div>
              <label className="block text-xs font-black text-slate-700 uppercase tracking-[0.15em] mb-2.5 ml-1">
                原密码
              </label>
              <input
                type="password"
                required
                autoFocus
                placeholder="请输入当前密码"
                className={inputCls}
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-black text-slate-700 uppercase tracking-[0.15em] mb-2.5 ml-1">
                新密码
              </label>
              <input
                type="password"
                required
                placeholder="至少 6 位"
                className={inputCls}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-black text-slate-700 uppercase tracking-[0.15em] mb-2.5 ml-1">
                再输一遍新密码
              </label>
              <input
                type="password"
                required
                placeholder="请输入新密码"
                className={inputCls}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-rose-500 bg-rose-50 p-3 rounded-xl">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <p className="text-[11px] font-bold">{error}</p>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3.5 bg-slate-100 text-slate-700 rounded-2xl font-bold hover:bg-slate-200 transition-all"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-3.5 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认修改'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
