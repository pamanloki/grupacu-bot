# CLAUDE.md

Panduan singkat untuk mengembangkan repo ini.

## Apa ini

Bot Telegram grup **airdrop** (pelacak "done", leaderboard, wallet, referral),
berjalan sebagai **Cloudflare Worker**. Seluruh logika di satu file `worker.js`
(tanpa framework/dependency).

## Deploy

Lewat **dashboard Cloudflare** (bukan Wrangler): Worker → Edit code → tempel
`worker.js` → Deploy. Validasi cepat sebelum commit:

```bash
node --check worker.js
```

## Konfigurasi runtime

- Secrets: `BOT_TOKEN` (wajib), `TELEGRAM_SECRET`, `ADMIN_IDS`.
- Binding: KV Namespace → variable **`GRUPACU`**.
- Webhook `allowed_updates` HARUS memuat: `message`, `edited_message`,
  `message_reaction`, `chat_member`, `callback_query`.

## Kunci penting

Reaksi pada **post channel = anonim** (bot cuma dapat jumlah). Data "siapa"
hanya ada di **grup/supergrup**. Karena itu bot memantau **grup diskusi**:
tiap post channel ter-forward otomatis ke grup (`is_automatic_forward`), dan
komentar member punya `message_thread_id` = id pesan forward = **anchor task**.

## Model data (KV, binding `GRUPACU`)

- `task:<taskId>` → `{ id, postId, title, ts, chatId }` (taskId = id pesan forward di grup)
- `lasttask` → taskId terakhir
- `d:<taskId>:<uid>` → `{ name, ts, via }` — done unik per (task,user); idempoten
- `w:<YYYYWW>:<uid>:<taskId>` → "1" — indeks mingguan (leaderboard minggu ini)
- `name:<uid>` → nama tampilan terbaru
- `wallet:<uid>` → `{ addr, chain, name, username, ts }`
- `ref:<uid>` → `{ by, ts, via }` ; `rb:<inviterUid>:<newUid>` → "1"
- `cfg` → `{ markers[], reactEmoji[], countReactions, groupId }`

Leaderboard dihitung dengan `tally(prefix, uidPos)` — **melist nama key** dan
menghitung uid dari segmen key (tanpa baca value), jadi tahan terhadap race
antar banyak member (tiap event = key sendiri, idempoten).

## Konvensi

- Update di-route di `routeUpdate`: message / message_reaction / chat_member / callback_query.
- Deteksi "done": `isDoneText` (komen) & `hasDoneEmoji` (reaksi); penanda dari `cfg.markers`.
- Reaksi hanya dihitung untuk `taskId` yang **terdaftar** (`task:*`) biar count tak nggelembung.
- Perintah admin dijaga `isAdmin(env, uid)` (dari `ADMIN_IDS`).
- Komentar & teks bot dalam Bahasa Indonesia. Zona waktu WIB untuk `weekKey`.
