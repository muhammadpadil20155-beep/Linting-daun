// api/chat.js — Chat AI (streaming) memakai Anthropic API. Kunci hanya dari env ANTHROPIC_API_KEY.
const L = require("./_lib");
const KEY = process.env.ANTHROPIC_API_KEY, MODEL = process.env.CHAT_MODEL || "claude-sonnet-5-5";
const PER_IP = +process.env.CHAT_PER_IP || 25, DAILY = +process.env.CHAT_DAILY_CAP || 400;
const SYS = "Kamu asisten AI di website Secretly. Jawab dengan bahasa yang dipakai pengguna (default Indonesia), ringkas dan jelas. " +
  "Jika diminta membuat website atau aplikasi web, tulis SATU file HTML lengkap (CSS dan JavaScript di dalam file, responsif untuk HP, " +
  "tanpa library luar kecuali dari cdnjs.cloudflare.com) di dalam satu blok ```html. Jangan membuat malware, phishing, atau konten berbahaya.";
const fail = (res, code, msg) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: false, error: msg })); };

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "Metode tidak didukung");
  if (!KEY) return fail(res, 500, "Chat AI belum dikonfigurasi (ANTHROPIC_API_KEY)");
  if (!L.GH || !L.OWNER) return fail(res, 500, "Pengaman kuota butuh GITHUB_TOKEN dan GITHUB_OWNER");
  let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  const msgs = (b && Array.isArray(b.messages) ? b.messages : []).slice(-12)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return fail(res, 400, "Pesan kosong");
  const ip = L.ipHash(req), u = await L.usage(ip, "chat");
  if (u.mine >= PER_IP) return fail(res, 429, `Batas ${PER_IP} pesan per hari tercapai, coba lagi besok`);
  if (u.all >= DAILY) return fail(res, 429, "Kuota chat hari ini sudah habis, coba lagi besok");
  await L.log({ ev: "chat", ip, n: msgs.length });
  const up = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4500, stream: true, system: SYS, messages: msgs }) });
  if (!up.ok) { let m = ""; try { m = (await up.json()).error.message; } catch (e) {} await L.log({ ev: "chat_fail", ip, status: up.status, err: String(m).slice(0, 200) }); return fail(res, 502, "AI sedang bermasalah (HTTP " + up.status + ")"); }
  res.statusCode = 200; res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of up.body) {
    buf += dec.decode(chunk, { stream: true }); let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = ev.split("\n").find(l => l.startsWith("data: ")); if (!line) continue;
      try { const j = JSON.parse(line.slice(6));
        if (j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta") res.write(j.delta.text);
        else if (j.type === "error") res.write("\n\n[Gagal: " + ((j.error && j.error.message) || "error") + "]");
      } catch (e) {}
    }
  }
  res.end();
};
