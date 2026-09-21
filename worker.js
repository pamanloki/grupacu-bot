// grupacu-bot — bot Telegram untuk grup airdrop kripto.
// Jalan di Cloudflare Worker (satu file, tanpa dependency).
//
// Fitur:
//   • Hitung "done" (komen teks & reaksi 👍/✅) di GRUP DISKUSI, per post channel,
//     per user unik -> tahu siapa yang garap.
//   • Leaderboard (all-time & mingguan), /task (siapa yang sudah done di post),
//     /me (statistik sendiri).
//   • Penanda "done" bisa diatur admin.
//   • Kumpul wallet (via DM ke bot) + export untuk admin.
//   • Referral: link undangan unik per member + lacak siapa ngajak siapa.
//
// Kenapa GRUP DISKUSI, bukan channel: reaksi di post channel bersifat ANONIM
// (bot cuma dapat jumlah, bukan siapa). Di grup, bot admin tahu siapa yang
// komen/react. Channel yang punya grup diskusi otomatis mem-forward tiap post
// ke grup; member menandai "done" di situ.
//
// Setup dashboard Worker:
//   Secrets : BOT_TOKEN (wajib), TELEGRAM_SECRET (disarankan), ADMIN_IDS (id admin, dipisah koma)
//   Bindings: KV Namespace -> variable "GRUPACU"
//   Webhook : daftarkan dengan allowed_updates lengkap (lihat /setup atau README).

const DEFAULT_MARKERS = ["done", "selesai", "gm", "wagmi", "gws", "✅", "✔️", "👍", "🔥", "done ✅"];
const DEFAULT_REACT_EMOJI = ["👍", "✅", "✔️", "🔥"];

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("grupacu-bot aktif.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (env.TELEGRAM_SECRET) {
      const got = request.headers.get("x-telegram-bot-api-secret-token");
      if (got !== env.TELEGRAM_SECRET) return new Response("forbidden", { status: 403 });
    }
    let update;
    try { update = await request.json(); } catch { return new Response("bad", { status: 400 }); }
    try {
      await routeUpdate(env, update);
    } catch (e) {
      // Jangan sampai webhook gagal (Telegram akan retry terus). Log via balasan tidak ada.
      console.log("err", e && e.message);
    }
    return new Response("ok");
  },
};

// ---------------------------------------------------------------------------
// Router update
// ---------------------------------------------------------------------------

async function routeUpdate(env, u) {
  if (u.callback_query) return onCallback(env, u.callback_query);
  if (u.message) return onMessage(env, u.message);
  if (u.message_reaction) return onReaction(env, u.message_reaction);
  if (u.chat_member) return onChatMember(env, u.chat_member);
  // channel_post / edited_* diabaikan (kita pantau via forward otomatis di grup).
}

// ---------------------------------------------------------------------------
// Pesan
// ---------------------------------------------------------------------------

async function onMessage(env, msg) {
  const chat = msg.chat || {};
  const from = msg.from || {};
  const text = (msg.text || "").trim();

  // Post channel yang otomatis ke-forward ke grup diskusi -> daftarkan "task".
  if (msg.is_automatic_forward) {
    await registerTask(env, chat.id, msg);
    return;
  }

  // DM (chat privat) -> perintah personal.
  if (chat.type === "private") return onPrivate(env, chat.id, from, text, msg);

  // Grup / supergrup.
  if (chat.type === "group" || chat.type === "supergroup") {
    if (text.startsWith("/")) return onGroupCommand(env, chat, from, text, msg);
    // Deteksi "done" di dalam thread komentar sebuah post.
    return maybeCountDone(env, chat, from, text, msg);
  }
}

// Daftarkan post channel (dipakai sebagai "task").
async function registerTask(env, chatId, msg) {
  const taskId = msg.message_id; // id pesan forward di grup = anchor thread komentar
  const title = (msg.text || msg.caption || "").replace(/\s+/g, " ").trim().slice(0, 80) || "(tanpa teks)";
  const postId = (msg.forward_from_message_id) ||
    (msg.forward_origin && msg.forward_origin.message_id) || 0;
  await env.GRUPACU.put(`task:${taskId}`, JSON.stringify({ id: taskId, postId, title, ts: Date.now(), chatId }));
  await env.GRUPACU.put("lasttask", String(taskId));

  // Pengumuman otomatis + tombol tandai selesai (kalau diaktifkan).
  const cfg = await getConfig(env);
  if (cfg.announce) {
    await sendMessage(env, chatId,
      "🎯 Airdrop baru! Kalau sudah garap, tap tombol di bawah\n(atau balas \"done\" / react 👍 di sini).\n\nBelum terdaftar? Ketik /daftar dulu.",
      {
        reply_parameters: { message_id: taskId },
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Sudah garap", callback_data: `dn:${taskId}` },
            { text: "👥 Lihat progress", callback_data: `t:${taskId}` },
          ]],
        },
      });
  }
}

