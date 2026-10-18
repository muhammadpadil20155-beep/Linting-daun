// api/_lib.js — helper bersama (awalan _ = bukan endpoint). Token HANYA dibaca dari Environment Variables Vercel.
const crypto = require("crypto");
const GH = process.env.GITHUB_TOKEN, OWNER = process.env.GITHUB_OWNER, VT = process.env.VC_TOKEN, TEAM = process.env.VC_TEAM_ID;
const LOG_REPO = process.env.LOG_REPO || (OWNER + "/secretly-logs"), LOG_BRANCH = process.env.LOG_BRANCH || "";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch dengan percobaan ulang otomatis untuk error sementara (jaringan, 429, 5xx)
async function http(url, opt, tries = 3) {
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetch(url, opt); } catch (e) { if (i >= tries - 1) throw e; await sleep(600 * (i + 1)); continue; }
    if ((r.status >= 500 || r.status === 429) && i < tries - 1) { await sleep(800 * (i + 1)); continue; }
    return r;
  }
}
const gh = (path, method = "GET", body) => http("https://api.github.com" + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { Authorization: "Bearer " + GH, Accept: "application/vnd.github+json", "User-Agent": "secretly-bot", ...(body ? { "Content-Type": "application/json" } : {}) } });
const vc = (path, method = "GET", body) => http("https://api.vercel.com" + path + (TEAM ? (path.includes("?") ? "&" : "?") + "teamId=" + TEAM : ""), {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { Authorization: "Bearer " + VT, ...(body ? { "Content-Type": "application/json" } : {}) } });
async function J(r, label) {
  if (!r.ok) { let m = ""; try { m = (await r.json()); m = (m.message || (m.error && m.error.message) || ""); } catch (e) {} throw Object.assign(new Error(label + ": " + (m || "HTTP " + r.status)), { status: r.status }); }
  return r.json();
}
const ipHash = req => crypto.createHash("sha256").update((process.env.LOG_SALT || "s") + String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()).digest("hex").slice(0, 12);
const day = () => new Date().toISOString().slice(0, 10);
const q = LOG_BRANCH ? "?ref=" + LOG_BRANCH : "";

async function ensureLogTarget() {
  let r = await gh("/repos/" + LOG_REPO);
  if (r.status === 404) {
    r = await gh("/user/repos", "POST", { name: LOG_REPO.split("/")[1], private: true, auto_init: true, description: "Log aktivitas Secretly" });
    if (!r.ok) return false; await sleep(1500);
  }
  if (LOG_BRANCH && (await gh(`/repos/${LOG_REPO}/git/ref/heads/${LOG_BRANCH}`)).status === 404) {
    const repo = await (await gh("/repos/" + LOG_REPO)).json();
    const base = await (await gh(`/repos/${LOG_REPO}/git/ref/heads/${repo.default_branch}`)).json();
    if (!(await gh(`/repos/${LOG_REPO}/git/refs`, "POST", { ref: "refs/heads/" + LOG_BRANCH, sha: base.object.sha })).ok) return false;
  }
  return true;
}
// Tambah satu baris JSON ke logs/YYYY-MM-DD.jsonl di repo log. Tidak pernah melempar error.
async function log(entry) {
  try {
    if (!GH || !OWNER) return false;
    const path = `logs/${day()}.jsonl`, line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n";
    for (let i = 0; i < 4; i++) {
      let r = await gh(`/repos/${LOG_REPO}/contents/${path}${q}`);
      if (r.status === 404) { if (!(await ensureLogTarget())) return false; r = await gh(`/repos/${LOG_REPO}/contents/${path}${q}`); }
      let sha, old = "";
      if (r.ok) { const j = await r.json(); sha = j.sha; old = Buffer.from(j.content, "base64").toString("utf8"); }
      const p = await gh(`/repos/${LOG_REPO}/contents/${path}`, "PUT", { message: "log " + entry.ev, content: Buffer.from(old + line).toString("base64"), sha, ...(LOG_BRANCH ? { branch: LOG_BRANCH } : {}) });
      if (p.ok) return true;
      if (p.status !== 409 && p.status !== 422) return false;
      await sleep(300 + Math.random() * 500);
    }
  } catch (e) { console.error("log gagal:", e.message); }
  return false;
}
// jumlah deploy hari ini (semua / dari ip ini), dibaca dari file log
async function usage(ip, ev = "deploy_start") {
  try {
    const r = await gh(`/repos/${LOG_REPO}/contents/logs/${day()}.jsonl${q}`);
    if (!r.ok) return { all: 0, mine: 0 };
    let all = 0, mine = 0;
    for (const l of Buffer.from((await r.json()).content, "base64").toString("utf8").split("\n")) {
      if (!l.includes('"ev":"' + ev + '"')) continue; all++; if (l.includes('"ip":"' + ip + '"')) mine++;
    }
    return { all, mine };
  } catch (e) { return { all: 0, mine: 0 }; }
}
module.exports = { GH, OWNER, VT, sleep, gh, vc, J, ipHash, log, usage };
