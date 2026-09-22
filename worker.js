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
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { await runDeadlines(env); await runDigest(env); await runAlerts(env); await runGasAlert(env); await runReminders(env); })());
  },
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
    const th = replyCtx(msg);
    // Convert antar coin: "1 btc to eth" (hanya coin dikenal).
    const cv = parseConvertQuery(text);
    if (cv) {
      const a = await knownCoin(env, cv.from), b = await knownCoin(env, cv.to);
      if (a && b) return sendCoinConvert(env, chat.id, cv.amount, cv.from, cv.to, a, b, th);
    }
    // Cek harga: "1 usdt" / "0.5 btc" (hanya coin yang dikenal, biar tak ganggu chat).
    const pq = parsePriceQuery(text);
    if (pq && pq.amount != null) {
      const id = await knownCoin(env, pq.sym);
      if (id) return sendConvert(env, chat.id, pq.amount, pq.sym, id, th);
    }
    // Deteksi "done" di dalam thread komentar sebuah post.
    return maybeCountDone(env, chat, from, text, msg);
  }
}

// Daftarkan post channel (dipakai sebagai "task").
async function registerTask(env, chatId, msg) {
  const taskId = msg.message_id; // id pesan forward di grup = anchor thread komentar
  const title = (msg.text || msg.caption || "").replace(/\s+/g, " ").trim().slice(0, 100) || "(media/tanpa teks)";
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
  await recordDone(env, taskId, from, "teks", chat.id);
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
    await recordDone(env, taskId, user, "react", mr.chat && mr.chat.id);
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

async function recordDone(env, taskId, user, via, chatId) {
  const uid = user.id;
  const name = displayName(user);
  await env.GRUPACU.put(`d:${taskId}:${uid}`, JSON.stringify({ name, ts: Date.now(), via }));
  await env.GRUPACU.put(`w:${weekKey(Date.now())}:${uid}:${taskId}`, "1");
  await env.GRUPACU.put(`name:${uid}`, name);
  // Pastikan task tercatat (biar punya chatId untuk link) walau bot tak lihat forward-nya.
  if (chatId && !(await env.GRUPACU.get(`task:${taskId}`))) {
    await env.GRUPACU.put(`task:${taskId}`, JSON.stringify({ id: Number(taskId), title: "Post #" + taskId, ts: Date.now(), chatId }));
  }
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
  if (cmd === "/daftar" || cmd === "/join" || cmd === "/gass") {
    await registerMember(env, from);
    await setReaction(env, chatId, msg.message_id, "✅");
    return sendMessage(env, chatId, `✅ ${displayName(from)} terdaftar! Sekarang kamu masuk daftar, jadi kelihatan di "belum garap" tiap post sampai kamu tandai done.`);
  }
  if (cmd === "/leaderboard" || cmd === "/lb" || cmd === "/rank") return sendLeaderboard(env, chatId, "all");
  if (cmd === "/task" || cmd === "/tugas") return sendTask(env, chatId, arg, msg);
  if (cmd === "/tasks" || cmd === "/posts") return sendTasksList(env, chatId);
  if (cmd === "/me" || cmd === "/statku") return sendMe(env, chatId, from);
  if (cmd === "/ref") return sendRef(env, chatId, from, chat);
  const th = replyCtx(msg);
  if (cmd === "/p" || cmd === "/price" || cmd === "/harga") return sendPrice(env, chatId, arg || "btc", th);
  if (cmd === "/pdebug") return sendPriceDebug(env, chatId, arg || "btc");
  if (cmd === "/gas") return sendGas(env, chatId, th);
  if (cmd === "/fgi" || cmd === "/feargreed") return sendFgi(env, chatId, th);
  if (cmd === "/conv" || cmd === "/convert") return doConvCmd(env, chatId, arg, th);
  if (cmd === "/airdrops" || cmd === "/airdrop") return listAirdrops(env, chatId);
  if (cmd === "/calendar" || cmd === "/kalender" || cmd === "/cal") return sendCalendar(env, chatId, /^all|semua$/i.test(arg));
  if (cmd === "/board" || cmd === "/papan" || cmd === "/progress") return sendBoard(env, chatId, /^all|semua$/i.test(arg));
  if (cmd === "/stats" || cmd === "/statistik") return sendStats(env, chatId);
  if (cmd === "/roi" || cmd === "/modalku") return sendRoi(env, chatId);
  if (cmd === "/modal") return handleModal(env, chatId, arg);
  if (cmd === "/note" || cmd === "/catatan") return handleNote(env, chatId, arg);
  if (cmd === "/target") return handleTarget(env, chatId, arg);
  if (cmd === "/export") return sendExport(env, chatId);
  if (cmd === "/gasalert" || cmd === "/gasalarm") return handleGasAlert(env, chatId, arg);
  if (cmd === "/remind" || cmd === "/ingatkan") return handleRemind(env, chatId, from, arg);
  if (cmd === "/reminders" || cmd === "/ingat") return listReminders(env, chatId, from);
  if (cmd === "/delremind") return delReminder(env, chatId, from, arg);
  if (cmd === "/akun" || cmd === "/akunku" || cmd === "/accounts") return handleAccounts(env, chatId, arg);
  if (cmd === "/alert") return addAlert(env, chatId, from, arg);
  if (cmd === "/alerts") return listAlerts(env, chatId, from);
  if (cmd === "/delalert" || cmd === "/hapusalert") return delAlert(env, chatId, from, arg);

  // Admin only
  if (!isAdmin(env, from.id)) return;
  if (cmd === "/bind") return bindGroup(env, chat);
  if (cmd === "/addairdrop") return addAirdrop(env, chatId, arg, msg);
  if (cmd === "/delairdrop") return delAirdrop(env, chatId, arg);
  if (cmd === "/setup") return sendMessage(env, chatId, setupText(env));
  if (cmd === "/markers") return handleMarkers(env, chatId, arg);
  if (cmd === "/wallets") return exportWallets(env, chatId);
  if (cmd === "/refboard") return sendRefBoard(env, chatId);
  if (cmd === "/members" || cmd === "/anggota") return sendMembers(env, chatId);
  if (cmd === "/deadline" || cmd === "/dl") return setDeadline(env, chatId, taskIdOf(msg), arg);
  if (cmd === "/nudge" || cmd === "/colek") return nudge(env, chatId, taskIdOf(msg), {});
  if (cmd === "/announce" || cmd === "/pengumuman") {
    const cfg = await getConfig(env);
    cfg.announce = !(arg.toLowerCase() === "off" || arg === "0");
    await saveConfig(env, cfg);
    return sendMessage(env, chatId, `📢 Pengumuman otomatis tiap post baru: ${cfg.announce ? "ON ✅" : "OFF"}`);
  }
  if (cmd === "/digest") {
    const cfg = await getConfig(env);
    cfg.digest = !(arg.toLowerCase() === "off" || arg === "0");
    await saveConfig(env, cfg);
    return sendMessage(env, chatId, `☀️ Digest airdrop harian (~${String(DIGEST_HOUR).padStart(2, "0")}:00 WIB): ${cfg.digest ? "ON ✅" : "OFF"}\n(butuh Cron Trigger 0 * * * * aktif)`);
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
  if (cmd === "/daftar" || cmd === "/join" || cmd === "/gass") {
    await registerMember(env, from);
    return sendMessage(env, chatId, "✅ Terdaftar! Kamu masuk roster grup.");
  }
  if (cmd === "/wallet" || cmd === "/setwallet") return handleWallet(env, chatId, from, arg);
  if (cmd === "/mywallet") return showMyWallet(env, chatId, from);
  if (cmd === "/me") return sendMe(env, chatId, from);
  if (cmd === "/leaderboard" || cmd === "/lb") return sendLeaderboard(env, chatId, "all");
  if (cmd === "/task" || cmd === "/tasks" || cmd === "/posts") return sendTasksList(env, chatId);
  if (cmd === "/p" || cmd === "/price" || cmd === "/harga") return sendPrice(env, chatId, arg || "btc");
  if (cmd === "/gas") return sendGas(env, chatId);
  if (cmd === "/fgi" || cmd === "/feargreed") return sendFgi(env, chatId);
  if (cmd === "/conv" || cmd === "/convert") return doConvCmd(env, chatId, arg);
  if (cmd === "/airdrops" || cmd === "/airdrop") return listAirdrops(env, chatId);
  if (cmd === "/calendar" || cmd === "/kalender" || cmd === "/cal") return sendCalendar(env, chatId, /^all|semua$/i.test(arg));
  if (cmd === "/board" || cmd === "/papan" || cmd === "/progress") return sendBoard(env, chatId, /^all|semua$/i.test(arg));
  if (cmd === "/stats" || cmd === "/statistik") return sendStats(env, chatId);
  if (cmd === "/roi" || cmd === "/modalku") return sendRoi(env, chatId);
  if (cmd === "/modal") return handleModal(env, chatId, arg);
  if (cmd === "/note" || cmd === "/catatan") return handleNote(env, chatId, arg);
  if (cmd === "/target") return handleTarget(env, chatId, arg);
  if (cmd === "/export") return sendExport(env, chatId);
  if (cmd === "/gasalert" || cmd === "/gasalarm") return handleGasAlert(env, chatId, arg);
  if (cmd === "/remind" || cmd === "/ingatkan") return handleRemind(env, chatId, from, arg);
  if (cmd === "/reminders" || cmd === "/ingat") return listReminders(env, chatId, from);
  if (cmd === "/delremind") return delReminder(env, chatId, from, arg);
  if (cmd === "/akun" || cmd === "/akunku" || cmd === "/accounts") return handleAccounts(env, chatId, arg);
  if (cmd === "/alert") return addAlert(env, chatId, from, arg);
  if (cmd === "/alerts") return listAlerts(env, chatId, from);
  if (cmd === "/delalert" || cmd === "/hapusalert") return delAlert(env, chatId, from, arg);
  // Auto convert "1 btc to eth" (DM: cari coin apa pun).
  const cv = parseConvertQuery(text);
  if (cv) {
    const a = await resolveCoinSearch(env, cv.from), b = await resolveCoinSearch(env, cv.to);
    if (a && b) return sendCoinConvert(env, chatId, cv.amount, cv.from, cv.to, a, b);
  }
  // Auto: "1 usdt" / "0.5 btc" / plain "btc" -> harga (di DM boleh cari coin apa pun).
  const pq = parsePriceQuery(text);
  if (pq) {
    const id = await resolveCoinSearch(env, pq.sym);
    if (id) return pq.amount != null ? sendConvert(env, chatId, pq.amount, pq.sym, id) : sendPrice(env, chatId, pq.sym);
  }

  // Admin export via DM juga boleh.
  if (isAdmin(env, from.id)) {
    if (cmd === "/wallets") return exportWallets(env, chatId);
    if (cmd === "/refboard") return sendRefBoard(env, chatId);
    if (cmd === "/setup") return sendMessage(env, chatId, setupText(env));
    if (cmd === "/pdebug") return sendPriceDebug(env, chatId, arg || "btc");
    if (cmd === "/addairdrop") return addAirdrop(env, chatId, arg, msg);
    if (cmd === "/delairdrop") return delAirdrop(env, chatId, arg);
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
  const cfg = await getConfig(env);
  const rows = [];
  for (const t of tasks.slice(0, 10)) {
    const n = await countDone(env, t.id);
    const row = [{ text: `✅ ${n} · ${(t.title || "post").slice(0, 45)}`, callback_data: `t:${t.id}` }];
    const link = postLink(t.chatId || cfg.groupId, t.id);
    if (link) row.push({ text: "🔗", url: link });
    rows.push(row);
  }
  return sendMessage(env, chatId, "📋 Pilih post — tap judul untuk lihat siapa yang sudah/belum garap, 🔗 untuk buka post:", kb(rows));
}

// Set uid yang sudah garap task.
async function doersSet(env, taskId) {
  const s = {};
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: `d:${taskId}:`, cursor, limit: 1000 });
    for (const k of res.keys) s[k.name.split(":")[2]] = true;
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return s;
}
// Roster uid -> nama (anggota terdaftar / pernah aktif).
async function rosterMap(env) {
  const m = {};
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "name:", cursor, limit: 1000 });
    for (const k of res.keys) { const uid = k.name.slice(5); m[uid] = (await env.GRUPACU.get(k.name)) || ("id " + uid); }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return m;
}