// Task id (anchor) dari sebuah komentar di grup diskusi.
function taskIdOf(msg) {
  if (msg.message_thread_id) return msg.message_thread_id; // komentar dalam thread post
  const r = msg.reply_to_message;
  if (r && (r.is_automatic_forward || r.sender_chat)) return r.message_id;
  return null;
}

async function maybeCountDone(env, chat, from, text, msg) {
  const taskId = taskIdOf(msg);
  if (!taskId) return; // bukan komentar di bawah post
  const cfg = await getConfig(env);
  if (!isDoneText(text, cfg.markers)) return;
  await recordDone(env, taskId, from, "teks");
  // Konfirmasi non-spam: kasih reaksi ✅ di komennya.
  await setReaction(env, chat.id, msg.message_id, "✅");
}

function isDoneText(text, markers) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  if (t.length > 40) return false; // hindari kalimat panjang "belum done" dll
  for (const m of markers) {
    const mm = m.toLowerCase();
    if (t === mm) return true;
    if (t.startsWith(mm + " ") || t.endsWith(" " + mm)) return true;
    if (mm.length <= 3 && new RegExp(`(^|\\s)${escapeRe(mm)}(\\s|$)`).test(t)) return true;
  }
  // Emoji-only (mis. cuma "👍✅") -> anggap done.
  const emojiOnly = text.replace(/[\s👍✅✔️🔥🎉🙌💪🚀]/gu, "") === "";
  if (emojiOnly && /[👍✅✔️🔥]/u.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Reaksi (message_reaction) — di grup, bot admin tahu siapa yang react.
// ---------------------------------------------------------------------------

async function onReaction(env, mr) {
  const user = mr.user;
  if (!user) return; // reaksi anonim (channel / admin anonim) -> lewati
  const cfg = await getConfig(env);
  if (!cfg.countReactions) return;
  const taskId = mr.message_id; // reaksi pada post forward = anchor
  // Hanya hitung reaksi pada POST yang terdaftar (bukan pada komentar biasa).
  if (!(await env.GRUPACU.get(`task:${taskId}`))) return;
  const hadDone = hasDoneEmoji(mr.old_reaction, cfg.reactEmoji);
  const hasDone = hasDoneEmoji(mr.new_reaction, cfg.reactEmoji);
  if (hasDone && !hadDone) {
    await recordDone(env, taskId, user, "react");
  } else if (!hasDone && hadDone) {
    await removeDone(env, taskId, user.id, "react");
  }
}

function hasDoneEmoji(arr, emojis) {
  if (!Array.isArray(arr)) return false;
  return arr.some((r) => r && r.type === "emoji" && emojis.includes(r.emoji));
}

// ---------------------------------------------------------------------------
// Simpan / hitung "done"
// ---------------------------------------------------------------------------

async function recordDone(env, taskId, user, via) {
  const uid = user.id;
  const name = displayName(user);
  await env.GRUPACU.put(`d:${taskId}:${uid}`, JSON.stringify({ name, ts: Date.now(), via }));
  await env.GRUPACU.put(`w:${weekKey(Date.now())}:${uid}:${taskId}`, "1");
  await env.GRUPACU.put(`name:${uid}`, name);
}

// Hapus done (mis. reaksi dicabut) — hanya kalau sumbernya sama.
async function removeDone(env, taskId, uid, via) {
  const raw = await env.GRUPACU.get(`d:${taskId}:${uid}`);
  if (!raw) return;
  try { if (JSON.parse(raw).via !== via) return; } catch { /* hapus saja */ }
  await env.GRUPACU.delete(`d:${taskId}:${uid}`);
  await env.GRUPACU.delete(`w:${weekKey(Date.now())}:${uid}:${taskId}`);
}

// Hitung total per user berdasarkan nama key (tanpa baca value).
async function tally(env, prefix, uidPos) {
  const counts = {};
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix, cursor, limit: 1000 });
    for (const k of res.keys) {
      const uid = k.name.split(":")[uidPos];
      if (uid) counts[uid] = (counts[uid] || 0) + 1;
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return counts;
}

