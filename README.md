# Login Register OTP Telegram

Struktur utama:

- `index.html` untuk UI.
- `server.js` untuk seluruh logic backend.
- `api/index.js` untuk handler Vercel.
- `vercel.json` untuk rewrite `/api/*`.

## Lokal

```powershell
$env:TELEGRAM_BOT_TOKEN="ISI_TOKEN_BOT_KAMU"
node server.js
```

Lokal tetap memakai file `data/otp-store.json`.

## Vercel

Di Vercel project ini tidak lagi memakai file JSON lokal. Storage bisa memakai salah satu:

- `Cordex_REDIS_URL` atau `REDIS_URL`
- atau `KV_REST_API_URL` + `KV_REST_API_TOKEN`
- `KV_STORE_KEY` opsional, default `otp-store`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME` opsional tapi disarankan
- `TELEGRAM_BOT_ID` opsional

Langkah singkat:

1. Push project ke GitHub.
2. Import repo ke Vercel.
3. Tambahkan Vercel KV / Upstash Redis.
4. Pastikan env Redis/KV masuk ke project.
5. Tambahkan env Telegram bot.
6. Deploy.

## Migrasi data lokal ke KV

Kalau data lokal di `data/otp-store.json` mau dibawa ke Vercel:

```powershell
$env:Cordex_REDIS_URL="ISI_REDIS_URL"
npm run migrate:kv
```

Opsional:

```powershell
$env:KV_STORE_KEY="otp-store"
```

## Catatan

- Frontend tetap fetch ke `/api/...`, jadi lokal dan Vercel memakai path yang sama.
- Root `/` tetap untuk halaman utama/login.
- Link publik profil tetap `/?/@username`.