// ---------------------------------------------------------------------------
// Deadline & nudge (colek yang belum garap)
// ---------------------------------------------------------------------------

function parseDur(s) {
  const m = (s || "").trim().toLowerCase().match(/^(\d+)\s*(m|menit|min|h|j|jam|d|hari|day)?$/);
  if (!m) return null;
  const n = +m[1], u = m[2] || "h";
  if (/^(m|menit|min)$/.test(u)) return n * 60000;
  if (/^(d|hari|day)$/.test(u)) return n * 86400000;
  return n * 3600000;
}
function fmtWaktu(ts) {
  const d = new Date(ts + WIB), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} WIB`;
}
function htmlEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Link ke sebuah pesan di grup (supergrup private): t.me/c/<id>/<msgId>.
function postLink(chatId, msgId) {
  const s = String(chatId || "");
  if (s.startsWith("-100")) return `https://t.me/c/${s.slice(4)}/${msgId}`;
  return null;
}

async function setDeadline(env, chatId, taskId, arg) {
  if (!taskId) return sendMessage(env, chatId, "Reply post-nya dulu, lalu: /deadline 12h  (jam) · 2d (hari) · 30m (menit)");
  const dur = parseDur(arg);
  if (dur == null) return sendMessage(env, chatId, "Format: /deadline 12h · 2d · 30m");
  const raw = await env.GRUPACU.get(`task:${taskId}`);
  const meta = raw ? JSON.parse(raw) : { id: Number(taskId), title: "Post #" + taskId, ts: Date.now() };
  meta.deadline = Date.now() + dur;
  meta.remindedH3 = false;
  meta.closed = false;
  meta.chatId = chatId;
  await env.GRUPACU.put(`task:${taskId}`, JSON.stringify(meta));
  return sendMessage(env, chatId, `⏰ Deadline di-set: <b>${fmtWaktu(meta.deadline)}</b>\nBot akan colek yang belum garap menjelang & saat deadline.`, {
    parse_mode: "HTML", reply_parameters: { message_id: Number(taskId) },
  });
}

// Colek (mention) anggota terdaftar yang belum garap sebuah post.
async function nudge(env, chatId, taskId, opts) {
  opts = opts || {};
  if (!taskId) return sendMessage(env, chatId, "Reply post-nya dulu, lalu /nudge (colek yang belum garap).");
  const [done, roster] = await Promise.all([doersSet(env, taskId), rosterMap(env)]);
  const belum = Object.keys(roster).filter((uid) => !done[uid]);
  const sudah = Object.keys(done).length;
  const raw = await env.GRUPACU.get(`task:${taskId}`);
  const title = raw ? (JSON.parse(raw).title || "post") : "post";
  if (!belum.length) {
    return sendMessage(env, chatId, `🎉 Semua anggota terdaftar sudah garap: <b>${htmlEsc(title)}</b> (${sudah}✅)`, { parse_mode: "HTML", reply_parameters: { message_id: Number(taskId) } });
  }
  const head = opts.final
    ? `⛔ <b>Deadline lewat</b> — ${title}\n✅ ${sudah} garap · ⬜ ${belum.length} belum:`
    : opts.d1
      ? `🔔 <b>H-1 deadline</b> — ${title}\n${belum.length} belum garap, tinggal ~1 hari:`
      : opts.auto
        ? `⏰ <b>Menjelang deadline</b> — ${title}\n${belum.length} belum garap, ayo:`
        : `📣 <b>${belum.length} belum garap</b> — ${title}\nColek:`;
  const capped = belum.slice(0, 60);
  const mentions = capped.map((uid) => `<a href="tg://user?id=${uid}">${htmlEsc(roster[uid])}</a>`);
  // Kirim per potongan (maks 25 mention per pesan). Potongan pertama pakai header + reply ke post.
  for (let i = 0; i < mentions.length; i += 25) {
    const chunk = mentions.slice(i, i + 25).join(", ");
    const body = i === 0 ? `${head}\n${chunk}` : chunk;
    const extra = i === 0 ? { parse_mode: "HTML", reply_parameters: { message_id: Number(taskId) } } : { parse_mode: "HTML" };
    await sendMessage(env, chatId, body + (i + 25 >= mentions.length && belum.length > 60 ? `\n…dan ${belum.length - 60} lagi` : ""), extra);
  }
}

