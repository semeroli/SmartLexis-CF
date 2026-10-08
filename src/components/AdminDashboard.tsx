import React, { useState, useEffect } from 'react';
import { 
  Users, Database, Trash2, Shield, Search, 
  AlertCircle, Loader2, FileText, KeyRound, RotateCcw, Copy, Check, X, LogOut
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { apiFetch } from '../lib/api';
import { formatDay } from '../lib/utils';
import ChangePasswordModal from './ChangePasswordModal';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface AdminDashboardProps {
  onLogout: () => void;
}

export default function AdminDashboard({ onLogout }: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<'users' | 'students' | 'resets' | 'data'>('users');
  const [mockUsers, setMockUsers] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [resetRequests, setResetRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [busyId, setBusyId] = useState<any>(null);
  // 重置成功后拿到的临时密码：大字显示 + 一键复制，管理员要转发给老师
  const [issued, setIssued] = useState<{ name: string; email: string; tempPassword: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPwdModalOpen, setIsPwdModalOpen] = useState(false);

  useEffect(() => {
    loadData();
    loadStudents();
    loadResets();
  }, []);

  const loadResets = async () => {
    try {
      const res = await apiFetch('/api/admin/password_resets');
      if (res.ok) {
        const data = await res.json();
        setResetRequests(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error("Load reset requests error:", err);
    }
  };

  const loadStudents = async () => {
    try {
      // 不再传 ?is_admin=true：服务端按令牌里的角色判定，前端说了不算
      const res = await apiFetch('/api/students');
      if (res.ok) {
        const data = await res.json();
        // 确保每个学生都有 id，如果没有则尝试使用 student_id 作为后备（虽然数据库应该有 id）
        setStudents(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error("Load students error:", err);
    }
  };

  const deleteStudent = async (id: any) => {
    if (!id || id === 'undefined') {
      alert("无法删除：无效的记录ID");
      return;
    }
    if (window.confirm('确定要删除该学生成绩吗？')) {
      try {
        const res = await apiFetch(`/api/students?id=${id}`, { method: 'DELETE' });
        if (res.ok) {
          loadStudents();
        } else {
          const errData = await res.json().catch(() => ({}));
          alert(`删除失败: ${errData.error || '服务器错误'}`);
        }
      } catch (err) {
        alert("网络错误");
      }
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/admin/users');
      if (response.ok) {
        const users = await response.json();
        if (Array.isArray(users)) {
          setMockUsers(users);
        } else {
          console.error("Users response is not an array:", users);
          setMockUsers([]);
        }
      } else {
        const errorData = await response.json();
        console.error("Fetch users failed:", errorData);
      }
    } catch (error) {
      console.error("Load users error:", error);
    } finally {
      setLoading(false);
    }
  };

  const clearAllData = () => {
    if (window.confirm('确定要退出登录吗？服务端会把当前会话作废。')) {
      // 交给上层统一退出：它会在服务端把会话删掉，而不只是清浏览器本地
      onLogout();
    }
  };

  const deleteUser = async (uid: string) => {
    if (window.confirm(`确定要删除该用户吗？`)) {
      try {
        const response = await apiFetch(`/api/admin/users?uid=${uid}`, { method: 'DELETE' });
        if (response.ok) {
          loadData();
        } else {
          const err = await response.json();
          alert(`删除失败: ${err.error || '未知错误'}`);
        }
      } catch (error) {
        console.error("Delete user error:", error);
        alert("删除失败，请检查网络连接");
      }
    }
  };

  // ── 密码重置 ────────────────────────────────────────────────
  // 处理老师提交的找回申请：批准 = 生成临时密码并踢掉旧登录；忽略 = 只标记掉
  const handleResetRequest = async (row: any, dismiss = false) => {
    if (!dismiss) {
      const who = row.account_name || row.name || row.email;
      if (!window.confirm(
        `确定要为「${who}」重置密码吗？\n\n` +
        `系统会生成一个临时密码，该账号在其它设备上的登录会立即失效。`
      )) return;
    }
    setBusyId(row.id);
    try {
      const res = await apiFetch('/api/admin/password_resets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dismiss ? { requestId: row.id, dismiss: true } : { requestId: row.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data?.error || '操作失败'); return; }
      if (!dismiss && data?.tempPassword) {
        setIssued({
          name: data.name || row.account_name || row.name,
          email: data.email || row.email,
          tempPassword: data.tempPassword,
        });
        setCopied(false);
      }
      loadResets();
    } catch (e) {
      alert('网络错误，请重试');
    } finally {
      setBusyId(null);
    }
  };

  // 直接在用户列表里重置某个账号 —— 老师连注册时填的姓名都记不清时的兜底入口
  const resetUserByUid = async (u: any) => {
    if (!window.confirm(
      `确定要重置「${u.name || u.email}」的密码吗？\n\n` +
      `系统会生成一个临时密码，该账号在其它设备上的登录会立即失效。`
    )) return;
    setBusyId(u.uid);
    try {
      const res = await apiFetch('/api/admin/password_resets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: u.uid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data?.error || '操作失败'); return; }
      setIssued({ name: data.name, email: data.email, tempPassword: data.tempPassword });
      setCopied(false);
    } catch (e) {
      alert('网络错误，请重试');
    } finally {
      setBusyId(null);
    }
  };

  const deleteResetRow = async (id: number) => {
    if (!window.confirm('确定要删除这条申请记录吗？')) return;
    try {
      const res = await apiFetch(`/api/admin/password_resets?id=${id}`, { method: 'DELETE' });
      if (res.ok) loadResets();
    } catch (e) {
      alert('网络错误');
    }
  };

  const copyTemp = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {
      alert('自动复制失败，请手动选中复制：' + issued.tempPassword);
    }
  };

  const pendingResets = resetRequests.filter((r) => r.status === 'pending');

  const filteredUsers = mockUsers.filter(u => 
    (u.name || '').includes(searchTerm) || (u.email || '').includes(searchTerm)
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <div className="w-64 bg-slate-900 text-white flex flex-col">
        <div className="p-8 border-b border-slate-800">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-6 h-6 text-indigo-400" />
            <h1 className="text-xl font-serif font-bold tracking-wider">管理后台</h1>
          </div>
          <p className="text-slate-500 text-[10px] uppercase tracking-widest">System Administrator</p>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <button 
            onClick={() => setActiveTab('users')}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
              activeTab === 'users' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:bg-slate-800 hover:text-white"
            )}
          >
            <Users className="w-4 h-4" /> 用户管理
          </button>
          <button 
            onClick={() => setActiveTab('students')}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
              activeTab === 'students' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:bg-slate-800 hover:text-white"
            )}
          >
            <FileText className="w-4 h-4" /> 学生数据
          </button>
          <button 
            onClick={() => setActiveTab('resets')}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
              activeTab === 'resets' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:bg-slate-800 hover:text-white"
            )}
          >
            <KeyRound className="w-4 h-4" /> 密码重置
            {pendingResets.length > 0 && (
              <span className="ml-auto min-w-[22px] h-[22px] px-1.5 bg-rose-500 text-white text-[10px] font-black rounded-full flex items-center justify-center">
                {pendingResets.length}
              </span>
            )}
          </button>
          <button 
            onClick={() => setActiveTab('data')}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
              activeTab === 'data' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:bg-slate-800 hover:text-white"
            )}
          >
            <Database className="w-4 h-4" /> 数据维护
          </button>
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-1">
          <button 
            onClick={() => setIsPwdModalOpen(true)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-all"
          >
            <KeyRound className="w-4 h-4" /> 修改密码
          </button>
          <button 
            onClick={onLogout}
            title="退出登录"
            aria-label="退出登录"
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-rose-400 hover:bg-rose-500/10 transition-all"
          >
            <LogOut className="w-4 h-4" /> 退出登录
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-20 bg-white border-b border-slate-200 px-8 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">
            {activeTab === 'users' ? '注册用户列表' : activeTab === 'students' ? '全系统学生成绩' : activeTab === 'resets' ? '密码重置' : '数据维护'}
          </h2>
          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input 
                type="text" 
                placeholder={activeTab === 'students' ? "搜索学生..." : "搜索用户..."}
                className="pl-10 pr-4 py-2 bg-slate-100 border-transparent rounded-full text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500/20 transition-all w-64"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-8">
          {activeTab === 'users' ? (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">姓名</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">邮箱</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">身份</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">注册时间</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {filteredUsers.map((u) => (
                      <tr key={u.uid} className="hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 font-bold text-xs">
                              {(u.name || 'U')[0]}
                            </div>
                            <span className="text-sm font-bold text-slate-700">{u.name || '未知用户'}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-500">{u.email}</td>
                        <td className="px-6 py-4">
                          <span className={cn(
                            "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider",
                            u.role === 'teacher' ? "bg-emerald-50 text-emerald-600" : 
                            u.role === 'admin' ? "bg-purple-50 text-purple-600" : "bg-blue-50 text-blue-600"
                          )}>
                            {u.role === 'teacher' ? '教师' : u.role === 'admin' ? '管理员' : '学生'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs text-slate-400">
                          {u.createdAt ? formatDay(u.createdAt) : '未知'}
                        </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button 
                            onClick={() => resetUserByUid(u)}
                            disabled={busyId === u.uid}
                            title="重置密码"
                            aria-label="重置密码"
                            className="p-2 text-slate-400 hover:text-indigo-600 transition-colors disabled:opacity-40"
                          >
                            {busyId === u.uid ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                          </button>
                          <button 
                            onClick={() => deleteUser(u.uid)}
                            title="删除账号"
                            aria-label="删除账号"
                            className="p-2 text-slate-400 hover:text-rose-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredUsers.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-slate-400 italic text-sm">
                        未找到匹配的用户
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : activeTab === 'students' ? (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">学号</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">姓名</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">总分</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">导入教师</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {students.filter(s => (s.name || '').includes(searchTerm) || (s.student_id || '').includes(searchTerm)).map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-6 py-4 text-sm font-mono text-slate-500">{s.student_id || 'N/A'}</td>
                      <td className="px-6 py-4 text-sm font-bold text-slate-700">{s.name}</td>
                      <td className="px-6 py-4 text-sm font-black text-indigo-600">{s.total}</td>
                      <td className="px-6 py-4 text-xs text-slate-400">{s.teacher_id || '未知'}</td>
                      <td className="px-6 py-4 text-right">
                        <button 
                          onClick={() => deleteStudent(s.id)}
                          className="p-2 text-slate-400 hover:text-rose-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {students.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-slate-400 italic text-sm">
                        暂无学生数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : activeTab === 'resets' ? (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-100 flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-black text-slate-800">老师提交的找回密码申请</h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    老师在登录页点「忘记密码」提交后会出现在这里。点「重置」生成一个临时密码，
                    把密码转发给老师即可；老师登录后可以自己改掉。
                  </p>
                </div>
                <button
                  onClick={loadResets}
                  className="shrink-0 flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> 刷新
                </button>
              </div>

              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">姓名</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">邮箱</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">身份</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">申请时间</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">状态</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {resetRequests.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 font-bold text-xs">
                            {((r.account_name || r.name || 'U')[0])}
                          </div>
                          <span className="text-sm font-bold text-slate-700">{r.account_name || r.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-500">{r.email}</td>
                      <td className="px-6 py-4">
                        <span className={cn(
                          "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider",
                          r.role === 'teacher' ? "bg-emerald-50 text-emerald-600"
                            : r.role === 'admin' ? "bg-purple-50 text-purple-600"
                            : r.role === 'student' ? "bg-blue-50 text-blue-600"
                            : "bg-slate-100 text-slate-500"
                        )}>
                          {r.role === 'teacher' ? '教师' : r.role === 'admin' ? '管理员' : r.role === 'student' ? '学生' : '账号已删除'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-xs text-slate-400">{formatDay(r.created_at)}</td>
                      <td className="px-6 py-4">
                        <span className={cn(
                          "px-2 py-1 rounded-md text-[10px] font-bold",
                          r.status === 'pending' ? "bg-amber-50 text-amber-600"
                            : r.status === 'done' ? "bg-emerald-50 text-emerald-600"
                            : "bg-slate-100 text-slate-500"
                        )}>
                          {r.status === 'pending' ? '待处理' : r.status === 'done' ? '已重置' : '已忽略'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        {r.status === 'pending' ? (
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleResetRequest(r)}
                              disabled={busyId === r.id}
                              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center gap-1.5"
                            >
                              {busyId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                              重置
                            </button>
                            <button
                              onClick={() => handleResetRequest(r, true)}
                              disabled={busyId === r.id}
                              className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all disabled:opacity-50"
                            >
                              忽略
                            </button>
                          </div>
                        ) : r.status === 'done' && r.temp_password ? (
                          <div className="flex items-center justify-end gap-2">
                            <code className="px-3 py-1.5 bg-slate-100 rounded-lg text-xs font-black text-slate-700 tracking-wider">{r.temp_password}</code>
                            <button
                              onClick={() => navigator.clipboard.writeText(r.temp_password).catch(() => alert('请手动复制：' + r.temp_password))}
                              title="复制临时密码"
                              aria-label="复制临时密码"
                              className="p-2 text-slate-400 hover:text-indigo-600 transition-colors"
                            >
                              <Copy className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => deleteResetRow(r.id)}
                            title="删除记录"
                            aria-label="删除记录"
                            className="p-2 text-slate-400 hover:text-rose-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {resetRequests.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-400 italic text-sm">
                        目前没有找回密码的申请
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="max-w-2xl space-y-6">
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                {/* 这里原来写的是「危险区域 · 清除系统中的所有持久化数据」，
                    但按钮实际只调用了 onLogout（退出登录）。文案和动作完全对不上 ——
                    既吓人又误导，现在改成如实描述。 */}
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-500">
                    <LogOut className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-800">退出登录</h3>
                    <p className="text-sm text-slate-500">结束当前会话，需要重新输入邮箱和密码</p>
                  </div>
                </div>
                
                <div className="space-y-4">
                  <div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-slate-600 leading-relaxed">
                      只是退出<strong>当前这台设备</strong>的登录状态，<strong>不会删除任何用户、成绩或作文记录</strong>。
                    </p>
                  </div>
                  
                  <button 
                    onClick={clearAllData}
                    className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all flex items-center justify-center gap-2"
                  >
                    <LogOut className="w-4 h-4" /> 退出登录
                  </button>
                </div>
              </div>

              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-4">系统状态</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">总用户数</p>
                    <p className="text-2xl font-black text-slate-800">{mockUsers.length}</p>
                  </div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">系统版本</p>
                    <p className="text-2xl font-black text-slate-800">v1.2.0</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* 临时密码浮层：管理员要把它转发给老师，所以字做大、给一键复制 */}
      {issued && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white rounded-[32px] shadow-2xl overflow-hidden">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 bg-emerald-50 rounded-2xl flex items-center justify-center shrink-0">
                  <KeyRound className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-black text-slate-900">临时密码已生成</h3>
                  <p className="text-[11px] text-slate-400 font-bold truncate">{issued.name} · {issued.email}</p>
                </div>
              </div>
              <button onClick={() => setIssued(null)} className="p-2 text-slate-400 hover:text-slate-700 transition-colors shrink-0" aria-label="关闭">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-8 space-y-5">
              <div className="flex items-center gap-3 p-5 bg-slate-900 rounded-2xl">
                <code className="flex-1 text-2xl font-black text-white tracking-[0.2em] text-center select-all">{issued.tempPassword}</code>
                <button
                  onClick={copyTemp}
                  title="复制临时密码"
                  aria-label="复制临时密码"
                  className="p-3 bg-white/10 text-white rounded-xl hover:bg-white/20 transition-colors shrink-0"
                >
                  {copied ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5" />}
                </button>
              </div>

              <div className="p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 leading-relaxed">
                  请把这个临时密码发给 <strong>{issued.name}</strong>。该账号在其它设备上的登录已经失效，
                  需要重新登录。建议提醒他登录后到「修改密码」里换成自己的密码。
                </p>
              </div>

              <button
                onClick={() => setIssued(null)}
                className="w-full py-3.5 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all"
              >
                我已记下，关闭
              </button>
              <p className="text-[11px] text-slate-400 text-center leading-relaxed">
                关闭后仍可在「密码重置」页签里看到这个临时密码。
              </p>
            </div>
          </div>
        </div>
      )}

      {isPwdModalOpen && <ChangePasswordModal onClose={() => setIsPwdModalOpen(false)} />}
    </div>
  );
}
