const axios = require('axios');

// KONFIGURASI
const SERVER_URL = 'http://146.190.85.126:3000'; // IP VPS Anda
const SERVER_ID = '1';                       // ID Server yang dipantau
const PHONE_NUMBER = '83193303273';          // Nomor HP yang dipantau
const TARGET_STATUS = 'reset done';          // Status yang dicari
const POLLING_INTERVAL = 3000;               // Cek setiap 3 detik
const MAX_ATTEMPTS = 20;                     // Maksimal 20 kali percobaan (60 detik)

async function pollStatus() {
    console.log(`[Polling] Menunggu Status: "${TARGET_STATUS}" untuk Phone: ${PHONE_NUMBER}...`);
    
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await axios.get(`${SERVER_URL}/otp`, {
                params: {
                    server: SERVER_ID,
                    phone: PHONE_NUMBER
                }
            });

            const data = response.data;

            if (data.status === TARGET_STATUS) {
                console.log("\n=======================================");
                console.log("✅ STATUS BERHASIL DIDETEKSI!");
                console.log("---------------------------------------");
                console.log(`Status : ${data.status}`);
                console.log(`Pesan  : ${data.text}`);
                console.log(`Waktu  : ${new Date(data.timestamp).toLocaleString('id-ID')}`);
                console.log("=======================================\n");
                return;
            }

            process.stdout.write(`[Attempt ${attempt}] Masih menunggu "${TARGET_STATUS}"...\r`);
            
        } catch (error) {
            if (error.response && error.response.status === 404) {
                process.stdout.write(`[Attempt ${attempt}] Belum ada data status terbaru...\r`);
            } else {
                console.error(`\n[Error] Terjadi kesalahan: ${error.message}`);
            }
        }

        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
    }

    console.log(`\n[Timeout] Status "${TARGET_STATUS}" tidak ditemukan dalam ${MAX_ATTEMPTS * POLLING_INTERVAL / 1000} detik.`);
}

pollStatus();