async function nameOf(env, uid) {
  return (await env.GRUPACU.get(`name:${uid}`)) || `id ${uid}`;
}

// Daftarkan anggota ke roster resmi (biar muncul di "belum garap").
async function registerMember(env, user) {
  const name = displayName(user);
  await env.GRUPACU.put(`member:${user.id}`, name);
  await env.GRUPACU.put(`name:${user.id}`, name);
}

// ---------------------------------------------------------------------------
// Perintah grup
// ---------------------------------------------------------------------------

async function onGroupCommand(env, chat, from, text, msg) {
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.replace(/@.*$/, "").toLowerCase(); // buang @namabot
  const arg = rest.join(" ").trim();
  const chatId = chat.id;

  if (cmd === "/start" || cmd === "/help") return sendMessage(env, chatId, helpText());
  if (cmd === "/daftar" || cmd === "/join" || cmd === "/gas") {
    await registerMember(env, from);
    await setReaction(env, chatId, msg.message_id, "✅");
    return sendMessage(env, chatId, `✅ ${displayName(from)} terdaftar! Sekarang kamu masuk daftar, jadi kelihatan di "belum garap" tiap post sampai kamu tandai done.`);
  }
  if (cmd === "/leaderboard" || cmd === "/lb" || cmd === "/rank") return sendLeaderboard(env, chatId, "all");
  if (cmd === "/task" || cmd === "/tugas") return sendTask(env, chatId, arg, msg);
  if (cmd === "/tasks" || cmd === "/posts") return sendTasksList(env, chatId);
  if (cmd === "/me" || cmd === "/statku") return sendMe(env, chatId, from);
  if (cmd === "/ref") return sendRef(env, chatId, from, chat);

  // Admin only
  if (!isAdmin(env, from.id)) return;
  if (cmd === "/bind") return bindGroup(env, chat);
  if (cmd === "/setup") return sendMessage(env, chatId, setupText(env));
  if (cmd === "/markers") return handleMarkers(env, chatId, arg);
  if (cmd === "/wallets") return exportWallets(env, chatId);
  if (cmd === "/refboard") return sendRefBoard(env, chatId);
  if (cmd === "/members" || cmd === "/anggota") return sendMembers(env, chatId);
  if (cmd === "/announce" || cmd === "/pengumuman") {
    const cfg = await getConfig(env);
    cfg.announce = !(arg.toLowerCase() === "off" || arg === "0");
    await saveConfig(env, cfg);
    return sendMessage(env, chatId, `📢 Pengumuman otomatis tiap post baru: ${cfg.announce ? "ON ✅" : "OFF"}`);
  }
  if (cmd === "/reset") return handleReset(env, chatId, arg);
}

// Daftar anggota terdaftar (roster).
async function sendMembers(env, chatId) {
  const names = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "name:", cursor, limit: 1000 });
    for (const k of res.keys) names.push((await env.GRUPACU.get(k.name)) || k.name.slice(5));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  if (!names.length) return sendMessage(env, chatId, "Belum ada anggota di roster. Suruh member ketik /daftar.");
  names.sort((a, b) => a.localeCompare(b));
  const head = `👥 Roster anggota — ${names.length}\n\n`;
  return sendMessage(env, chatId, head + names.slice(0, 100).map((n, i) => `${i + 1}. ${n}`).join("\n") + (names.length > 100 ? `\n… dan ${names.length - 100} lagi` : ""));
}

// ---------------------------------------------------------------------------
// Perintah DM (privat)
// ---------------------------------------------------------------------------

