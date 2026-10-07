import React, { useState, useEffect } from 'react';
import { 
  Users, Database, Trash2, Shield, Search, 
  History, AlertCircle, CheckCircle2, Loader2,
  FileText, Trash
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { apiFetch } from '../lib/api';
import { formatDay } from '../lib/utils';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface AdminDashboardProps {
  onLogout: () => void;
}

export default function AdminDashboard({ onLogout }: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<'users' | 'students' | 'data'>('users');
  const [mockUsers, setMockUsers] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadData();
    loadStudents();
  }, []);

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
            onClick={() => setActiveTab('data')}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
              activeTab === 'data' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:bg-slate-800 hover:text-white"
            )}
          >
            <Database className="w-4 h-4" /> 数据维护
          </button>
        </nav>

        <div className="p-4 border-t border-slate-800">
          <button 
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-rose-400 hover:bg-rose-500/10 transition-all"
          >
            <History className="w-4 h-4" /> 退出登录
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-20 bg-white border-b border-slate-200 px-8 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">
            {activeTab === 'users' ? '注册用户列表' : activeTab === 'students' ? '全系统学生成绩' : '系统数据维护'}
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
                        <button 
                          onClick={() => deleteUser(u.uid)}
                          className="p-2 text-slate-400 hover:text-rose-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
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
          ) : (
            <div className="max-w-2xl space-y-6">
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-12 h-12 bg-rose-50 rounded-2xl flex items-center justify-center text-rose-500">
                    <Trash2 className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-800">危险区域</h3>
                    <p className="text-sm text-slate-500">清除系统中的所有持久化数据</p>
                  </div>
                </div>
                
                <div className="space-y-4">
                  <div className="p-4 bg-rose-50 border border-rose-100 rounded-2xl flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-rose-700 leading-relaxed">
                      警告：此操作将永久删除所有本地存储的用户账户、作文诊断历史和系统配置。操作不可撤销，请谨慎操作。
                    </p>
                  </div>
                  
                  <button 
                    onClick={clearAllData}
                    className="w-full py-4 bg-rose-500 text-white rounded-2xl font-bold hover:bg-rose-600 transition-all flex items-center justify-center gap-2 shadow-lg shadow-rose-200"
                  >
                    <Trash className="w-4 h-4" /> 清除所有本地数据
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
    </div>
  );
}
