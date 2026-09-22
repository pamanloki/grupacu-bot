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

**Grup:** `/daftar` `/leaderboard` `/task` `/tasks` `/me` `/ref` `/airdrops`
`/calendar` `/board` `/akun` ·

**Papan progres multi-akun** (buat farming pribadi): `/akun add <nama>` daftarkan
akun/wallet-mu, lalu `/board` — tiap airdrop bisa dicentang **per akun** (mis.
*Airdrop X → Akun A ✅, Akun B ⬜*), diberi **status** (🟢 ongoing → 📸 snapshot →
🚀 TGE → 💰 distributed), **modal**, dan **catatan cara garap**. Yang sudah
distributed otomatis disembunyikan (`/board all` untuk tampilkan).

- `/stats` — ringkasan (jumlah per status, akun, total modal).
- `/roi` — rekap modal semua airdrop.
- `/modal <nama> | <$>` — catat modal gas · `/note <nama> | <cara>` — simpan cara garap.

Data di KV: `accts`, `ap:<aid>`, `stt:<aid>` (status), `cost:<aid>`, `nx:<aid>`.

**Admin:** `/bind` `/setup` `/markers` `/announce on|off` `/digest on|off`
`/addairdrop` `/deadline 12h` `/nudge` `/members` `/wallets` `/refboard`
`/reset yakin`

`/calendar` — airdrop diurut dari **deadline terdekat** + countdown + progress
garap. `/deadline` & `/nudge` dipakai dengan **reply ke post**-nya.

Pasang **Cron Trigger** `0 * * * *` (Settings → Triggers) untuk:
reminder **H-1 & menjelang/saat deadline** (colek yang belum garap) dan
**digest airdrop harian** (auto-post ke grup ~08:00 WIB; matikan dgn `/digest off`).

**DM:** `/wallet <alamat>` `/mywallet` `/me` `/leaderboard`

## Catatan privasi

- Wallet sebaiknya dikirim lewat **DM** (bukan grup) agar tidak publik.
- Data disimpan di **Cloudflare KV**. `/reset yakin` menghapus semua data done.