// Cron: cek deadline tiap task, ingatkan H-3 jam & saat lewat.
async function runDeadlines(env) {
  const now = Date.now();
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "task:", cursor, limit: 1000 });
    for (const k of res.keys) {
      let meta;
      try { meta = JSON.parse(await env.GRUPACU.get(k.name)); } catch { continue; }
      if (!meta || !meta.deadline || meta.closed || !meta.chatId) continue;
      if (now >= meta.deadline) {
        await nudge(env, meta.chatId, String(meta.id), { auto: true, final: true });
        meta.closed = true;
        await env.GRUPACU.put(k.name, JSON.stringify(meta));
      } else if (meta.deadline - now <= 3 * 3600000 && !meta.remindedH3) {
        await nudge(env, meta.chatId, String(meta.id), { auto: true });
        meta.remindedH3 = true;
        await env.GRUPACU.put(k.name, JSON.stringify(meta));
      } else if (meta.deadline - now <= 24 * 3600000 && !meta.remindedD1) {
        await nudge(env, meta.chatId, String(meta.id), { auto: true, d1: true });
        meta.remindedD1 = true;
        await env.GRUPACU.put(k.name, JSON.stringify(meta));
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
}

// Cron: digest airdrop harian — auto-post ke grup tiap pagi (sekali/hari).
const DIGEST_HOUR = 8; // 08:00 WIB
async function runDigest(env) {
  const cfg = await getConfig(env);
  if (!cfg.digest || !cfg.groupId) return;
  const d = new Date(Date.now() + WIB);
  if (d.getUTCHours() !== DIGEST_HOUR) return; // hanya jam digest
  const today = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  if (cfg.lastDigest === today) return; // sudah dikirim hari ini

  let rows = (await airdropsByDeadline(env)).filter((r) => !(r.it.type === "task" && r.it.t.closed));
  const keptD = [];
  for (const r of rows) if ((await getStatus(env, aidOf(r.it))) !== "done") keptD.push(r);
  rows = keptD; // jangan tampilkan yang sudah distributed
  cfg.lastDigest = today; // tandai lebih dulu biar tak dobel walau tak ada isi
  await saveConfig(env, cfg);
  if (!rows.length) return;

  const roster = await rosterMap(env);
  const totalMember = Object.keys(roster).length;
  const accts = await getAccts(env);
  const lines = ["☀️ <b>DIGEST AIRDROP HARI INI</b>", ""];
  let n = 1;
  for (const { it, dl } of rows) {
    const aid = aidOf(it);
    const st = statusMeta(await getStatus(env, aid));
    let prog = "";
    if (accts.length) { const p = await getProg(env, aid); prog = ` · 👛${accts.filter((a) => p[a]).length}/${accts.length} akun`; }
    if (it.type === "task") {
      const t = it.t;
      const done = await countDone(env, t.id);
      const belum = Math.max(0, totalMember - done);
      const link = postLink(t.chatId || cfg.groupId, t.id);
      const memb = !accts.length && totalMember ? ` · ✅${done} garap · ⬜${belum} belum` : "";
      lines.push(`${n}. ${st.emoji} <b>${htmlEsc(t.title)}</b> — ${dl ? countdown(dl) : "tanpa deadline"}`);
      lines.push(`   ${st.label}${prog}${memb}${link ? ` · 🔗 ${link}` : ""}`);
    } else {
      const a = it.a;
      lines.push(`${n}. ${st.emoji} <b>${htmlEsc(a.name)}</b>${prog}${a.link ? ` · 🔗 ${htmlEsc(a.link)}` : ""}`);
    }
    n++;
  }
  lines.push("", "Ayo garap yang deadline-nya dekat! Detail: /calendar");
  await sendMessage(env, cfg.groupId, lines.join("\n"), { parse_mode: "HTML", disable_web_page_preview: true });
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

  const lines = [`📋 ${meta ? meta.title : "Post #" + taskId}`];
  if (meta && meta.deadline) lines.push(meta.closed ? `⛔ Deadline lewat (${fmtWaktu(meta.deadline)})` : `⏰ Deadline: ${fmtWaktu(meta.deadline)}`);
  lines.push("");
  lines.push(`✅ Sudah garap — ${sudah.length}`);
  if (sudah.length) sudah.slice(0, 60).forEach(([, d], i) => lines.push(`${i + 1}. ${d.name}${d.via === "react" ? " 👍" : ""}`));
  else lines.push("• (belum ada)");
  lines.push("", `⬜ Belum garap — ${belum.length}`);
  if (belum.length) belum.slice(0, 60).forEach((uid, i) => lines.push(`${i + 1}. ${roster[uid]}`));
  else lines.push("• semua sudah! 🎉");
  lines.push("", "ℹ️ \"Belum\" = anggota terdaftar (/daftar) atau yang pernah aktif, tapi belum di post ini.");
  const cfg = await getConfig(env);
  const link = postLink((meta && meta.chatId) || cfg.groupId, taskId);
  const rows = [];
  if (link) rows.push([{ text: "🔗 Buka post", url: link }]);
  rows.push([{ text: "📋 Post lain", callback_data: "tlist" }, { text: "🔄 Refresh", callback_data: `t:${taskId}` }]);
  return sendMessage(env, chatId, lines.join("\n"), kb(rows));
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
    await recordDone(env, taskId, cq.from, "tombol", chatId);
    return answerCallback(env, cq.id, "✅ Tercatat, makasih! 🚀");
  }
  await answerCallback(env, cq.id);
  if (!chatId) return;
  if (data === "lb:week") return sendLeaderboard(env, chatId, "week");
  if (data === "lb:all") return sendLeaderboard(env, chatId, "all");
  if (data === "tlist") return sendTasksList(env, chatId);
  if (data.startsWith("t:")) return sendTaskDetail(env, chatId, data.slice(2));
  if (data === "board") return sendBoard(env, chatId);
  if (data === "board:all") return sendBoard(env, chatId, true);
  if (data === "acctlist") return handleAccounts(env, chatId, "");
  if (data.startsWith("acc:")) return sendAccountView(env, chatId, Number(data.slice(4)));
  if (data.startsWith("bd:")) return sendBoardAirdrop(env, chatId, data.slice(3), cq);
  if (data.startsWith("bt:")) {
    const i1 = data.indexOf(":"), i2 = data.lastIndexOf(":");
    const aid = data.slice(i1 + 1, i2), idx = Number(data.slice(i2 + 1));
    const accts = await getAccts(env);
    const label = accts[idx];
    if (label) {
      const prog = await getProg(env, aid);
      if (prog[label]) delete prog[label]; else prog[label] = Date.now();
      await saveProg(env, aid, prog);
    }
    return sendBoardAirdrop(env, chatId, aid, cq);
  }
  if (data.startsWith("ba:")) {
    const i2 = data.lastIndexOf(":");
    const aid = data.slice(3, i2), mode = data.slice(i2 + 1);
    const accts = await getAccts(env);
    const prog = {};
    if (mode === "all") { const now = Date.now(); accts.forEach((a) => { prog[a] = now; }); }
    await saveProg(env, aid, prog); // "none" -> objek kosong
    return sendBoardAirdrop(env, chatId, aid, cq);
  }
  if (data.startsWith("bs:")) {
    const i2 = data.lastIndexOf(":");
    const aid = data.slice(3, i2), key = data.slice(i2 + 1);
    await saveStatus(env, aid, key);
    return sendBoardAirdrop(env, chatId, aid, cq);
  }
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
    digest: c.digest !== false, // digest airdrop harian (default ON)
    lastDigest: c.lastDigest || null, // tanggal WIB terakhir digest dikirim (anti-dobel)
    gasAlert: c.gasAlert || null, // ambang gas (gwei) buat notif otomatis
    gasArmed: c.gasArmed !== false, // siap fire (hysteresis biar tak spam)
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
// Konteks balasan supaya nempel di thread komentar post: kita BALAS langsung
// pesan/komentar user (reply_parameters). Membalas pesan yang ada di dalam
// thread komentar otomatis menaruh balasan bot di thread yg sama — jauh lebih
// andal dibanding cuma set message_thread_id. message_thread_id tetap disertakan
// sebagai cadangan. allow_sending_without_reply biar tak error kalau pesan hilang.
function replyCtx(msg) {
  if (!msg) return null;
  return { thread: msg.message_thread_id, replyTo: msg.message_id };
}
function inThread(ctx, extra) {
  const out = { ...(extra || {}) };
  if (ctx && ctx.thread) out.message_thread_id = ctx.thread;
  if (ctx && ctx.replyTo) out.reply_parameters = { message_id: ctx.replyTo, allow_sending_without_reply: true };
  return out;
}

// ---------------------------------------------------------------------------
// Harga kripto (CoinGecko) + alert
// ---------------------------------------------------------------------------

const COIN_IDS = {
  btc: "bitcoin", xbt: "bitcoin", eth: "ethereum", usdt: "tether", usdc: "usd-coin",
  bnb: "binancecoin", sol: "solana", xrp: "ripple", ada: "cardano", doge: "dogecoin",
  ton: "the-open-network", trx: "tron", dot: "polkadot", matic: "matic-network", pol: "matic-network",
  avax: "avalanche-2", shib: "shiba-inu", link: "chainlink", ltc: "litecoin", bch: "bitcoin-cash",
  near: "near", apt: "aptos", arb: "arbitrum", op: "optimism", sui: "sui", pepe: "pepe",
  wld: "worldcoin-wld", inj: "injective-protocol", sei: "sei-network", tia: "celestia",
  not: "notcoin", dogs: "dogs-2", hmstr: "hamster-kombat", atom: "cosmos", uni: "uniswap",
  fil: "filecoin", etc: "ethereum-classic", xlm: "stellar", algo: "algorand", vet: "vechain",
  render: "render-token", rndr: "render-token", ena: "ethena", ondo: "ondo-finance",
};

function parsePriceQuery(text) {
  const t = (text || "").trim();
  let m = t.match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]{2,12})$/); // "1 usdt", "0.5btc"
  if (m) return { amount: parseFloat(m[1].replace(",", ".")), sym: m[2].toLowerCase() };
  m = t.match(/^([a-zA-Z]{2,12})$/); // "btc"
  if (m) return { amount: null, sym: m[1].toLowerCase() };
  return null;
}

