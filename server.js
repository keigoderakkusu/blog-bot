require("dotenv").config();
const express    = require("express");
const bodyParser = require("body-parser");
const cron       = require("node-cron");
const fetch      = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

const app = express();
app.use(bodyParser.json());

const {
  GEMINI_API_KEY: GEMINI_KEY,
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  TELEGRAM_ALLOWED_USER_ID,
  WP_SITE_URL: WP_URL,
  WP_USERNAME: WP_USER,
  WP_APP_PASSWORD: WP_PASS,
  PORT = 3000,
} = process.env;
const ALLOWED_ID = Number(TELEGRAM_ALLOWED_USER_ID);

const jobs = new Map();
let jobSeq = 1;

const templates = new Map([
  ["default", { name:"default", persona:"プロのWEBライター兼マーケター",   tone:"丁寧でわかりやすい",    wordCount:"1500〜2000" }],
  ["tech",    { name:"tech",    persona:"IT専門のテクニカルライター",        tone:"論理的で専門的",        wordCount:"1500〜2000" }],
  ["finance", { name:"finance", persona:"投資・資産運用の専門家",            tone:"信頼感のある客観的口調", wordCount:"1500〜2000" }],
  ["travel",  { name:"travel",  persona:"国内旅行・観光ライター",            tone:"親しみやすい旅行者目線", wordCount:"1200〜1800" }],
]);

function buildPrompt(keyword, tmplName = "default") {
  const t = templates.get(tmplName) || templates.get("default");
  return `あなたは${t.persona}です。
以下の【キーワード】をテーマに、読者の悩みを解決する魅力的で高品質なブログ記事を作成してください。

【キーワード】: ${keyword}

【執筆のルール】
1. 出力形式: 1行目に「タイトル」、2行目から「HTML形式の本文」を出力してください（Markdownは使用しないでください）。
2. 構成: 「導入」→「見出し（<h2>）2〜3つ」→「まとめ」の構成にすること。
3. HTMLタグ: 見出しは <h2> と <h3> を使い、本文は <p> で囲んでください。重要な箇所は <strong> で強調してください。
4. トーン: ${t.tone}で書くこと。
5. 文字数: ${t.wordCount}文字程度。

それでは、上記のルールに従って出力をお願いします。`;
}

async function generateArticle(keyword, tmplName = "default") {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildPrompt(keyword, tmplName) }] }] }),
    }
  );
  const data  = await res.json();
  const raw   = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const lines = raw.split("\n");
  return {
    title:   lines[0].replace(/^#+\s*/, "").trim(),
    content: lines.slice(1).join("\n").trim(),
  };
}

async function postToWordPress(title, content, status = "draft") {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ title, content, status }),
  });
  return res.json();
}

async function createJobAndNotify(keyword, tmplName, chatId, scheduledAt = null) {
  const id  = `job_${jobSeq++}`;
  const job = {
    id, keyword, template: tmplName,
    status: scheduledAt ? "scheduled" : "pending",
    title: null, content: null,
    createdAt: new Date().toISOString(),
    scheduledAt, chatId,
  };
  jobs.set(id, job);

  generateArticle(keyword, tmplName).then(async ({ title, content }) => {
    job.title   = title;
    job.content = content;
    if (scheduledAt) {
      await tgSend(chatId, `📅 スケジュール登録完了\nID: \`${id}\`\n📄 ${title}\n⏰ ${scheduledAt}\n\n承認: /approve ${id}`);
      return;
    }
    await tgSend(chatId,
      `✅ 記事を生成しました！\n\nID: \`${id}\`\n📄 ${title}\n\n▶ 公開: /approve ${id}\n▶ 下書き: /draft ${id}\n▶ 破棄: /reject ${id}\n▶ 確認: /preview ${id}`
    );
  }).catch(async (e) => {
    job.status = "error";
    await tgSend(chatId, `❌ 生成エラー [${id}]: ${e.message}`);
  });

  return id;
}

app.get("/health", (_req, res) => res.json({ ok: true, jobs: jobs.size, templates: templates.size }));
app.get("/templates", (_req, res) => res.json([...templates.values()]));

