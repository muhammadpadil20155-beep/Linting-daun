// api/log.js — menerima log dari browser (error JavaScript, aktivitas tool) dan menyimpannya ke repo log GitHub.
const L = require("./_lib");
const hits = new Map();
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const ip = L.ipHash(req), now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (h.length >= 10) { res.statusCode = 429; return res.end("{}"); }
  h.push(now); hits.set(ip, h);
  let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const ev = String(b.ev || "client").toLowerCase().replace(/[^a-z_]/g, "").slice(0, 24) || "client";
  await L.log({ ev: "c_" + ev, ip, msg: String(b.msg || "").slice(0, 300), ua: String(req.headers["user-agent"] || "").slice(0, 100) });
  res.statusCode = 200; res.end('{"ok":true}');
};
