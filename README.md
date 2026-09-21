# grupacu-bot

Bot Telegram untuk **grup airdrop kripto**: melacak siapa yang mengerjakan tugas
(menandai **"done"**), papan peringkat, kumpul wallet, dan referral. Jalan sebagai
**Cloudflare Worker** (satu file `worker.js`, tanpa dependency).

## Kenapa lewat grup diskusi (bukan channel)

Reaksi pada **post channel bersifat anonim** — bot hanya dapat *jumlah*, bukan
*siapa*. Di **grup/supergrup**, bot admin tahu siapa yang komen/react. Karena
channel yang punya grup diskusi otomatis mem-forward tiap post ke grup, member
menandai "done" di grup diskusi, dan bot mencatat per orang.

## Fitur

- 🏁 **Hitung "done"** — deteksi komen (`done`/`✅`/`👍`/…) **dan** reaksi 👍/✅ pada
  post yang ter-forward, per post, per user unik.
- 🏆 **Leaderboard** — `/leaderboard` (all-time & mingguan) + tombol.
- 📋 **/task** — daftar siapa saja yang sudah done di post terbaru/tertentu.
- 👤 **/me** — statistik pribadi (total, minggu ini, peringkat).
- ⚙️ **Penanda done bisa diatur** admin (`/markers`).
- 💼 **Kumpul wallet** — member DM `/wallet <alamat>`; admin `/wallets` export CSV.
- 🔗 **Referral** — `/ref` beri link undangan unik; join lewat link itu otomatis
  terhitung. `/refboard` (admin) papan referral.

## Setup (dashboard Cloudflare, tanpa Wrangler)

1. **Buat Worker** → **Edit code** → tempel `worker.js` → **Deploy**.
2. **Secrets** (Settings → Variables and Secrets, tipe **Secret**):
   | Name | Value |
   |------|-------|
   | `BOT_TOKEN` | token dari @BotFather (wajib) |
   | `TELEGRAM_SECRET` | string acak (disarankan) |
   | `ADMIN_IDS` | ID Telegram admin, dipisah koma |
3. **Bindings** → **KV Namespace** → variable **`GRUPACU`**.
4. **Telegram**:
   - Channel → Manage → **Discussion**: hubungkan ke sebuah grup.
   - Jadikan bot **admin** di grup diskusi.
   - @BotFather → `/setprivacy` → pilih bot → **Disable**.
   - Di grup diskusi ketik `/bind`.
5. **Daftarkan webhook** (buka di browser, ganti `<...>`):
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<SECRET>&allowed_updates=["message","edited_message","message_reaction","chat_member","callback_query"]
   ```
   > `message_reaction` & `chat_member` **wajib** disebut di `allowed_updates`,
   > kalau tidak update-nya tak dikirim Telegram.

## Perintah

**Grup:** `/leaderboard` `/task` `/me` `/ref` · **Admin:** `/bind` `/setup`
`/markers` `/wallets` `/refboard` `/reset yakin`

**DM:** `/wallet <alamat>` `/mywallet` `/me` `/leaderboard`

## Catatan privasi

- Wallet sebaiknya dikirim lewat **DM** (bukan grup) agar tidak publik.
- Data disimpan di **Cloudflare KV**. `/reset yakin` menghapus semua data done.