async function onPrivate(env, chatId, from, text, msg) {
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "/start") {
    // Deep-link referral: /start ref_<uid>
    if (/^ref_\d+$/.test(arg)) await creditReferral(env, from, Number(arg.slice(4)), "deeplink");
    return sendMessage(env, chatId, dmHelpText());
  }
  if (cmd === "/help") return sendMessage(env, chatId, dmHelpText());
  if (cmd === "/daftar" || cmd === "/join" || cmd === "/gas") {
    await registerMember(env, from);
    return sendMessage(env, chatId, "✅ Terdaftar! Kamu masuk roster grup.");
  }
  if (cmd === "/wallet" || cmd === "/setwallet") return handleWallet(env, chatId, from, arg);
  if (cmd === "/mywallet") return showMyWallet(env, chatId, from);
  if (cmd === "/me") return sendMe(env, chatId, from);
  if (cmd === "/leaderboard" || cmd === "/lb") return sendLeaderboard(env, chatId, "all");
  if (cmd === "/task" || cmd === "/tasks" || cmd === "/posts") return sendTasksList(env, chatId);

  // Admin export via DM juga boleh.
  if (isAdmin(env, from.id)) {
    if (cmd === "/wallets") return exportWallets(env, chatId);
    if (cmd === "/refboard") return sendRefBoard(env, chatId);
    if (cmd === "/setup") return sendMessage(env, chatId, setupText(env));
  }

  // Bukan perintah -> anggap submit wallet kalau bentuknya alamat.
  if (looksLikeWallet(text)) return handleWallet(env, chatId, from, text);
  return sendMessage(env, chatId, dmHelpText());
}

// ---------------------------------------------------------------------------
// Leaderboard & statistik
// ---------------------------------------------------------------------------

async function sendLeaderboard(env, chatId, scope) {
  const week = weekKey(Date.now());
  const counts = scope === "week"
    ? await tally(env, `w:${week}:`, 2)
    : await tally(env, "d:", 2);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const title = scope === "week" ? "🏆 LEADERBOARD (minggu ini)" : "🏆 LEADERBOARD (all-time)";
  if (!entries.length) {
    return sendMessage(env, chatId, `${title}\n\nBelum ada yang "done". Ayo garap tugasnya! 🚀`, lbButtons(scope));
  }
  const medal = ["🥇", "🥈", "🥉"];
  const lines = [title, ""];
  let i = 0;
  for (const [uid, n] of entries) {
    const nm = await nameOf(env, uid);
    lines.push(`${medal[i] || `${i + 1}.`} ${nm} — ${n}✅`);
    i++;
  }
  const total = Object.keys(counts).length;
  lines.push("", `👥 Total kontributor: ${total}`);
  return sendMessage(env, chatId, lines.join("\n"), lbButtons(scope));
}

function lbButtons(scope) {
  return kb([[
    { text: scope === "week" ? "• Minggu ini •" : "Minggu ini", callback_data: "lb:week" },
    { text: scope === "all" ? "• All-time •" : "All-time", callback_data: "lb:all" },
  ], [{ text: "🔄 Refresh", callback_data: `lb:${scope}` }]]);
}

// /task — kalau di-reply ke post / dikirim di thread post: detail post itu.
// Kalau tidak: tampilkan daftar post terbaru untuk dipilih.
async function sendTask(env, chatId, arg, msg) {
  const tid = taskIdOf(msg) || (arg && /^\d+$/.test(arg) ? arg : null);
  if (tid) return sendTaskDetail(env, chatId, tid);
  return sendTasksList(env, chatId);
}

// Daftar post terbaru (buat dipilih lewat tombol).
async function sendTasksList(env, chatId) {
  const tasks = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "task:", cursor, limit: 1000 });
    for (const k of res.keys) {
      const raw = await env.GRUPACU.get(k.name);
      if (raw) { try { tasks.push(JSON.parse(raw)); } catch { /* skip */ } }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  if (!tasks.length) {
    return sendMessage(env, chatId, "Belum ada post terpantau. Post dulu di channel (biar ke-forward ke grup).\n\nTip: reply sebuah post lalu ketik /task untuk lihat siapa yang garap post itu.");
  }
  tasks.sort((a, b) => b.ts - a.ts);
  const rows = [];
  for (const t of tasks.slice(0, 10)) {
    const n = await countDone(env, t.id);
    rows.push([{ text: `✅ ${n} · ${t.title.slice(0, 40)}`, callback_data: `t:${t.id}` }]);
  }
  return sendMessage(env, chatId, "📋 Pilih post untuk lihat siapa yang sudah/belum garap:", kb(rows));
}

async function countDone(env, taskId) {
  let n = 0, cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: `d:${taskId}:`, cursor, limit: 1000 });
    n += res.keys.length;
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return n;
}

