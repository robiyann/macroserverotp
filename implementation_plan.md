# Rencana Perubahan Bot NewGPTBot

## Latar Belakang

Berdasarkan analisis seluruh flow kode (dari signup → autopay), terdapat 2 perubahan yang diminta:

1. **Auto GoPay OTP** — [handleGoPayOtpAndPin()](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/autopay.js#1627-1743) di `autopay.js:1654` saat ini memanggil [getUserInput("Masukkan kode GoPay dari WhatsApp: ")](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/autopay.js#188-191) secara manual. Harus diubah agar polling otomatis ke OTP server (VPS `146.190.85.126:3000`).

2. **Auto Batch LuckMail** — Saat ini menu "Auto Daftar (LuckMail)" masih meminta user memilih sub-mode. Jika mode `auto_autopay` dipilih, harus meminta jumlah akun lalu membuat sejumlah itu secara otomatis tanpa interaksi manual lebih lanjut.

> [!IMPORTANT]
> **Aturan Utama**: Tidak boleh mengubah flow kode apapun dari sign up hingga autopay. Perubahan hanya pada:
> - [autopay.js](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/autopay.js): Hanya bagian [handleGoPayOtpAndPin()](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/autopay.js#1627-1743) — mengganti [getUserInput()](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/autopay.js#188-191) dengan auto-poll.
> - [telegramHandler.js](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/telegramHandler.js): Hanya bagian handler menu LuckMail dan flow batch.
> - Tambah file baru: `src/utils/gopayOtpFetcher.js`
> - [.env](file:///C:/Users/Administrator/Documents/bot/newgptbot/.env): Tambah 2 env variable baru.

---

## Analisis Flow Saat Ini

### Flow GoPay OTP (saat ini manual):
```
linkGoPay() → gopayAuthorize() → handleGoPayOtpAndPin() ← [USER INPUT MANUAL]
→ chargeGoPay() → handleChargePin() → checkTransactionStatus()
→ verifyCheckout() → checkSubscriptionStatus()
```

### Flow LuckMail saat ini:
```
User klik "🤖 Auto Daftar (LuckMail)"
→ Bot tampilkan 3 pilihan: [Auto Signup Only] [Auto Signup+Autopay] [Auto Login+Autopay]
→ User klik salah satu → enqueue task ke workerPool
```

---

## Proposed Changes

### Komponen 1: OTP Fetcher (File Baru)

#### [NEW] [gopayOtpFetcher.js](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/utils/gopayOtpFetcher.js)

File baru berisi fungsi `fetchGopayOtp(phone)` yang:
- Poll `GET /otp?server=1&phone={phone}` pada OTP server VPS
- Looping otomatis tiap 3 detik, maksimal 60 detik (20 attempt)
- Mengembalikan kode OTP (string) atau throw Error jika timeout

---

### Komponen 2: Autopay — Ganti getUserInput GoPay

#### [MODIFY] [autopay.js](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/autopay.js)

**Perubahan**:
- Baris 3: Tambah import `fetchGopayOtp` dari `./utils/gopayOtpFetcher`
- Baris 1654 ([handleGoPayOtpAndPin](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/autopay.js#1627-1743)): Ganti:
  ```js
  const b = await getUserInput("Masukkan kode GoPay dari WhatsApp: ");
  ```
  dengan:
  ```js
  // Jika ada otpFn (GoPay OTP), gunakan itu, kalau ada env var, auto-poll
  let b;
  const gopayPhone = this.gopayPhone;
  const otpServerUrl = process.env.OTP_SERVER_URL;
  if (otpServerUrl && gopayPhone) {
      logger.info(this.tag + "Auto-polling GoPay OTP dari server...");
      b = await fetchGopayOtp(gopayPhone, otpServerUrl);
  } else {
      b = await getUserInput("Masukkan kode GoPay dari WhatsApp: ");
  }
  ```

> [!NOTE]
> Jika `OTP_SERVER_URL` tidak di-set di [.env](file:///C:/Users/Administrator/Documents/bot/newgptbot/.env), akan fallback ke mode manual seperti semula — **tidak merusak pengguna yang tidak punya OTP server**.

---

### Komponen 3: .env — Tambah Env Variables

#### [MODIFY] [.env](file:///C:/Users/Administrator/Documents/bot/newgptbot/.env)

Tambah 2 baris:
```
OTP_SERVER_URL=http://146.190.85.126:3000
```

> [!NOTE]
> Phone number tidak perlu di-hardcode di env, karena phone number diambil dari `this.gopayPhone` yang sudah dipegang oleh instance Autopay (data milik user).

---

### Komponen 4: telegramHandler — Auto Batch LuckMail

#### [MODIFY] [telegramHandler.js](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/telegramHandler.js)

**Skenario perubahan**:

Saat ini (baris 235-246), ketika user klik "🤖 Auto Daftar (LuckMail)":
- Bot tampilkan 3 pilihan sub-mode
- User klik → enqueue 1 task

**Target**:
- Bot hanya tampilkan 2 pilihan:
  - **📝 Auto Signup Only** → (tetap seperti dulu, 1 task)
  - **💳 Auto Signup + Autopay** → tanya berapa akun, lalu enqueue N task secara otomatis
  - **🔑 Auto Login + Autopay** → tetap seperti dulu (perlu email lama)

**Logic baru untuk `auto_autopay`**:
Di `callback_query` handler, ketika `data === 'mode_auto_autopay'`:
1. Tanya user: `"Berapa jumlah akun yang ingin dibuat? (1-5)"`
2. Parse input, validasi (1 ≤ n ≤ MAX_THREADS)
3. Loop enqueue `n` tasks dengan mode `auto_autopay` dan email kosong (akan di-generate oleh LuckMail di index.js)

> [!IMPORTANT]
> Karena workerPool membatasi 1 slot per user (`isUserActive`), kita perlu mengubah pendekatan untuk batch: **enqueue semua task sekaligus**, dan workerPool akan memrosesnya secara berurutan. Cek apakah workerPool support multi-task dari 1 user.

**Pengecekan workerPool.js** diperlukan untuk memastikan ini bisa dilakukan:

---

### Komponen 5: Pengecekan workerPool.js

Sebelum eksekusi, perlu baca [workerPool.js](file:///C:/Users/Administrator/Documents/bot/newgptbot/src/workerPool.js) untuk memahami apakah bisa enqueue multiple task dari 1 user sekaligus.

---

## Verification Plan

### Automated Tests
Tidak ada test runner/suite di project ini.

### Manual Verification

**Test 1: Auto GoPay OTP**
1. Set `OTP_SERVER_URL=http://146.190.85.126:3000` di [.env](file:///C:/Users/Administrator/Documents/bot/newgptbot/.env)
2. Jalankan bot: `node src/index.js`
3. Di Telegram, daftar akun baru dengan mode "Auto Signup + Autopay"
4. Pantau log: bot harus menampilkan `"Auto-polling GoPay OTP dari server..."` dan mengisi OTP sendiri tanpa meminta input

**Test 2: Fallback Manual OTP**
1. Hapus `OTP_SERVER_URL` dari [.env](file:///C:/Users/Administrator/Documents/bot/newgptbot/.env)
2. Jalankan bot, lakukan autopay
3. Bot harus kembali meminta input manual OTP via Telegram (behavior lama)

**Test 3: Auto Batch LuckMail**
1. Di Telegram, klik "🤖 Auto Daftar (LuckMail)" → "💳 Auto Signup + Autopay"
2. Bot harus menampilkan: `"Berapa jumlah akun yang ingin dibuat? (1-5)"`
3. Input angka, misal `2`
4. Bot harus otomatis membuat 2 akun tanpa interaksi manual tambahan