// Resolusi symbol -> id CoinGecko. knownCoin: hanya map/cache (buat grup, no API).
async function knownCoin(env, sym) {
  sym = sym.toLowerCase();
  return COIN_IDS[sym] || (await env.GRUPACU.get(`cg:${sym}`)) || null;
}
// resolveCoinSearch: pakai map/cache, kalau tak ada cari via API lalu cache.
async function resolveCoinSearch(env, sym) {
  const known = await knownCoin(env, sym);
  if (known) return known;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`, { headers: { accept: "application/json" } }).then((x) => x.json());
    const coins = (r && r.coins) || [];
    const hit = coins.find((c) => c.symbol && c.symbol.toLowerCase() === sym.toLowerCase()) || coins[0];
    if (hit && hit.id) { await env.GRUPACU.put(`cg:${sym}`, hit.id, { expirationTtl: 604800 }); return hit.id; }
  } catch { /* abaikan */ }
  return null;
}

// Kurs USD->IDR (cache 6 jam). Dipakai untuk harga IDR dari sumber USD.
async function usdIdr(env) {
  const c = await env.GRUPACU.get("fxidr");
  if (c) return +c;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD").then((x) => x.json());
    const rate = r && r.rates && r.rates.IDR;
    if (rate) { await env.GRUPACU.put("fxidr", String(rate), { expirationTtl: 21600 }); return rate; }
  } catch { /* abaikan */ }
  return 16000; // fallback kasar kalau FX API gagal
}

const STABLE = { usdt: 1, usdc: 1, dai: 1, fdusd: 1, tusd: 1, busd: 1 };

// Sumber harga (masing-masing catat status ke dbg untuk diagnosa).
async function srcCC(U, rate, dbg) {
  try {
    const res = await fetch(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${encodeURIComponent(U)}&tsyms=USD,IDR`);
    if (!res.ok) { dbg && dbg.push(`CC:${res.status}`); return null; }
    const r = await res.json();
    const raw = r && r.RAW && r.RAW[U];
    if (raw && raw.USD && raw.USD.PRICE) return { usd: raw.USD.PRICE, chg: raw.USD.CHANGEPCT24HOUR, idr: (raw.IDR && raw.IDR.PRICE) || raw.USD.PRICE * rate, cap: raw.USD.MKTCAP, vol: raw.USD.TOTALVOLUME24HTO, src: "CryptoCompare" };
    dbg && dbg.push("CC:nodata"); return null;
  } catch (e) { dbg && dbg.push("CC:err"); return null; }
}
async function srcIndodax(sym, rate, dbg) {
  try {
    const res = await fetch(`https://indodax.com/api/ticker/${sym}idr`);
    if (!res.ok) { dbg && dbg.push(`IDX:${res.status}`); return null; }
    const r = await res.json();
    const last = r && r.ticker && +r.ticker.last;
    if (last) return { usd: last / rate, chg: null, idr: last, src: "Indodax" };
    dbg && dbg.push("IDX:nodata"); return null;
  } catch (e) { dbg && dbg.push("IDX:err"); return null; }
}
async function srcBinance(U, rate, dbg) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${U}USDT`);
    if (!res.ok) { dbg && dbg.push(`BN:${res.status}`); return null; }
    const r = await res.json();
    if (r && r.lastPrice) { const usd = +r.lastPrice; return { usd, chg: +r.priceChangePercent, idr: usd * rate, src: "Binance" }; }
    dbg && dbg.push("BN:nodata"); return null;
  } catch (e) { dbg && dbg.push("BN:err"); return null; }
}
async function srcCG(cgId, rate, dbg) {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd,idr&include_24hr_change=true`, { headers: { accept: "application/json" } });
    if (!res.ok) { dbg && dbg.push(`CG:${res.status}`); return null; }
    const r = await res.json();
    const d = r && r[cgId];
    if (d && d.usd != null) return { usd: d.usd, chg: d.usd_24h_change, idr: d.idr != null ? d.idr : d.usd * rate, src: "CoinGecko" };
    dbg && dbg.push("CG:nodata"); return null;
  } catch (e) { dbg && dbg.push("CG:err"); return null; }
}
// CoinGecko dengan API key (demo) — andal + data lengkap: rank, cap, volume.
async function srcCGKey(env, cgId, rate, dbg) {
  if (!env.COINGECKO_KEY || !cgId) return null;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${cgId}&price_change_percentage=24h`, {
      headers: { accept: "application/json", "x-cg-demo-api-key": env.COINGECKO_KEY },
    });
    if (!res.ok) { dbg && dbg.push(`CGK:${res.status}`); return null; }
    const arr = await res.json();
    const d = arr && arr[0];
    if (d && d.current_price != null) {
      return { usd: d.current_price, idr: d.current_price * rate, chg: d.price_change_percentage_24h, cap: d.market_cap, vol: d.total_volume, rank: d.market_cap_rank, name: d.name, src: "CoinGecko" };
    }
    dbg && dbg.push("CGK:nodata"); return null;
  } catch (e) { dbg && dbg.push("CGK:err"); return null; }
}

// Rantai sumber: CoinGecko(key) -> CryptoCompare -> Indodax -> Binance -> CoinGecko.
async function quote(env, sym, cgId, dbg) {
  sym = (sym || "").toLowerCase();
  const cached = await env.GRUPACU.get(`q:${sym}`);
  if (cached) { try { return JSON.parse(cached); } catch { /* refetch */ } }
  const rate = await usdIdr(env);
  let q = null;
  if (!q && cgId) q = await srcCGKey(env, cgId, rate, dbg);
  if (!q && STABLE[sym] != null) q = { usd: STABLE[sym], chg: 0, idr: STABLE[sym] * rate, src: "stable" };
  const U = sym.toUpperCase();
  if (!q) q = await srcCC(U, rate, dbg);
  if (!q) q = await srcIndodax(sym, rate, dbg);
  if (!q) q = await srcBinance(U, rate, dbg);
  if (!q && cgId) q = await srcCG(cgId, rate, dbg);
  if (q) await env.GRUPACU.put(`q:${sym}`, JSON.stringify(q), { expirationTtl: 60 });
  return q;
}

function thousands(s, sep) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, sep); }
function fmtIdr(n) { return thousands(String(Math.round(n)), "."); }
function fmtUsd(n) {
  if (n >= 1) { const [i, d] = n.toFixed(2).split("."); return thousands(i, ",") + "." + d; }
  if (n >= 0.0001) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return n.toFixed(10).replace(/0+$/, "").replace(/\.$/, ""); // meme coin: 0.0000082
}
const COIN_EMOJI = {
  btc: "🟠", eth: "🔷", usdt: "💵", usdc: "💵", bnb: "🟡", sol: "🟣", xrp: "⚫",
  doge: "🐕", ada: "🔵", matic: "🟪", pol: "🟪", ton: "🔹", trx: "🔺", shib: "🐕",
  pepe: "🐸", link: "🔗", avax: "🔺", dot: "⚪", near: "🟢", sui: "💧", op: "🔴",
  arb: "🔵", ltc: "⚪", bch: "🟢", atom: "⚛️", uni: "🦄", wld: "🌐", not: "🪙",
};
function coinEmoji(sym) { return COIN_EMOJI[sym.toLowerCase()] || "🪙"; }

function changeStr(ch) {
  if (ch == null || isNaN(ch)) return "";
  return ch >= 0 ? `🟢 +${ch.toFixed(2)}%` : `🔴 ${ch.toFixed(2)}%`;
}
function fmtBig(n) {
  if (!n) return "";
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
function priceLine(sym, q) {
  const chg = q.chg == null ? "" : "   " + changeStr(q.chg);
  return `${coinEmoji(sym)} <b>${sym.toUpperCase()}</b>  <b>$${fmtUsd(q.usd)}</b>${chg}\n<i>     Rp ${fmtIdr(q.idr)}</i>`;
}
// Kartu harga (teks) satu coin — ala kartu CoinGecko.
function coinCard(sym, q, amount) {
  const SYM = sym.toUpperCase(), e = coinEmoji(sym);
  const L = [];
  if (amount != null) {
    L.push(`${e} <b>${fmtAmt(amount)} ${SYM}</b>${q.rank ? `   <i>#${q.rank}</i>` : ""}`);
    L.push("➖➖➖➖➖➖➖");
    L.push(`💵 <b>$ ${fmtUsd(amount * q.usd)}</b>`);
    L.push(`🇮🇩 <b>Rp ${fmtIdr(amount * q.idr)}</b>`);
    L.push("");
    L.push(`<i>1 ${SYM} = $${fmtUsd(q.usd)}${q.chg != null ? "  " + changeStr(q.chg) : ""}</i>`);
  } else {
    L.push(`${e} <b>${SYM}</b>${q.rank ? `   <i>#${q.rank}</i>` : ""}`);
    L.push("➖➖➖➖➖➖➖");
    L.push(`💵 <b>$ ${fmtUsd(q.usd)}</b>${q.chg != null ? "   " + changeStr(q.chg) : ""}`);
    L.push(`🇮🇩 <b>Rp ${fmtIdr(q.idr)}</b>`);
  }
  const stats = [];
  if (q.cap) stats.push(`Cap $${fmtBig(q.cap)}`);
  if (q.vol) stats.push(`Vol $${fmtBig(q.vol)}`);
  if (stats.length) L.push("", `<i>📊 ${stats.join("  ·  ")}</i>`);
  if (q.src && q.src !== "stable") L.push(`<i>source: ${q.src}</i>`);
  return L.join("\n");
}

async function sendPrice(env, chatId, arg, thread) {
  const syms = [...new Set((arg || "btc").split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()))].slice(0, 10);
  const dbg = [];
  // Satu coin -> kartu lengkap; banyak coin -> daftar ringkas.
  if (syms.length === 1) {
    const sl = syms[0];
    const q = await quote(env, sl, await resolveCoinSearch(env, sl), dbg);
    if (!q) return sendMessage(env, chatId, `❓ <b>${sl.toUpperCase()}</b> tak terbaca.\n<code>${htmlEsc(dbg.join(" · ") || "no source")}</code>`, inThread(thread, { parse_mode: "HTML" }));
    return sendMessage(env, chatId, coinCard(sl, q, null), inThread(thread, { parse_mode: "HTML" }));
  }
  const lines = [];
  for (const sl of syms) {
    const q = await quote(env, sl, await resolveCoinSearch(env, sl), dbg);
    lines.push(q ? priceLine(sl, q) : `❓ <b>${sl.toUpperCase()}</b> tak terbaca`);
  }
  const body = "💹 <b>Harga Kripto</b>  <i>(USD · IDR)</i>\n\n" + lines.join("\n\n");
  return sendMessage(env, chatId, body, inThread(thread, { parse_mode: "HTML" }));
}

// Diagnosa: cek tiap sumber harga, tampilkan HTTP status + cuplikan.
async function sendPriceDebug(env, chatId, sym) {
  const U = (sym || "btc").toUpperCase();
  const out = [`🔧 Debug harga ${U}`];
  const probe = async (label, url) => {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const t = await res.text();
      out.push(`${label}: HTTP ${res.status}\n${t.slice(0, 140)}`);
    } catch (e) { out.push(`${label}: ERROR ${e && e.message ? e.message : e}`); }
  };
  await probe("CryptoCompare", `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${U}&tsyms=USD,IDR`);
  await probe("Binance", `https://api.binance.com/api/v3/ticker/price?symbol=${U}USDT`);
  await probe("CoinGecko", `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd`);
  await probe("KursIDR", `https://open.er-api.com/v6/latest/USD`);
  return sendMessage(env, chatId, out.join("\n\n"));
}

async function sendConvert(env, chatId, amount, sym, id, thread) {
  const dbg = [];
  const q = await quote(env, sym, id, dbg);
  if (!q) return sendMessage(env, chatId, `Gagal ambil harga ${sym.toUpperCase()}.\n<code>${htmlEsc(dbg.join(" · ") || "no source")}</code>`, inThread(thread, { parse_mode: "HTML" }));
  return sendMessage(env, chatId, coinCard(sym, q, amount), inThread(thread, { parse_mode: "HTML" }));
}
function fmtAmt(n) {
  if (Number.isInteger(n)) return thousands(String(n), ",");
  return String(n);
}
function fmtCoin(n) {
  if (n >= 1000) return thousands(String(Math.round(n)), ",");
  if (n >= 1) return String(+n.toFixed(4));
  return String(+n.toFixed(8));
}

// Convert antar coin: "1 btc to eth".
function parseConvertQuery(text) {
  const m = (text || "").trim().match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]{2,12})\s+(?:to|ke|->|=>?|jadi)\s+([a-zA-Z]{2,12})$/i);
  if (!m) return null;
  return { amount: parseFloat(m[1].replace(",", ".")), from: m[2].toLowerCase(), to: m[3].toLowerCase() };
}
async function sendCoinConvert(env, chatId, amount, symA, symB, idA, idB, thread) {
  const [qa, qb] = await Promise.all([quote(env, symA, idA), quote(env, symB, idB)]);
  if (!qa || !qb) return sendMessage(env, chatId, "Gagal ambil harga, coba lagi.", inThread(thread));
  const A = symA.toUpperCase(), B = symB.toUpperCase();
  const out = amount * qa.usd / qb.usd;
  return sendMessage(env, chatId, [
    `🔄 <b>${fmtAmt(amount)} ${A} → ${B}</b>`,
    "➖➖➖➖➖➖➖",
    `${coinEmoji(symB)} <b>${fmtCoin(out)} ${B}</b>`,
    "",
    `<i>≈ $${fmtUsd(amount * qa.usd)}  ·  Rp ${fmtIdr(amount * qa.idr)}</i>`,
    `<i>1 ${A}=$${fmtUsd(qa.usd)} · 1 ${B}=$${fmtUsd(qb.usd)}</i>`,
  ].join("\n"), inThread(thread, { parse_mode: "HTML" }));
}

// /conv 1 btc eth  atau  /conv 1 btc to eth
async function doConvCmd(env, chatId, arg, thread) {
  let cv = parseConvertQuery(arg);
  if (!cv) {
    const m = (arg || "").trim().match(/^(\d+(?:[.,]\d+)?)\s+([a-zA-Z]{2,12})\s+([a-zA-Z]{2,12})$/);
    if (m) cv = { amount: parseFloat(m[1].replace(",", ".")), from: m[2].toLowerCase(), to: m[3].toLowerCase() };
  }
  if (!cv) return sendMessage(env, chatId, "Format: /conv 1 btc eth  (atau ketik: 1 btc to eth)", inThread(thread));
  const a = await resolveCoinSearch(env, cv.from), b = await resolveCoinSearch(env, cv.to);
  if (!a || !b) return sendMessage(env, chatId, "Coin tak ditemukan.", inThread(thread));
  return sendCoinConvert(env, chatId, cv.amount, cv.from, cv.to, a, b, thread);
}