// Detail satu post: siapa SUDAH garap & siapa BELUM (dari roster anggota aktif).
async function sendTaskDetail(env, chatId, taskId) {
  const task = await env.GRUPACU.get(`task:${taskId}`);
  const meta = task ? JSON.parse(task) : null;

  // Yang sudah garap.
  const doneMap = {}; // uid -> {name, via, ts}
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: `d:${taskId}:`, cursor, limit: 1000 });
    for (const k of res.keys) {
      const uid = k.name.split(":")[2];
      const raw = await env.GRUPACU.get(k.name);
      if (raw) { try { doneMap[uid] = JSON.parse(raw); } catch { doneMap[uid] = { name: "id " + uid }; } }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  // Roster anggota aktif = semua yang punya name:<uid> (pernah garap / submit wallet).
  const roster = {};
  cursor = undefined;
  do {
    const res = await env.GRUPACU.list({ prefix: "name:", cursor, limit: 1000 });
    for (const k of res.keys) {
      const uid = k.name.slice(5);
      roster[uid] = (await env.GRUPACU.get(k.name)) || ("id " + uid);
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  const sudah = Object.entries(doneMap).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  const belum = Object.keys(roster).filter((uid) => !doneMap[uid]);

  const lines = [`📋 ${meta ? meta.title : "Post #" + taskId}`, ""];
  lines.push(`✅ Sudah garap — ${sudah.length}`);
  if (sudah.length) sudah.slice(0, 60).forEach(([, d], i) => lines.push(`${i + 1}. ${d.name}${d.via === "react" ? " 👍" : ""}`));
  else lines.push("• (belum ada)");
  lines.push("", `⬜ Belum garap — ${belum.length}`);
  if (belum.length) belum.slice(0, 60).forEach((uid, i) => lines.push(`${i + 1}. ${roster[uid]}`));
  else lines.push("• semua sudah! 🎉");
  lines.push("", "ℹ️ \"Belum\" = anggota terdaftar (/daftar) atau yang pernah aktif, tapi belum di post ini.");
  return sendMessage(env, chatId, lines.join("\n"), kb([[{ text: "📋 Post lain", callback_data: "tlist" }, { text: "🔄 Refresh", callback_data: `t:${taskId}` }]]));
}

async function sendMe(env, chatId, from) {
  const uid = from.id;
  const all = await tally(env, "d:", 2);
  const week = await tally(env, `w:${weekKey(Date.now())}:`, 2);
  const total = all[uid] || 0;
  const wk = week[uid] || 0;
  // Peringkat all-time.
  const rank = Object.entries(all).sort((a, b) => b[1] - a[1]).findIndex(([u]) => u == uid) + 1;
  const w = await env.GRUPACU.get(`wallet:${uid}`);
  const lines = [
    `👤 ${displayName(from)}`,
    "",
    `✅ Total done: ${total}`,
    `📅 Minggu ini: ${wk}`,
    rank ? `🏅 Peringkat: #${rank}` : "",
    w ? `💼 Wallet: tersimpan ✅` : `💼 Wallet: belum (kirim via DM: /wallet <alamat>)`,
  ].filter(Boolean);
  return sendMessage(env, chatId, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

function looksLikeWallet(s) {
  const t = (s || "").trim();
  if (/\s/.test(t)) return false;
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return true; // EVM
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return true; // Solana base58
  if (/^(bc1|[13])[0-9a-zA-Z]{20,60}$/.test(t)) return true; // BTC
  if (/^T[0-9a-zA-Z]{33}$/.test(t)) return true; // TRON
  return false;
}
function walletChain(t) {
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return "EVM";
  if (/^T[0-9a-zA-Z]{33}$/.test(t)) return "TRON";
  if (/^(bc1|[13])/.test(t)) return "BTC";
  return "SOL/lainnya";
}

async function handleWallet(env, chatId, from, arg) {
  const addr = (arg || "").trim().split(/\s+/)[0] || "";
  if (!addr) return sendMessage(env, chatId, "Kirim alamatnya. Contoh:\n/wallet 0x1234...abcd");
  if (!looksLikeWallet(addr)) {
    return sendMessage(env, chatId, "Alamat tak dikenali. Pastikan benar (EVM 0x..., Solana, BTC, atau TRON).");
  }
  await env.GRUPACU.put(`wallet:${from.id}`, JSON.stringify({
    addr, chain: walletChain(addr), name: displayName(from), username: from.username || "", ts: Date.now(),
  }));
  await env.GRUPACU.put(`name:${from.id}`, displayName(from));
  return sendMessage(env, chatId, `✅ Wallet tersimpan (${walletChain(addr)}):\n\`${addr}\`\n\nGanti kapan saja dengan /wallet <alamat baru>.`, { parse_mode: "Markdown" });
}

async function showMyWallet(env, chatId, from) {
  const raw = await env.GRUPACU.get(`wallet:${from.id}`);
  if (!raw) return sendMessage(env, chatId, "Belum ada wallet tersimpan. Kirim: /wallet <alamat>");
  const w = JSON.parse(raw);
  return sendMessage(env, chatId, `💼 Wallet kamu (${w.chain}):\n\`${w.addr}\``, { parse_mode: "Markdown" });
}

async function exportWallets(env, chatId) {
  const rows = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "wallet:", cursor, limit: 1000 });
    for (const k of res.keys) {
      const raw = await env.GRUPACU.get(k.name);
      if (raw) { try { rows.push(JSON.parse(raw)); } catch { /* skip */ } }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  if (!rows.length) return sendMessage(env, chatId, "Belum ada wallet terkumpul.");
  const csv = ["nama,username,chain,alamat,waktu"];
  for (const w of rows) {
    csv.push([w.name, w.username ? "@" + w.username : "", w.chain, w.addr, new Date(w.ts).toISOString()].map(csvCell).join(","));
  }
  await sendDocument(env, chatId, "wallets.csv", csv.join("\n"), `💼 ${rows.length} wallet terkumpul.`);
}

// ---------------------------------------------------------------------------
// Referral
// ---------------------------------------------------------------------------

async function sendRef(env, chatId, from, chat) {
  const cfg = await getConfig(env);
  const gid = cfg.groupId || (chat.type !== "private" ? chat.id : null);
  // Coba buat link undangan unik (butuh bot admin + izin invite).
  if (gid) {
    const link = await createInvite(env, gid, String(from.id));
    if (link) {
      const cnt = await refCount(env, from.id);
      return sendMessage(env, chatId, `🔗 Link referral kamu:\n${link}\n\n👥 Sudah ngajak: ${cnt} orang\nSetiap yang join lewat link ini otomatis kehitung buat kamu.`);
    }
  }
  // Fallback: deep-link start bot.
  const me = await getMe(env);
  const uname = me && me.username;
  const cnt = await refCount(env, from.id);
  if (uname) {
    return sendMessage(env, chatId, `🔗 Link referral kamu:\nhttps://t.me/${uname}?start=ref_${from.id}\n\n👥 Sudah ngajak: ${cnt} orang`);
  }
  return sendMessage(env, chatId, "Referral belum aktif. Admin perlu /bind di grup & jadikan bot admin.");
}

async function refCount(env, uid) {
  let n = 0, cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: `rb:${uid}:`, cursor, limit: 1000 });
    n += res.keys.length;
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return n;
}

async function creditReferral(env, newUser, inviterUid, via) {
  const nu = newUser.id;
  if (!inviterUid || inviterUid === nu) return;
  const existing = await env.GRUPACU.get(`ref:${nu}`);
  if (existing) return; // sudah pernah direferral, jangan dobel
  await env.GRUPACU.put(`ref:${nu}`, JSON.stringify({ by: inviterUid, ts: Date.now(), via }));
  await env.GRUPACU.put(`rb:${inviterUid}:${nu}`, "1");
  await env.GRUPACU.put(`name:${nu}`, displayName(newUser));
}

async function sendRefBoard(env, chatId) {
  const counts = await tally(env, "rb:", 1); // rb:<inviter>:<new>
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (!entries.length) return sendMessage(env, chatId, "Belum ada referral tercatat.");
  const medal = ["🥇", "🥈", "🥉"];
  const lines = ["🔗 REFERRAL LEADERBOARD", ""];
  let i = 0;
  for (const [uid, n] of entries) { lines.push(`${medal[i] || `${i + 1}.`} ${await nameOf(env, uid)} — ${n} orang`); i++; }
  return sendMessage(env, chatId, lines.join("\n"));
}

// Anggota baru join -> kalau lewat link undangan bernama uid, kreditkan.
async function onChatMember(env, cm) {
  const oldS = cm.old_chat_member && cm.old_chat_member.status;
  const newS = cm.new_chat_member && cm.new_chat_member.status;
  const joined = (newS === "member") && (oldS === "left" || oldS === "kicked" || !oldS);
  if (!joined) return;
  const user = cm.new_chat_member.user;
  const inv = cm.invite_link;
  if (inv && inv.name && /^\d+$/.test(inv.name)) {
    await creditReferral(env, user, Number(inv.name), "invite");
  }
}

// ---------------------------------------------------------------------------
// Admin: bind grup, markers, reset
// ---------------------------------------------------------------------------

async function bindGroup(env, chat) {
  const cfg = await getConfig(env);
  cfg.groupId = chat.id;
  await saveConfig(env, cfg);
  return sendMessage(env, chat.id, `✅ Grup ini (${chat.title || chat.id}) di-set sebagai grup diskusi yang dipantau.\nID: \`${chat.id}\``, { parse_mode: "Markdown" });
}

async function handleMarkers(env, chatId, arg) {
  const cfg = await getConfig(env);
  const parts = arg.split(/\s+/).filter(Boolean);
  const sub = (parts.shift() || "").toLowerCase();
  const val = parts.join(" ").trim();
  if (sub === "add" && val) {
    if (!cfg.markers.some((m) => m.toLowerCase() === val.toLowerCase())) cfg.markers.push(val);
    await saveConfig(env, cfg);
    return sendMessage(env, chatId, `✅ Penanda ditambah: "${val}"\nSekarang: ${cfg.markers.join(", ")}`);
  }
  if ((sub === "del" || sub === "hapus") && val) {
    cfg.markers = cfg.markers.filter((m) => m.toLowerCase() !== val.toLowerCase());
    await saveConfig(env, cfg);
    return sendMessage(env, chatId, `🗑️ Dihapus: "${val}"\nSekarang: ${cfg.markers.join(", ")}`);
  }
  if (sub === "react") {
    cfg.countReactions = !(val.toLowerCase() === "off" || val === "0");
    await saveConfig(env, cfg);
    return sendMessage(env, chatId, `Reaksi dihitung: ${cfg.countReactions ? "ON ✅" : "OFF"}`);
  }
  return sendMessage(env, chatId,
    "🏷️ Penanda \"done\":\n" + cfg.markers.join(", ") +
    `\n\nReaksi dihitung: ${cfg.countReactions ? "ON" : "OFF"} (${cfg.reactEmoji.join(" ")})\n\n` +
    "Kelola:\n/markers add <kata/emoji>\n/markers del <kata/emoji>\n/markers react on|off");
}

async function handleReset(env, chatId, arg) {
  if (arg.toLowerCase() !== "yakin") {
    return sendMessage(env, chatId, "⚠️ Hapus SEMUA data done & leaderboard? Tak bisa dibatalkan.\nKetik: /reset yakin");
  }
  for (const prefix of ["d:", "w:"]) {
    let cursor;
    do {
      const res = await env.GRUPACU.list({ prefix, cursor, limit: 1000 });
      for (const k of res.keys) await env.GRUPACU.delete(k.name);
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  }
  return sendMessage(env, chatId, "🧹 Leaderboard direset.");
}

// ---------------------------------------------------------------------------
// Callback (tombol)
// ---------------------------------------------------------------------------

async function onCallback(env, cq) {
  const data = cq.data || "";
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  // Tombol "Sudah garap" -> catat done buat yang menekan.
  if (data.startsWith("dn:")) {
    const taskId = data.slice(3);
    await recordDone(env, taskId, cq.from, "tombol");
    return answerCallback(env, cq.id, "✅ Tercatat, makasih! 🚀");
  }
  await answerCallback(env, cq.id);
  if (!chatId) return;
  if (data === "lb:week") return sendLeaderboard(env, chatId, "week");
  if (data === "lb:all") return sendLeaderboard(env, chatId, "all");
  if (data === "tlist") return sendTasksList(env, chatId);
  if (data.startsWith("t:")) return sendTaskDetail(env, chatId, data.slice(2));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function getConfig(env) {
  const raw = await env.GRUPACU.get("cfg");
  const c = raw ? JSON.parse(raw) : {};
  return {
    markers: Array.isArray(c.markers) && c.markers.length ? c.markers : DEFAULT_MARKERS.slice(),
    reactEmoji: Array.isArray(c.reactEmoji) && c.reactEmoji.length ? c.reactEmoji : DEFAULT_REACT_EMOJI.slice(),
    countReactions: c.countReactions !== false,
    announce: c.announce !== false,
    groupId: c.groupId || null,
  };
}
async function saveConfig(env, cfg) {
  await env.GRUPACU.put("cfg", JSON.stringify(cfg));
}

function isAdmin(env, uid) {
  const raw = (env.ADMIN_IDS || "").trim();
  if (!raw) return false;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(String(uid));
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function displayName(u) {
  if (!u) return "?";
  const nm = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  if (nm) return nm;
  if (u.username) return "@" + u.username;
  return "id " + u.id;
}

const WIB = 7 * 3600 * 1000;
function weekKey(ts) {
  const d = new Date(ts + WIB);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}${String(week).padStart(2, "0")}`;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function csvCell(v) { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function kb(rows) { return { reply_markup: { inline_keyboard: rows } }; }

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

async function sendMessage(env, chatId, text, extra) {
  return tg(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(extra || {}) });
}
async function setReaction(env, chatId, messageId, emoji) {
  try {
    await tg(env, "setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] });
  } catch { /* best effort */ }
}
async function answerCallback(env, id, text) {
  try { await tg(env, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }); } catch { /* abaikan */ }
}
async function createInvite(env, chatId, name) {
  const res = await tg(env, "createChatInviteLink", { chat_id: chatId, name });
  return res && res.ok && res.result ? res.result.invite_link : null;
}
let ME_CACHE = null;
async function getMe(env) {
  if (ME_CACHE) return ME_CACHE;
  const res = await tg(env, "getMe", {});
  ME_CACHE = res && res.ok ? res.result : null;
  return ME_CACHE;
}
async function sendDocument(env, chatId, filename, content, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([content], { type: "text/csv" }), filename);
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
}

// ---------------------------------------------------------------------------
// Teks bantuan
// ---------------------------------------------------------------------------

function helpText() {
  return [
    "🤖 GRUPACU BOT — pelacak tugas airdrop",
    "",
    "📝 Daftar dulu sekali: ketik /daftar (biar masuk roster & kelihatan",
    "   di \"belum garap\").",
    "Tandai selesai: balas post di grup dengan \"done\"/✅/👍,",
    "atau kasih reaksi 👍/✅ pada post-nya.",
    "",
    "Perintah:",
    "/daftar — masuk roster anggota",
    "/leaderboard — papan peringkat (all-time & mingguan)",
    "/task — siapa SUDAH & BELUM garap sebuah post",
    "   → reply post-nya lalu ketik /task (spesifik post itu)",
    "   → atau /tasks untuk pilih dari daftar post",
    "/me — statistik kamu",
    "/ref — link referral kamu",
    "",
    "💼 Simpan wallet: DM bot ini → /wallet <alamat>",
  ].join("\n");
}

function dmHelpText() {
  return [
    "🤖 GRUPACU BOT",
    "",
    "💼 Simpan wallet buat distribusi airdrop:",
    "/wallet <alamat>  (mis. /wallet 0xabc...123)",
    "/mywallet — lihat wallet tersimpan",
    "",
    "📊 /me — statistik done kamu",
    "🔗 /ref — link referral",
    "🏆 /leaderboard — papan peringkat",
    "",
    "Alamat yang didukung: EVM (0x…), Solana, BTC, TRON.",
  ].join("\n");
}

function setupText(env) {
  return [
    "⚙️ SETUP grupacu-bot",
    "",
    "1) Channel → Manage → Discussion: hubungkan ke sebuah grup.",
    "2) Jadikan bot ini ADMIN di grup diskusi.",
    "3) @BotFather → /setprivacy → pilih bot → Disable (biar baca semua komen).",
    "4) Di grup diskusi ketik: /bind (set grup yang dipantau).",
    "5) Daftarkan webhook dengan allowed_updates:",
    "   message, edited_message, message_reaction, chat_member, callback_query",
    "",
    "Contoh setWebhook (buka di browser, ganti <...>):",
    "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<SECRET>&allowed_updates=[\"message\",\"edited_message\",\"message_reaction\",\"chat_member\",\"callback_query\"]",
    "",
    "Catatan: 'message_reaction' & 'chat_member' TIDAK aktif kalau tak disebut eksplisit di allowed_updates.",
  ].join("\n");
}
