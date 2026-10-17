// api/deploy.js — GET ?name=x : cek nama | POST {name, files:[{path,b64}]} : buat repo GitHub + deploy ke Vercel.
const L = require("./_lib");
const send = (res, code, o) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(o)); };
const normName = n => String(n || "").toLowerCase().trim().replace(/[\s_.]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const RESERVED = new Set(["api", "www", "admin", "vercel", "github", "login", "secretly", "dashboard", "app"]);
const PY = process.env.DEPLOY_ALLOW_PYTHON === "1";
const ALLOW = new RegExp("\\.(html?|css|m?js|json|txt|md|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|xml|webmanifest|mp3|mp4|webm" + (PY ? "|py" : "") + ")$|^requirements\\.txt$", "i");
const BLOCK = /(^|\/)(\.|node_modules(\/|$)|vercel\.json$|package(-lock)?\.json$)|\.\./i;
const MAX_FILES = 60, MAX_TOTAL = 3.2e6, PER_IP = +process.env.DEPLOY_PER_IP || 3, DAILY = +process.env.DEPLOY_DAILY_CAP || 30;

async function nameState(name) {
  if (name.length < 3) return { ok: false, msg: "Nama minimal 3 karakter (huruf kecil, angka, tanda minus)" };
  if (RESERVED.has(name)) return { ok: false, msg: "Nama ini dicadangkan, pilih nama lain" };
  const [r, v] = await Promise.all([L.gh(`/repos/${L.OWNER}/${name}`), L.vc("/v9/projects/" + name)]);
  if (r.status === 200 || v.status === 200) return { ok: false, taken: true, msg: "Nama sudah dipakai, pilih nama lain" };
  if (r.status !== 404) return { ok: false, msg: "Pengecekan GitHub gagal (HTTP " + r.status + ")" };
  return { ok: true, msg: "Nama tersedia" };
}
// perbaikan otomatis pada file yang diunggah; mengembalikan daftar perbaikan yang dilakukan
function autofix(files) {
  const fixes = [];
  files.forEach(f => { const p = f.path.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, ""); if (p !== f.path) { f.path = p; fixes.push("path dirapikan: " + p); } });
  if (!files.some(f => f.path === "index.html")) {
    const h = files.filter(f => /\.html?$/i.test(f.path) && !f.path.includes("/"));
    if (h.length === 1) { fixes.push(`${h[0].path} dijadikan index.html`); h[0].path = "index.html"; }
  }
  if (PY && !files.some(f => f.path === "requirements.txt")) {
    const src = files.filter(f => f.path.endsWith(".py")).map(f => Buffer.from(f.b64, "base64").toString("utf8")).join("\n");
    const need = ["flask", "fastapi"].filter(m => new RegExp("(from|import)\\s+" + m, "i").test(src));
    if (need.length) { files.push({ path: "requirements.txt", b64: Buffer.from(need.join("\n") + "\n").toString("base64") }); fixes.push("requirements.txt ditambahkan: " + need.join(", ")); }
  }
  return fixes;
}