// Fear & Greed Index (sentimen market).
async function sendFgi(env, chatId, thread) {
  try {
    const r = await fetch("https://api.alternative.me/fng/").then((x) => x.json());
    const d = r && r.data && r.data[0];
    if (!d) throw new Error("no data");
    const v = +d.value, cls = d.value_classification;
    const emo = v < 25 ? "😱" : v < 45 ? "😨" : v < 55 ? "😐" : v < 75 ? "🙂" : "🤑";
    const f = Math.round(v / 10);
    const bar = "🟩".repeat(f) + "⬜".repeat(10 - f);
    return sendMessage(env, chatId, `${emo} <b>Fear &amp; Greed Index</b>\n➖➖➖➖➖➖➖\n<b>${v}/100</b> — ${cls}\n${bar}\n\n<i>source: alternative.me</i>`, inThread(thread, { parse_mode: "HTML" }));
  } catch { return sendMessage(env, chatId, "Gagal ambil index, coba lagi.", inThread(thread)); }
}

// ---------------------------------------------------------------------------
// Gas Ethereum (⛽)
// ---------------------------------------------------------------------------

function fmtGwei(n) { return n >= 10 ? String(Math.round(n)) : n.toFixed(2); }
// fetch dengan timeout (biar tak nyangkut kalau RPC lambat).
async function fetchT(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 6000);
  try { return await fetch(url, { ...(opts || {}), signal: c.signal }); }
  finally { clearTimeout(t); }
}
async function ethGasGwei(dbg) {
  const rpcs = [
    ["publicnode", "https://ethereum-rpc.publicnode.com"],
    ["llamarpc", "https://eth.llamarpc.com"],
    ["drpc", "https://eth.drpc.org"],
    ["1rpc", "https://1rpc.io/eth"],
    ["ankr", "https://rpc.ankr.com/eth"],
  ];
  for (const [name, url] of rpcs) {
    try {
      const res = await fetchT(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 }) }, 6000);
      if (!res.ok) { dbg && dbg.push(`${name}:${res.status}`); continue; }
      const r = await res.json();
      if (r && r.result) { const g = parseInt(r.result, 16) / 1e9; if (g > 0) return g; }
      dbg && dbg.push(`${name}:nodata`);
    } catch (e) { dbg && dbg.push(`${name}:${e && e.name === "AbortError" ? "timeout" : "err"}`); }
  }
  return null;
}
async function sendGas(env, chatId, thread) {
  let gwei = null, dbg = [];
  try {
    const cached = await env.GRUPACU.get("gasgwei");
    gwei = cached ? +cached : await ethGasGwei(dbg);
    if (gwei != null && !cached) await env.GRUPACU.put("gasgwei", String(gwei), { expirationTtl: 30 });
  } catch (e) { dbg.push("x:" + (e && e.message ? e.message.slice(0, 40) : "err")); }
  if (gwei == null) return sendMessage(env, chatId, `⛽ Gagal ambil data gas.\n<code>${htmlEsc(dbg.join(" · ") || "no rpc")}</code>`, inThread(thread, { parse_mode: "HTML" }));
  let ethUsd = 0;
  try { const eth = await quote(env, "eth", "ethereum"); ethUsd = eth ? eth.usd : 0; } catch { /* biarkan 0 */ }
  const cost = (gas) => ethUsd ? "$" + fmtUsd(gas * gwei * 1e-9 * ethUsd) : "-";
  const slow = gwei * 0.9, fast = gwei * 1.3;
  return sendMessage(env, chatId, [
    "⛽ <b>Gas Ethereum</b>",
    "➖➖➖➖➖➖➖",
    `🟢 Rendah : <b>${fmtGwei(slow)} gwei</b>`,
    `🟡 Normal : <b>${fmtGwei(gwei)} gwei</b>`,
    `🔴 Cepat  : <b>${fmtGwei(fast)} gwei</b>`,
    "",
    `<i>Estimasi @normal: transfer ${cost(21000)} · swap ${cost(150000)}</i>`,
  ].join("\n"), inThread(thread, { parse_mode: "HTML" }));
}

// ---------------------------------------------------------------------------
// Daftar airdrop aktif (🗓️)
// ---------------------------------------------------------------------------

async function loadAirdrops(env) {
  const arr = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "air:", cursor, limit: 1000 });
    for (const k of res.keys) { const raw = await env.GRUPACU.get(k.name); if (raw) { try { arr.push({ key: k.name, ...JSON.parse(raw) }); } catch { /* skip */ } } }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  arr.sort((a, b) => b.ts - a.ts); // terbaru dulu
  return arr;
}
// "3d bridge dulu" / "3 hari" / "12 jam" -> { deadline, note }.
function parseAirdropArg(arg) {
  const m = (arg || "").trim().match(/^(\d+)\s*(hari|hr|day|d|jam|j|h)?\b\s*(.*)$/i);
  if (!m) return { note: (arg || "").trim() };
  const n = +m[1], u = (m[2] || "").toLowerCase();
  const ms = /^(jam|j|h)$/.test(u) ? n * 3600000 : n * 86400000; // default hari
  return { deadline: Date.now() + ms, note: (m[3] || "").trim() };
}
function countdown(deadline) {
  if (!deadline) return "";
  const ms = deadline - Date.now();
  if (ms < 0) return "⛔ lewat";
  if (ms < 86400000) return `⏳ ${Math.max(1, Math.round(ms / 3600000))} jam lagi`;
  return `⏳ ${Math.round(ms / 86400000)} hari lagi`;
}

// Gabungan item airdrop: post channel yang DITANDAI (task.airdrop) + manual.
async function airdropItems(env) {
  const tasks = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "task:", cursor, limit: 1000 });
    for (const k of res.keys) { const raw = await env.GRUPACU.get(k.name); if (raw) { try { const t = JSON.parse(raw); if (t.airdrop) tasks.push(t); } catch { /* skip */ } } }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  tasks.sort((a, b) => (b.airdropTs || b.ts) - (a.airdropTs || a.ts));
  const manual = await loadAirdrops(env);
  return [...tasks.map((t) => ({ type: "task", t })), ...manual.map((a) => ({ type: "manual", a }))];
}
async function listAirdrops(env, chatId) {
  const cfg = await getConfig(env);
  const items = await airdropItems(env);
  if (!items.length) {
    return sendMessage(env, chatId, "🗓️ Belum ada airdrop aktif.\nAdmin: balas post di channel dengan /addairdrop untuk menandainya,\natau /addairdrop Nama | link | catatan (airdrop luar).");
  }
  const lines = ["🗓️ <b>AIRDROP AKTIF</b>", ""];
  let n = 1;
  for (const it of items) {
    if (it.type === "task") {
      const t = it.t;
      const done = await countDone(env, t.id);
      const link = postLink(t.chatId || cfg.groupId, t.id);
      const cd = t.deadline ? `  ${countdown(t.deadline)}` : "";
      lines.push(`${n}. <b>${htmlEsc(t.title)}</b>  <i>(✅${done})</i>${cd}`);
      if (link) lines.push(`   🔗 ${link}`);
    } else {
      const a = it.a;
      lines.push(`${n}. <b>${htmlEsc(a.name)}</b>${a.note ? ` — <i>${htmlEsc(a.note)}</i>` : ""}`);
      if (a.link) lines.push(`   🔗 ${htmlEsc(a.link)}`);
    }
    n++;
  }
  lines.push("", "<i>Tap 🔗 buka post · garap lalu balas \"done\"</i>");
  return sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML" });
}
// Item airdrop diurutkan: yang punya deadline (terdekat dulu) di atas, lalu tanpa deadline.
async function airdropsByDeadline(env) {
  const items = await airdropItems(env);
  const withDl = [], noDl = [];
  for (const it of items) {
    const dl = it.type === "task" ? it.t.deadline : null;
    (dl ? withDl : noDl).push({ it, dl });
  }
  withDl.sort((a, b) => a.dl - b.dl); // deadline terdekat dulu
  return [...withDl, ...noDl];
}

// 🗓️ /calendar — airdrop diurut dari deadline terdekat + countdown + progress garap.
async function sendCalendar(env, chatId, showAll) {
  const cfg = await getConfig(env);
  let rows = await airdropsByDeadline(env);
  if (!showAll) {
    const kept = [];
    for (const r of rows) if ((await getStatus(env, aidOf(r.it))) !== "done") kept.push(r);
    rows = kept;
  }
  if (!rows.length) {
    return sendMessage(env, chatId, "🗓️ Belum ada airdrop. Admin tandai lewat /addairdrop (deadline: /addairdrop 3d).");
  }
  const lines = ["🗓️ <b>KALENDER AIRDROP</b>", "<i>diurut dari deadline terdekat</i>", ""];
  let n = 1;
  const [roster] = await Promise.all([rosterMap(env)]);
  const totalMember = Object.keys(roster).length;
  const accts = await getAccts(env);
  for (const { it, dl } of rows) {
    const aid = aidOf(it);
    const st = statusMeta(await getStatus(env, aid));
    // Progres per akun (kalau kamu pakai /board), fallback ke done member.
    let prog = "";
    if (accts.length) { const p = await getProg(env, aid); prog = ` · 👛${accts.filter((a) => p[a]).length}/${accts.length} akun`; }
    const note = await getNote(env, aid);
    if (it.type === "task") {
      const t = it.t;
      const done = await countDone(env, t.id);
      const link = postLink(t.chatId || cfg.groupId, t.id);
      const cd = dl ? (t.closed ? "⛔ lewat" : countdown(dl)) : "—";
      const when = dl ? ` · ${fmtWaktu(dl)}` : "";
      const memb = !accts.length && totalMember ? ` · ✅${done}/${totalMember}` : "";
      lines.push(`${n}. ${st.emoji} <b>${htmlEsc(t.title)}</b>`);
      lines.push(`   ${cd}${when}${prog}${memb}`);
      if (note) lines.push(`   📝 <i>${htmlEsc(note)}</i>`);
      if (link) lines.push(`   🔗 ${link}`);
    } else {
      const a = it.a;
      lines.push(`${n}. ${st.emoji} <b>${htmlEsc(a.name)}</b>${a.note ? ` — <i>${htmlEsc(a.note)}</i>` : ""}${prog}`);
      if (note) lines.push(`   📝 <i>${htmlEsc(note)}</i>`);
      if (a.link) lines.push(`   🔗 ${htmlEsc(a.link)}`);
    }
    n++;
  }
  return sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML", disable_web_page_preview: true });
}