app.post("/templates", (req, res) => {
  const { name, persona, tone = "丁寧でわかりやすい", wordCount = "1500〜2000" } = req.body;
  if (!name || !persona) return res.status(400).json({ error: "name と persona が必要です" });
  templates.set(name, { name, persona, tone, wordCount, createdAt: new Date().toISOString() });
  res.json({ ok: true, template: templates.get(name) });
});

app.delete("/templates/:name", (req, res) => {
  if (req.params.name === "default") return res.status(400).json({ error: "defaultは削除不可です" });
  templates.delete(req.params.name);
  res.json({ ok: true });
});

app.post("/generate", async (req, res) => {
  const { keyword, template = "default", chatId = ALLOWED_ID, autoPublish = false } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword が必要です" });
  try {
    if (autoPublish) {
      const { title, content } = await generateArticle(keyword, template);
      const wp = await postToWordPress(title, content, "publish");
      return res.json({ ok: true, title, postId: wp.id, link: wp.link });
    }
    const id = await createJobAndNotify(keyword, template, Number(chatId));
    res.json({ ok: true, jobId: id, message: "生成中。Telegramに通知します。" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/schedule", async (req, res) => {
  const { keyword, template = "default", scheduledAt, chatId = ALLOWED_ID } = req.body;
  if (!keyword || !scheduledAt) return res.status(400).json({ error: "keyword と scheduledAt が必要です" });
  const id = await createJobAndNotify(keyword, template, Number(chatId), scheduledAt);
  res.json({ ok: true, jobId: id, scheduledAt });
});

app.get("/jobs", (_req, res) =>
  res.json([...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
);

app.post("/jobs/:id/approve", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.title) return res.status(404).json({ error: "ジョブが見つかりません" });
  try {
    const wp = await postToWordPress(job.title, job.content, "publish");
    job.status = "published";
    res.json({ ok: true, link: wp.link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/jobs/:id/draft", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.title) return res.status(404).json({ error: "ジョブが見つかりません" });
  try {
    const wp = await postToWordPress(job.title, job.content, "draft");
    job.status = "approved";
    res.json({ ok: true, postId: wp.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/jobs/:id/reject", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "ジョブが見つかりません" });
  job.status = "rejected";
  res.json({ ok: true });
});

cron.schedule("* * * * *", async () => {
  const now = new Date();
  for (const job of jobs.values()) {
    if (job.status !== "scheduled" || !job.scheduledAt || !job.title) continue;
    if (new Date(job.scheduledAt) > now) continue;
    try {
      const wp = await postToWordPress(job.title, job.content, "publish");
      job.status = "published";
      await tgSend(job.chatId, `🚀 スケジュール投稿完了！\n📄 ${job.title}\n🔗 ${wp.link}`);
    } catch (e) {
      await tgSend(job.chatId, `❌ スケジュール投稿エラー [${job.id}]: ${e.message}`);
    }
  }
});

const HELP_TEXT = `📝 *ブログ自動生成Bot v2*

*生成（承認フロー）*
/write キーワード
/write\\_as テンプレ名 キーワード

*スケジュール投稿*
/schedule 2025-08-01T09:00 テンプレ名 キーワード

*承認操作*
/approve ID → 公開
/draft ID → 下書き保存
/reject ID → 破棄
/preview ID → 内容確認

*管理*
/jobs → 直近10件
/templates → テンプレ一覧
/add\\_template 名前|ペルソナ|トーン|文字数`;

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text   = (msg.text || "").trim();

  if (userId !== ALLOWED_ID) { await tgSend(chatId, "⛔ プライベートBotです"); return; }
  if (["/start", "/help"].includes(text)) { await tgSend(chatId, HELP_TEXT); return; }

  if (text === "/templates") {
    const list = [...templates.values()].map(t => `• *${t.name}* — ${t.persona}`).join("\n");
    await tgSend(chatId, `📋 テンプレート一覧:\n${list}`);
    return;
  }
  if (text.startsWith("/add_template ")) {
    const [name, persona, tone = "丁寧でわかりやすい", wordCount = "1500〜2000"] =
      text.replace("/add_template ", "").split("|");
    if (!persona) { await tgSend(chatId, "⚠️ 書式: /add_template 名前|ペルソナ|トーン|文字数"); return; }
    templates.set(name.trim(), { name: name.trim(), persona, tone, wordCount, createdAt: new Date().toISOString() });
    await tgSend(chatId, `✅ テンプレート「${name.trim()}」を保存しました`);
    return;
  }
  if (text === "/jobs") {
    const list = [...jobs.values()].slice(-10).reverse()
      .map(j => `• \`${j.id}\` [${j.status}] ${j.title || j.keyword}`).join("\n");
    await tgSend(chatId, list ? `📋 直近10件:\n${list}` : "ジョブはありません");
    return;
  }
  if (text.startsWith("/preview ")) {
    const job = jobs.get(text.replace("/preview ", "").trim());
    if (!job) { await tgSend(chatId, "❌ 見つかりません"); return; }
    const preview = (job.content || "生成中...").replace(/<[^>]+>/g, "").slice(0, 500);
    await tgSend(chatId, `📄 *${job.title || "（生成中）"}*\n\n${preview}...`);
    return;
  }
  if (text.startsWith("/approve ")) {
    const job = jobs.get(text.replace("/approve ", "").trim());
    if (!job?.title) { await tgSend(chatId, "❌ 見つかりません（まだ生成中かも）"); return; }
    try {
      const wp = await postToWordPress(job.title, job.content, "publish");
      job.status = "published";
      await tgSend(chatId, `🚀 公開しました！\n📄 ${job.title}\n🔗 ${wp.link}`);
    } catch (e) { await tgSend(chatId, `❌ ${e.message}`); }
    return;
  }
  if (text.startsWith("/draft ")) {
    const job = jobs.get(text.replace("/draft ", "").trim());
    if (!job?.title) { await tgSend(chatId, "❌ 見つかりません"); return; }
    try {
      const wp = await postToWordPress(job.title, job.content, "draft");
      job.status = "approved";
      await tgSend(chatId, `📝 下書き保存しました（WP ID: ${wp.id}）`);
    } catch (e) { await tgSend(chatId, `❌ ${e.message}`); }
    return;
  }
  if (text.startsWith("/reject ")) {
    const id = text.replace("/reject ", "").trim();
    if (!jobs.has(id)) { await tgSend(chatId, "❌ 見つかりません"); return; }
    jobs.get(id).status = "rejected";
    await tgSend(chatId, `🗑 ジョブ ${id} を破棄しました`);
    return;
  }
  if (text.startsWith("/write_as ")) {
    const parts   = text.replace("/write_as ", "").split(" ");
    const tmpl    = parts[0];
    const keyword = parts.slice(1).join(" ");
    if (!keyword || !templates.has(tmpl)) {
      await tgSend(chatId, `⚠️ 書式: /write_as テンプレ名 キーワード\nテンプレ一覧: /templates`);
      return;
    }
    await tgSend(chatId, `⏳ [${tmpl}] で「${keyword}」を生成中...`);
    const id = await createJobAndNotify(keyword, tmpl, chatId);
    await tgSend(chatId, `🆔 ジョブID: \`${id}\``);
    return;
  }
  if (text.startsWith("/write ")) {
    const keyword = text.replace("/write ", "").trim();
    await tgSend(chatId, `⏳ 「${keyword}」を生成中...`);
    const id = await createJobAndNotify(keyword, "default", chatId);
    await tgSend(chatId, `🆔 ジョブID: \`${id}\``);
    return;
  }
  if (text.startsWith("/schedule ")) {
    const parts   = text.replace("/schedule ", "").split(" ");
    const dateStr = parts[0];
    const tmpl    = parts[1] || "default";
    const keyword = parts.slice(2).join(" ");
    if (!keyword || !dateStr) {
      await tgSend(chatId, "⚠️ 書式: /schedule 2025-08-01T09:00 テンプレ名 キーワード");
      return;
    }
    const scheduledAt = new Date(dateStr + ":00+09:00").toISOString();
    const id = await createJobAndNotify(keyword, tmpl, chatId, scheduledAt);
    await tgSend(chatId, `📅 スケジュール登録！\nID: \`${id}\`\n⏰ ${dateStr}（JST）に自動公開`);
    return;
  }
  await tgSend(chatId, "❓ /help でコマンド一覧を確認してください");
});

async function tgSend(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  }).catch(console.error);
}

app.listen(PORT, () => console.log(`🚀 ブログ自動化サーバー v2 起動: port ${PORT}`));
