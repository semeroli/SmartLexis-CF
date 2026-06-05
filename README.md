# 智语 SmartLexis

AI 语文教育诊断平台，基于 Cloudflare Pages + Functions 部署，使用 ModelScope GLM / Qwen VL 进行学情分析和作文阅卷，Gemini 提供 TTS 语音朗读。

## 功能特性

- 📊 班级学情看板（成绩导入、分数段分布、题型得分率）
- 🤖 AI 智能学习处方（基于 ModelScope GLM-5.1）
- 📝 AI 作文深度诊断（手写图片识别 + 多维度评分，基于 Qwen3-VL-8B）
- 🔊 范文 TTS 语音朗读（基于 Gemini 2.5 Flash TTS）
- 📖 范文升格赏析（AI 生成升格版范文 + 金句推荐）
- 📚 作文素材库（收藏金句，按主题筛选）
- 📈 成长曲线（历次考试成绩趋势图）

## 环境变量配置

在 Cloudflare Pages 控制台的 **Settings → Environment Variables** 中配置以下变量：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `GEMINI_API_KEY` | ✅ | Gemini API Key，用于 TTS 语音合成，[点击获取](https://ai.google.dev/) |
| `MODELSCOPE_API_KEY` | ✅ | ModelScope API Key，用于学情分析和范文升格，[点击获取](https://modelscope.cn/) |
| `AGNES_API_KEY` | ✅ | agnes-ai API Key，用于作文图片识别阅卷，[点击获取](https://agnes-ai.com/) |
| `APP_URL` | ❌ | 自动注入，无需手动填写 |

> `MODELSCOPE_API_KEY` 支持多 Key 轮询，用英文逗号分隔：`key1,key2,key3`

## D1 数据库建表

在 Cloudflare D1 控制台中执行以下 SQL 建表：

```sql
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  password TEXT,
  name TEXT,
  role TEXT,
  createdAt TEXT
);

-- 学生成绩表
CREATE TABLE IF NOT EXISTS student_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT,
  teacher_id TEXT,
  name TEXT,
  choice INTEGER,
  modern_reading INTEGER,
  classic_reading INTEGER,
  non_linear INTEGER,
  dictation INTEGER,
  composition INTEGER,
  total INTEGER,
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 成绩历史表（用于成长曲线）
CREATE TABLE IF NOT EXISTS score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT,
  teacher_id TEXT,
  choice INTEGER,
  modern_reading INTEGER,
  classic_reading INTEGER,
  non_linear INTEGER,
  dictation INTEGER,
  composition INTEGER,
  total INTEGER,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 作文阅卷记录表
CREATE TABLE IF NOT EXISTS writing_records (
  id TEXT PRIMARY KEY,
  studentId TEXT,
  teacherId TEXT,
  title TEXT,
  essay_text TEXT,
  analysis_json TEXT,
  date TEXT
);

-- 作文素材库表
CREATE TABLE IF NOT EXISTS writing_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT,
  content TEXT,
  theme TEXT,
  source_title TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
```

然后在 `wrangler.toml` 中绑定 D1 数据库：

```toml
[[d1_databases]]
binding = "DB"
database_name = "your-d1-db-name"
database_id = "your-d1-db-id"
```

## 本地开发

```bash
npm install
# 在 .env.local 中填写 GEMINI_API_KEY 和 MODELSCOPE_API_KEY
npm run dev
```

## 部署

直接 Push 到 `main` 分支，Cloudflare Pages 自动构建部署。

---

© 2026 智语教育科技 · 传承文明 启迪智慧