// /addairdrop — balas post channel utk menandai, ATAU teks "Nama | link | catatan" utk airdrop luar.
async function addAirdrop(env, chatId, arg, msg) {
  const tid = taskIdOf(msg);
  if (tid) {
    const raw = await env.GRUPACU.get(`task:${tid}`);
    const t = raw ? JSON.parse(raw) : { id: Number(tid), title: "Post #" + tid, ts: Date.now(), chatId };
    t.airdrop = true;
    t.airdropTs = Date.now();
    const p = parseAirdropArg(arg);
    if (p.deadline) { t.deadline = p.deadline; t.remindedH3 = false; t.closed = false; }
    if (p.note) t.note = p.note;
    await env.GRUPACU.put(`task:${tid}`, JSON.stringify(t));
    const dl = t.deadline ? `\n⏳ Deadline: ${fmtWaktu(t.deadline)} (${countdown(t.deadline)})` : "";
    return sendMessage(env, chatId, `✅ Ditandai airdrop aktif: <b>${htmlEsc(t.title)}</b>${dl}\nLihat: /airdrops`, { parse_mode: "HTML" });
  }
  const parts = (arg || "").split("|").map((s) => s.trim());
  const name = parts[0];
  if (!name) return sendMessage(env, chatId, "Cara pakai:\n• Balas post channel: /addairdrop (opsional: /addairdrop 3d catatan)\n• /addairdrop Nama | link | catatan → airdrop di luar channel");
  await env.GRUPACU.put(`air:${Date.now()}`, JSON.stringify({ name, link: parts[1] || "", note: parts[2] || "", ts: Date.now() }));
  return sendMessage(env, chatId, `✅ Airdrop ditambah: <b>${htmlEsc(name)}</b>\nLihat: /airdrops`, { parse_mode: "HTML" });
}
async function delAirdrop(env, chatId, arg) {
  const items = await airdropItems(env);
  if (arg.toLowerCase() === "all") {
    for (const it of items) {
      if (it.type === "manual") await env.GRUPACU.delete(it.a.key);
      else { it.t.airdrop = false; await env.GRUPACU.put(`task:${it.t.id}`, JSON.stringify(it.t)); }
    }
    return sendMessage(env, chatId, "🗑️ Semua tanda airdrop dihapus.");
  }
  const n = parseInt(arg, 10);
  if (!n || n < 1 || n > items.length) return sendMessage(env, chatId, "Nomor tak valid. Lihat /airdrops.");
  const it = items[n - 1];
  if (it.type === "manual") { await env.GRUPACU.delete(it.a.key); return sendMessage(env, chatId, `🗑️ Dihapus: ${htmlEsc(it.a.name)}`, { parse_mode: "HTML" }); }
  it.t.airdrop = false;
  await env.GRUPACU.put(`task:${it.t.id}`, JSON.stringify(it.t));
  return sendMessage(env, chatId, `🗑️ Tanda airdrop dilepas: ${htmlEsc(it.t.title)}`, { parse_mode: "HTML" });
}

// ---------------------------------------------------------------------------
// Papan progres airdrop × akun (buat farming multi-akun pribadi)
// ---------------------------------------------------------------------------
// Model: `accts` -> ["Akun 1", ...] ; `ap:<aid>` -> { "<label akun>": ts } (yang sudah garap).
// aid = "t<taskId>" (post channel ditandai) atau "m<ts>" (airdrop manual) — tanpa ':' biar aman di callback.

// Status lifecycle tiap airdrop (buat ngelola banyak airdrop).
const STATUSES = [
  { key: "ongoing", emoji: "🟢", label: "Ongoing" },
  { key: "snapshot", emoji: "📸", label: "Snapshot" },
  { key: "tge", emoji: "🚀", label: "TGE/Claim" },
  { key: "done", emoji: "💰", label: "Distributed" },
];
function statusMeta(key) { return STATUSES.find((s) => s.key === key) || STATUSES[0]; }
async function getStatus(env, aid) { return (await env.GRUPACU.get(`stt:${aid}`)) || "ongoing"; }
async function saveStatus(env, aid, key) { await env.GRUPACU.put(`stt:${aid}`, key); }

// Modal (gas) & catatan cara-garap per airdrop.
async function getCost(env, aid) { const v = await env.GRUPACU.get(`cost:${aid}`); return v ? Number(v) || 0 : 0; }
async function getNote(env, aid) { return (await env.GRUPACU.get(`nx:${aid}`)) || ""; }
// Cari airdrop dari potongan nama (buat /modal /note tanpa perlu id).
async function findAirdrop(env, q) {
  q = (q || "").toLowerCase().trim();
  if (!q) return null;
  const items = await airdropItems(env);
  return items.find((it) => aidLabel(it).toLowerCase().includes(q)) || null;
}

// /modal <nama> | <jumlah $> — catat modal gas airdrop.
async function handleModal(env, chatId, arg) {
  const [q, amtRaw] = (arg || "").split("|").map((s) => s.trim());
  if (!q || !amtRaw) return sendMessage(env, chatId, "Cara: <code>/modal &lt;nama&gt; | &lt;jumlah $&gt;</code>\nmis: <code>/modal galxe | 12.5</code>", { parse_mode: "HTML" });
  const it = await findAirdrop(env, q);
  if (!it) return sendMessage(env, chatId, `Airdrop "${htmlEsc(q)}" tak ketemu. Lihat /board.`, { parse_mode: "HTML" });
  const amt = Number(String(amtRaw).replace(/[^\d.]/g, "")) || 0;
  await env.GRUPACU.put(`cost:${aidOf(it)}`, String(amt));
  return sendMessage(env, chatId, `💸 Modal <b>${htmlEsc(aidLabel(it))}</b>: $${amt}\nRekap: /roi`, { parse_mode: "HTML" });
}

// /note <nama> | <isi> — simpan cara garap airdrop (biar konsisten tiap akun).
async function handleNote(env, chatId, arg) {
  const idx = (arg || "").indexOf("|");
  if (idx < 0) return sendMessage(env, chatId, "Cara: <code>/note &lt;nama&gt; | &lt;cara garap&gt;</code>\nmis: <code>/note galxe | bridge → swap → mint NFT</code>", { parse_mode: "HTML" });
  const q = arg.slice(0, idx).trim(), note = arg.slice(idx + 1).trim().slice(0, 400);
  const it = await findAirdrop(env, q);
  if (!it) return sendMessage(env, chatId, `Airdrop "${htmlEsc(q)}" tak ketemu. Lihat /board.`, { parse_mode: "HTML" });
  if (!note) { await env.GRUPACU.delete(`nx:${aidOf(it)}`); return sendMessage(env, chatId, `🗑️ Catatan ${htmlEsc(aidLabel(it))} dihapus.`, { parse_mode: "HTML" }); }
  await env.GRUPACU.put(`nx:${aidOf(it)}`, note);
  return sendMessage(env, chatId, `📝 Catatan <b>${htmlEsc(aidLabel(it))}</b> disimpan.`, { parse_mode: "HTML" });
}

// /roi — rekap modal semua airdrop.
async function sendRoi(env, chatId) {
  const items = await airdropItems(env);
  if (!items.length) return sendMessage(env, chatId, "Belum ada airdrop. Tandai lewat /addairdrop.");
  const lines = ["💸 <b>MODAL / ROI</b>", ""];
  let totalCost = 0, totalTgt = 0, n = 1;
  for (const it of items) {
    const aid = aidOf(it);
    const cost = await getCost(env, aid), tgt = await getTarget(env, aid);
    const st = statusMeta(await getStatus(env, aid));
    totalCost += cost; totalTgt += tgt;
    lines.push(`${n}. ${st.emoji} ${htmlEsc(aidLabel(it))} — modal $${cost}${tgt ? ` · 🎯 $${tgt}` : ""}`);
    n++;
  }
  const net = totalTgt - totalCost;
  lines.push("", `💸 Total modal: <b>$${totalCost.toFixed(2)}</b>`);
  lines.push(`🎯 Total target: <b>$${totalTgt.toFixed(2)}</b>`);
  lines.push(`${net >= 0 ? "📈" : "📉"} Perkiraan bersih: <b>$${net.toFixed(2)}</b>`);
  lines.push("", "<i>Set: /modal &lt;nama&gt; | &lt;$&gt; · /target &lt;nama&gt; | &lt;$&gt;</i>");
  return sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML" });
}

// /stats — ringkasan cepat semua airdrop.
async function sendStats(env, chatId) {
  const items = await airdropItems(env);
  const accts = await getAccts(env);
  const by = { ongoing: 0, snapshot: 0, tge: 0, done: 0 };
  let totalCost = 0, totalTgt = 0, fullyDone = 0;
  for (const it of items) {
    const aid = aidOf(it);
    const stk = await getStatus(env, aid);
    by[stk] = (by[stk] || 0) + 1;
    totalCost += await getCost(env, aid);
    totalTgt += await getTarget(env, aid);
    if (accts.length) { const p = await getProg(env, aid); if (accts.every((a) => p[a])) fullyDone++; }
  }
  const active = items.filter((it) => !(it.type === "task" && it.t.closed));
  const lines = [
    "📊 <b>STATISTIK AIRDROP</b>", "",
    `🗂️ Total airdrop: <b>${items.length}</b> (aktif ${active.length})`,
    `👛 Akun terdaftar: <b>${accts.length}</b>`,
    accts.length ? `✅ Kelar di semua akun: <b>${fullyDone}</b>/${items.length}` : "",
    "",
    "Per status:",
    `🟢 Ongoing ${by.ongoing} · 📸 Snapshot ${by.snapshot} · 🚀 TGE ${by.tge} · 💰 Distributed ${by.done}`,
    "",
    `💸 Total modal: <b>$${totalCost.toFixed(2)}</b> · 🎯 target: <b>$${totalTgt.toFixed(2)}</b>`,
    `${totalTgt - totalCost >= 0 ? "📈" : "📉"} Perkiraan bersih: <b>$${(totalTgt - totalCost).toFixed(2)}</b>`,
    "",
    "<i>Detail: /roi · /export</i>",
  ].filter((x) => x !== "");
  return sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML" });
}