module.exports = async (req, res) => {
  const t0 = Date.now(), ip = L.ipHash(req); let name = "", repoMade = false, projMade = false;
  try {
    if (process.env.DEPLOY_ENABLED === "0") return send(res, 503, { ok: false, error: "Fitur deploy sedang dimatikan oleh owner" });
    if (!L.GH || !L.OWNER || !L.VT) return send(res, 500, { ok: false, error: "Server belum dikonfigurasi (GITHUB_TOKEN, GITHUB_OWNER, VERCEL_TOKEN)" });
    if (req.method === "GET") { const n = normName(new URL(req.url, "http://x").searchParams.get("name")); return send(res, 200, { ...(await nameState(n)), name: n }); }
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Metode tidak didukung" });

    let b = req.body; if (typeof b === "string") b = JSON.parse(b);
    name = normName(b && b.name); const files = Array.isArray(b && b.files) ? b.files.filter(f => f && typeof f.path === "string" && typeof f.b64 === "string") : [];
    if (!files.length) return send(res, 400, { ok: false, error: "Tidak ada file untuk di-deploy" });
    const fixes = autofix(files), bytes = files.reduce((s, f) => s + Math.floor(f.b64.length * 0.75), 0);
    await L.log({ ev: "deploy_start", ip, name, files: files.length, bytes });   // deteksi aktivitas deploy

    const bad = files.length > MAX_FILES ? "Maksimal " + MAX_FILES + " file" : bytes > MAX_TOTAL ? "Total ukuran maksimal sekitar 3 MB"
      : (files.find(f => BLOCK.test(f.path) || !ALLOW.test(f.path)) ? "File tidak diizinkan: " + files.find(f => BLOCK.test(f.path) || !ALLOW.test(f.path)).path : "")
      || (PY || files.some(f => /\.html?$/i.test(f.path)) ? "" : "Sertakan minimal satu file HTML");
    if (bad) { await L.log({ ev: "deploy_rejected", ip, name, why: bad }); return send(res, 400, { ok: false, error: bad }); }

    const u = await L.usage(ip);
    if (u.mine > PER_IP || u.all > DAILY) { await L.log({ ev: "deploy_limited", ip, name }); return send(res, 429, { ok: false, error: u.mine > PER_IP ? `Batas ${PER_IP} deploy per hari tercapai, coba lagi besok` : "Kuota deploy hari ini sudah habis, coba lagi besok" }); }
    const s = await nameState(name);
    if (!s.ok) { await L.log({ ev: s.taken ? "deploy_name_taken" : "deploy_name_bad", ip, name }); return send(res, s.taken ? 409 : 400, { ok: false, taken: !!s.taken, error: s.msg }); }

    // 1) repo GitHub + satu commit berisi semua file
    const repo = await L.J(await L.gh("/user/repos", "POST", { name, private: process.env.DEPLOY_REPO_PUBLIC !== "1", auto_init: true, description: "Dideploy lewat Secretly" }), "GitHub buat repo");
    repoMade = true; await L.sleep(1200);
    const rp = `/repos/${L.OWNER}/${name}`, br = repo.default_branch || "main";
    const head = await L.J(await L.gh(`${rp}/git/ref/heads/${br}`), "GitHub ref"), entries = [];
    for (let i = 0; i < files.length; i += 6) await Promise.all(files.slice(i, i + 6).map(async f => {
      const bl = await L.J(await L.gh(`${rp}/git/blobs`, "POST", { content: f.b64, encoding: "base64" }), "GitHub blob");
      entries.push({ path: f.path, mode: "100644", type: "blob", sha: bl.sha });
    }));
    const base = await L.J(await L.gh(`${rp}/git/commits/${head.object.sha}`), "GitHub commit");
    const tree = await L.J(await L.gh(`${rp}/git/trees`, "POST", { base_tree: base.tree.sha, tree: entries }), "GitHub tree");
    const cm = await L.J(await L.gh(`${rp}/git/commits`, "POST", { message: "Deploy via Secretly", tree: tree.sha, parents: [head.object.sha] }), "GitHub commit");
    await L.J(await L.gh(`${rp}/git/refs/heads/${br}`, "PATCH", { sha: cm.sha, force: true }), "GitHub update");

    // 2) deploy ke Vercel (domain vercel.app)
    projMade = true;
    const dep = await L.J(await L.vc("/v13/deployments?skipAutoDetectionConfirmation=1", "POST", { name, target: "production", projectSettings: { framework: null },
      files: files.map(f => ({ file: f.path, data: f.b64, encoding: "base64" })) }), "Vercel deploy");
    let d = dep;
    for (let i = 0; i < 20 && !["READY", "ERROR", "CANCELED"].includes(d.readyState); i++) { await L.sleep(1500); d = await L.J(await L.vc("/v13/deployments/" + dep.id), "Vercel status"); }
    if (d.readyState === "ERROR" || d.readyState === "CANCELED") throw new Error("Build Vercel gagal" + (d.errorMessage ? ": " + d.errorMessage : ""));
    const alias = (d.alias || []).filter(a => a.endsWith(".vercel.app")).sort((a, c) => a.length - c.length)[0];
    const url = "https://" + (alias || d.url);
    await L.log({ ev: "deploy_ok", ip, name, url, files: files.length, fixes, ms: Date.now() - t0 });
    return send(res, 200, { ok: true, url, name, fixes, pending: d.readyState !== "READY" });
  } catch (e) {
    // pembersihan otomatis supaya nama bisa dipakai lagi (butuh scope delete_repo pada token GitHub)
    let cleaned = [];
    if (projMade) { try { if ((await L.vc("/v9/projects/" + name, "DELETE")).ok) cleaned.push("project"); } catch (x) {} }
    if (repoMade) { try { if ((await L.gh(`/repos/${L.OWNER}/${name}`, "DELETE")).status === 204) cleaned.push("repo"); } catch (x) {} }
    await L.log({ ev: "deploy_fail", ip, name, err: String(e.message).slice(0, 300), cleaned, ms: Date.now() - t0 });
    const msg = e.status === 402 || /rate|limit|too many/i.test(e.message) ? "Batas layanan tercapai (limit deploy Vercel/GitHub), coba lagi nanti" : e.message;
    return send(res, 500, { ok: false, error: msg + (repoMade && !cleaned.includes("repo") ? " (repo mungkin sudah terbuat, hubungi owner)" : "") });
  }
};