// --- Target / expected value per airdrop ---
async function getTarget(env, aid) { const v = await env.GRUPACU.get(`tgt:${aid}`); return v ? Number(v) || 0 : 0; }
async function handleTarget(env, chatId, arg) {
  const [q, amtRaw] = (arg || "").split("|").map((s) => s.trim());
  if (!q || !amtRaw) return sendMessage(env, chatId, "Cara: <code>/target &lt;nama&gt; | &lt;perkiraan $&gt;</code>\nmis: <code>/target galxe | 500</code>", { parse_mode: "HTML" });
  const it = await findAirdrop(env, q);
  if (!it) return sendMessage(env, chatId, `Airdrop "${htmlEsc(q)}" tak ketemu.`, { parse_mode: "HTML" });
  const amt = Number(String(amtRaw).replace(/[^\d.]/g, "")) || 0;
  await env.GRUPACU.put(`tgt:${aidOf(it)}`, String(amt));
  return sendMessage(env, chatId, `🎯 Target <b>${htmlEsc(aidLabel(it))}</b>: $${amt}\nRekap: /roi`, { parse_mode: "HTML" });
}

// --- Gas alert otomatis (cron) ---
async function handleGasAlert(env, chatId, arg) {
  const cfg = await getConfig(env);
  const a = (arg || "").trim().toLowerCase();
  if (a === "off" || a === "0") {
    cfg.gasAlert = null; await saveConfig(env, cfg);
    return sendMessage(env, chatId, "🔕 Gas alert dimatikan.");
  }
  const n = Number(a.replace(/[^\d.]/g, ""));
  if (!n) {
    const cur = cfg.gasAlert ? `${cfg.gasAlert} gwei` : "off";
    return sendMessage(env, chatId, `⛽ Gas alert saat ini: <b>${cur}</b>\nSet: <code>/gasalert 8</code> (colek kalau gas ≤ 8 gwei) · <code>/gasalert off</code>\n(butuh Cron Trigger aktif)`, { parse_mode: "HTML" });
  }
  cfg.gasAlert = n; cfg.gasArmed = true; await saveConfig(env, cfg);
  return sendMessage(env, chatId, `🔔 Gas alert ON: colek kalau gas Ethereum ≤ <b>${n} gwei</b>.`, { parse_mode: "HTML" });
}
async function runGasAlert(env) {
  const cfg = await getConfig(env);
  if (!cfg.gasAlert || !cfg.groupId) return;
  const gwei = await ethGasGwei();
  if (gwei == null) return;
  if (gwei <= cfg.gasAlert && cfg.gasArmed) {
    await sendMessage(env, cfg.groupId, `⛽🔔 <b>Gas murah!</b> Sekarang ~${gwei.toFixed(2)} gwei (target ≤ ${cfg.gasAlert}).\nPas buat claim/garap. /gas`, { parse_mode: "HTML" });
    cfg.gasArmed = false; await saveConfig(env, cfg);
  } else if (gwei > cfg.gasAlert && !cfg.gasArmed) {
    cfg.gasArmed = true; await saveConfig(env, cfg); // re-arm setelah naik lagi
  }
}

// --- Reminder pribadi (cron) ---
async function handleRemind(env, chatId, from, arg) {
  const m = (arg || "").trim().match(/^(\d+\s*[a-zA-Z]*)\s+(.+)$/);
  if (!m) return sendMessage(env, chatId, "Cara: <code>/remind &lt;durasi&gt; &lt;pesan&gt;</code>\nmis: <code>/remind 2d garap galxe</code> · <code>/remind 3h claim</code>", { parse_mode: "HTML" });
  const ms = parseDur(m[1]);
  if (!ms) return sendMessage(env, chatId, "Durasi tak valid. Contoh: 30m, 3h, 2d");
  const due = Date.now() + ms;
  await env.GRUPACU.put(`rem:${due}:${from.id}`, JSON.stringify({ uid: from.id, text: m[2].slice(0, 200), due }));
  return sendMessage(env, chatId, `⏰ Oke, kuingetin <b>${fmtWaktu(due)}</b>:\n"${htmlEsc(m[2].slice(0, 200))}"\nLihat: /reminders`, { parse_mode: "HTML" });
}
async function listReminders(env, chatId, from) {
  const arr = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "rem:", cursor, limit: 1000 });
    for (const k of res.keys) { const raw = await env.GRUPACU.get(k.name); if (raw) { try { const r = JSON.parse(raw); if (r.uid == from.id) arr.push({ key: k.name, ...r }); } catch { /* skip */ } } }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  arr.sort((a, b) => a.due - b.due);
  if (!arr.length) return sendMessage(env, chatId, "Belum ada reminder. Set: /remind 2d garap X");
  const lines = ["⏰ <b>REMINDER KAMU</b>", ""];
  arr.forEach((r, i) => lines.push(`${i + 1}. ${fmtWaktu(r.due)} — ${htmlEsc(r.text)}`));
  lines.push("", "Hapus: /delremind <no>");
  return sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML" });
}
async function delReminder(env, chatId, from, arg) {
  const arr = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "rem:", cursor, limit: 1000 });
    for (const k of res.keys) { const raw = await env.GRUPACU.get(k.name); if (raw) { try { const r = JSON.parse(raw); if (r.uid == from.id) arr.push({ key: k.name, ...r }); } catch { /* skip */ } } }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  arr.sort((a, b) => a.due - b.due);
  const n = parseInt(arg, 10);
  if (!n || n < 1 || n > arr.length) return sendMessage(env, chatId, "Nomor tak valid. Lihat /reminders.");
  await env.GRUPACU.delete(arr[n - 1].key);
  return sendMessage(env, chatId, "🗑️ Reminder dihapus.");
}
async function runReminders(env) {
  const now = Date.now();
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "rem:", cursor, limit: 1000 });
    for (const k of res.keys) {
      let r; try { r = JSON.parse(await env.GRUPACU.get(k.name)); } catch { continue; }
      if (!r || r.due > now) continue;
      try { await sendMessage(env, r.uid, `⏰ <b>Reminder</b>\n${htmlEsc(r.text)}`, { parse_mode: "HTML" }); } catch { /* best effort */ }
      await env.GRUPACU.delete(k.name);
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
}

// --- Export ringkas semua data airdrop ---
async function sendExport(env, chatId) {
  const items = await airdropItems(env);
  if (!items.length) return sendMessage(env, chatId, "Belum ada airdrop.");
  const accts = await getAccts(env);
  const lines = ["🗂️ <b>EXPORT AIRDROP</b>", ""];
  let n = 1;
  for (const it of items) {
    const aid = aidOf(it);
    const st = statusMeta(await getStatus(env, aid));
    const cost = await getCost(env, aid), tgt = await getTarget(env, aid);
    const note = await getNote(env, aid);
    const prog = await getProg(env, aid);
    lines.push(`${n}. ${st.emoji} <b>${htmlEsc(aidLabel(it))}</b> [${st.label}]`);
    if (cost || tgt) lines.push(`   💸 modal $${cost} · 🎯 target $${tgt}`);
    if (note) lines.push(`   📝 ${htmlEsc(note)}`);
    if (accts.length) lines.push("   " + accts.map((a) => `${prog[a] ? "✅" : "⬜"}${a}`).join(" "));
    n++;
  }
  const text = lines.join("\n");
  // Kirim per potongan kalau kepanjangan.
  for (let i = 0; i < text.length; i += 3800) {
    await sendMessage(env, chatId, text.slice(i, i + 3800), { parse_mode: "HTML" });
  }
}

// --- Lihat progres SATU akun (airdrop apa yang belum digarap akun itu) ---
async function sendAccountView(env, chatId, idx) {
  const accts = await getAccts(env);
  const label = accts[idx];
  if (!label) return sendMessage(env, chatId, "Akun tak ada. Lihat /akun.");
  const items = (await airdropItems(env)).filter((it) => !(it.type === "task" && it.t.closed));
  const belum = [], sudah = [];
  for (const it of items) {
    const st = await getStatus(env, aidOf(it));
    if (st === "done") continue;
    const prog = await getProg(env, aidOf(it));
    (prog[label] ? sudah : belum).push(aidLabel(it));
  }
  const lines = [`👤 <b>${htmlEsc(label)}</b>`, ""];
  lines.push(`⬜ Belum garap — ${belum.length}`);
  belum.forEach((x, i) => lines.push(`${i + 1}. ${htmlEsc(x)}`));
  lines.push("", `✅ Sudah — ${sudah.length}`);
  if (sudah.length) sudah.forEach((x, i) => lines.push(`${i + 1}. ${htmlEsc(x)}`));
  const rows = [[{ text: "🔙 Semua akun", callback_data: "acctlist" }]];
  return sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
}

async function getAccts(env) {
  const raw = await env.GRUPACU.get("accts");
  try { const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; } catch { return []; }
}
async function saveAccts(env, arr) { await env.GRUPACU.put("accts", JSON.stringify(arr)); }
async function getProg(env, aid) {
  const raw = await env.GRUPACU.get(`ap:${aid}`);
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
async function saveProg(env, aid, obj) { await env.GRUPACU.put(`ap:${aid}`, JSON.stringify(obj)); }
function aidOf(it) { return it.type === "task" ? "t" + it.t.id : "m" + it.a.ts; }
function aidLabel(it) { return it.type === "task" ? it.t.title : it.a.name; }

// /akun — kelola daftar akun/wallet kamu.
async function handleAccounts(env, chatId, arg) {
  const parts = (arg || "").split(/\s+/).filter(Boolean);
  const sub = (parts.shift() || "").toLowerCase();
  const accts = await getAccts(env);
  if (sub === "add" || sub === "tambah") {
    const label = parts.join(" ").trim().slice(0, 24);
    if (!label) return sendMessage(env, chatId, "Cara: /akun add <nama>  (mis. /akun add Akun2)");
    if (accts.includes(label)) return sendMessage(env, chatId, `"${label}" sudah ada.`);
    accts.push(label); await saveAccts(env, accts);
    return sendMessage(env, chatId, `✅ Akun ditambah: <b>${htmlEsc(label)}</b> (total ${accts.length})\nPantau: /board`, { parse_mode: "HTML" });
  }
  if (sub === "del" || sub === "hapus") {
    const n = parseInt(parts[0], 10);
    if (!n || n < 1 || n > accts.length) return sendMessage(env, chatId, "Nomor tak valid. Lihat /akun.");
    const removed = accts.splice(n - 1, 1)[0]; await saveAccts(env, accts);
    return sendMessage(env, chatId, `🗑️ Dihapus: ${htmlEsc(removed)}`, { parse_mode: "HTML" });
  }
  if (!accts.length) {
    return sendMessage(env, chatId, "👛 Belum ada akun.\nTambah dulu: <code>/akun add Akun1</code>\nLalu pantau progres tiap airdrop di /board.", { parse_mode: "HTML" });
  }
  const lines = ["👛 <b>AKUN / WALLET KAMU</b>", "", "Tap akun buat lihat sisa garapannya:"];
  const rows = accts.map((a, i) => [{ text: `👤 ${a}`, callback_data: `acc:${i}` }]);
  rows.push([{ text: "📊 Papan airdrop", callback_data: "board" }]);
  lines.push("", "➕ <code>/akun add &lt;nama&gt;</code> · 🗑️ <code>/akun del &lt;no&gt;</code>");
  return sendMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
}

// /board — daftar airdrop aktif + berapa akun yang sudah garap; tap buat centang.
// showAll=true ikut tampilkan yang sudah 💰 distributed.
async function sendBoard(env, chatId, showAll) {
  const accts = await getAccts(env);
  if (!accts.length) return sendMessage(env, chatId, "Tambah akunmu dulu: <code>/akun add Akun1</code>", { parse_mode: "HTML" });
  let items = (await airdropItems(env)).filter((it) => !(it.type === "task" && it.t.closed));
  const rows = [];
  let hidden = 0;
  for (const it of items) {
    const aid = aidOf(it);
    const st = statusMeta(await getStatus(env, aid));
    if (!showAll && st.key === "done") { hidden++; continue; } // sembunyikan yang distributed
    const prog = await getProg(env, aid);
    const done = accts.filter((a) => prog[a]).length;
    rows.push([{ text: `${st.emoji} ${aidLabel(it)} (${done}/${accts.length})`, callback_data: `bd:${aid}` }]);
  }
  if (!rows.length) return sendMessage(env, chatId, "Belum ada airdrop aktif. Tandai lewat /addairdrop." + (hidden ? `\n(${hidden} sudah distributed — /board all)` : ""));
  if (hidden) rows.push([{ text: `👁 Tampilkan ${hidden} selesai`, callback_data: "board:all" }]);
  else if (showAll) rows.push([{ text: "🙈 Sembunyikan selesai", callback_data: "board" }]);
  rows.push([{ text: "👛 Kelola akun", callback_data: "acctlist" }]);
  return sendMessage(env, chatId, `📊 <b>PAPAN PROGRES AIRDROP</b>\n${accts.length} akun · tap airdrop buat atur:\n🟢 ongoing · 📸 snapshot · 🚀 TGE · 💰 distributed`, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
}

// Detail 1 airdrop: tombol toggle per akun (edit di tempat kalau dari callback).
async function sendBoardAirdrop(env, chatId, aid, cq) {
  const accts = await getAccts(env);
  const items = await airdropItems(env);
  const it = items.find((x) => aidOf(x) === aid);
  const label = it ? aidLabel(it) : aid;
  const prog = await getProg(env, aid);
  const curStatus = await getStatus(env, aid);
  const rows = accts.map((a, i) => [{ text: `${prog[a] ? "✅" : "⬜"} ${a}`, callback_data: `bt:${aid}:${i}` }]);
  // Aksi cepat: centang / reset semua akun.
  rows.push([
    { text: "✅ Semua akun", callback_data: `ba:${aid}:all` },
    { text: "⬜ Reset", callback_data: `ba:${aid}:none` },
  ]);
  // Baris status lifecycle.
  rows.push(STATUSES.map((s) => ({ text: `${s.key === curStatus ? "•" : ""}${s.emoji} ${s.label}`, callback_data: `bs:${aid}:${s.key}` })));
  rows.push([{ text: "🔙 Semua airdrop", callback_data: "board" }]);
  const done = accts.filter((a) => prog[a]).length;
  const sm = statusMeta(curStatus);
  const cost = await getCost(env, aid);
  const note = await getNote(env, aid);
  const extra = [
    cost ? `💸 Modal: $${cost}` : "",
    note ? `📝 ${htmlEsc(note)}` : "",
  ].filter(Boolean).join("\n");
  const body = `📊 <b>${htmlEsc(label)}</b>  ${sm.emoji} ${sm.label}\n${done}/${accts.length} akun sudah garap.${extra ? "\n" + extra : ""}\nTap akun buat toggle · atur status di bawah:`;
  const markup = { inline_keyboard: rows };
  if (cq && cq.message) {
    return tg(env, "editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: body, parse_mode: "HTML", reply_markup: markup });
  }
  return sendMessage(env, chatId, body, { parse_mode: "HTML", reply_markup: markup });
}

// --- Alert harga ---
async function addAlert(env, chatId, from, arg) {
  const m = (arg || "").match(/^([a-zA-Z]{2,12})\s*([<>]|naik|turun|di ?atas|di ?bawah)\s*\$?([\d.,]+)$/i);
  if (!m) return sendMessage(env, chatId, "Format: /alert btc > 70000  atau  /alert eth < 3000\n(target dalam USD)");
  const sym = m[1].toLowerCase();
  const opRaw = m[2].toLowerCase();
  const op = (opRaw === ">" || opRaw === "naik" || /atas/.test(opRaw)) ? ">" : "<";
  const target = parseFloat(m[3].replace(/,/g, ""));
  if (!target) return sendMessage(env, chatId, "Target harga tak valid.");
  const id = await resolveCoinSearch(env, sym);
  if (!id) return sendMessage(env, chatId, `Coin "${sym}" tak ditemukan.`);
  const key = `alert:${from.id}:${Date.now()}`;
  await env.GRUPACU.put(key, JSON.stringify({ id, sym, op, target, chatId, uid: from.id, name: displayName(from) }));
  return sendMessage(env, chatId, `🔔 Alert dipasang: <b>${sym.toUpperCase()} ${op} $${fmtUsd(target)}</b>\nAku kabari kalau kena. Lihat: /alerts`, { parse_mode: "HTML" });
}
async function listAlerts(env, chatId, from) {
  const arr = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: `alert:${from.id}:`, cursor, limit: 1000 });
    for (const k of res.keys) { const raw = await env.GRUPACU.get(k.name); if (raw) { try { arr.push({ key: k.name, ...JSON.parse(raw) }); } catch { /* skip */ } } }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  if (!arr.length) return sendMessage(env, chatId, "Belum ada alert. Pasang: /alert btc > 70000");
  const lines = ["🔔 Alert kamu:", ""];
  arr.forEach((a, i) => lines.push(`${i + 1}. ${a.sym.toUpperCase()} ${a.op} $${fmtUsd(a.target)}`));
  lines.push("", "Hapus: /delalert <nomor> (atau /delalert all)");
  return sendMessage(env, chatId, lines.join("\n"));
}
async function delAlert(env, chatId, from, arg) {
  const keys = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: `alert:${from.id}:`, cursor, limit: 1000 });
    for (const k of res.keys) keys.push(k.name);
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  if (arg.toLowerCase() === "all") { for (const k of keys) await env.GRUPACU.delete(k); return sendMessage(env, chatId, "🗑️ Semua alert dihapus."); }
  const n = parseInt(arg, 10);
  if (!n || n < 1 || n > keys.length) return sendMessage(env, chatId, "Nomor tak valid. Lihat /alerts.");
  await env.GRUPACU.delete(keys[n - 1]);
  return sendMessage(env, chatId, `🗑️ Alert #${n} dihapus.`);
}
// Cron: cek semua alert, picu yang kena, lalu hapus (one-shot).
async function runAlerts(env) {
  const alerts = [];
  let cursor;
  do {
    const res = await env.GRUPACU.list({ prefix: "alert:", cursor, limit: 1000 });
    for (const k of res.keys) { const raw = await env.GRUPACU.get(k.name); if (raw) { try { alerts.push({ key: k.name, ...JSON.parse(raw) }); } catch { /* skip */ } } }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  if (!alerts.length) return;
  const qcache = {};
  for (const a of alerts) {
    if (qcache[a.sym] === undefined) qcache[a.sym] = await quote(env, a.sym, a.id);
    const q = qcache[a.sym];
    if (!q) continue;
    const hit = a.op === ">" ? q.usd >= a.target : q.usd <= a.target;
    if (!hit) continue;
    await sendMessage(env, a.chatId,
      `🔔 <b>ALERT</b> <a href="tg://user?id=${a.uid}">${htmlEsc(a.name)}</a>\n${a.sym.toUpperCase()} sekarang <b>$${fmtUsd(q.usd)}</b> (target ${a.op} $${fmtUsd(a.target)})`,
      { parse_mode: "HTML" });
    await env.GRUPACU.delete(a.key);
  }
}

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
    "💹 Harga & market:",
    "/p btc eth sol — harga (USD & IDR, 24 jam)",
    "ketik \"1 usdt\" / \"0.5 btc\" — langsung muncul nilainya",
    "/alert btc > 70000 — beri tahu saat harga kena · /alerts /delalert",
    "ketik \"1 btc to eth\" — konversi antar coin (/conv 1 btc eth)",
    "/gas — biaya gas Ethereum · /fgi — Fear & Greed Index",
    "/airdrops — daftar airdrop aktif (+ countdown deadline)",
    "/calendar — airdrop diurut dari deadline terdekat + progress garap",
    "/board — papan progres airdrop × akun (+ status & modal)",
    "/akun — kelola daftar akun/wallet kamu (add/del)",
    "/stats — ringkasan · /roi — modal & target · /export — dump",
    "/modal <nama> | <$> · /target <nama> | <$> · /note <nama> | <cara>",
    "/gasalert <gwei> — colek kalau gas murah",
    "/remind <durasi> <pesan> · /reminders · /delremind <no>",
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
    "5) (Opsional, buat deadline otomatis) Settings → Triggers → Cron:",
    "   '0 * * * *' (tiap jam) — bot ingatkan yang belum garap menjelang deadline.",
    "6) Daftarkan webhook dengan allowed_updates:",
    "   message, edited_message, message_reaction, chat_member, callback_query",
    "",
    "Contoh setWebhook (buka di browser, ganti <...>):",
    "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<SECRET>&allowed_updates=[\"message\",\"edited_message\",\"message_reaction\",\"chat_member\",\"callback_query\"]",
    "",
    "Catatan: 'message_reaction' & 'chat_member' TIDAK aktif kalau tak disebut eksplisit di allowed_updates.",
  ].join("\n");
}
