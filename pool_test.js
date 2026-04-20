const http = require('http');

const SERVER_ID = '1'; // Ganti jika ID Server berbeda
const POLL_INTERVAL = 2000; // Cek setiap 2 detik
const MAX_ATTEMPTS = 15; // Maksimal 30 detik (15 * 2s)

let attempts = 0;

console.log(`[Polling] Mencari OTP untuk Server: ${SERVER_ID}...`);

const poll = () => {
    attempts++;
    
    if (attempts > MAX_ATTEMPTS) {
        console.log('\n[Timeout] Tidak ada OTP masuk dalam 30 detik.');
        process.exit(1);
    }

    const url = `http://localhost:3000/otp?server=${SERVER_ID}`;

    http.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            if (res.statusCode === 200) {
                const result = JSON.parse(data);
                console.log('\n=======================================');
                console.log('✅ OTP BERHASIL DITEMUKAN!');
                console.log('---------------------------------------');
                console.log(`Server: ${result.server_number}`);
                console.log(`Phone : ${result.PhoneNumber}`);
                console.log(`OTP   : ${result.otp}`);
                console.log(`Waktu : ${new Date(result.timestamp).toLocaleString()}`);
                console.log('=======================================');
                process.exit(0);
            } else {
                // Tampilkan progress di satu baris
                process.stdout.write(`\r[Attempt ${attempts}] Masih menunggu OTP...   `);
            }
        });
    }).on('error', (err) => {
        console.error(`\n[Error] Gagal konek ke server: ${err.message}`);
        process.exit(1);
    });
};

// Mulai polling
const timer = setInterval(poll, POLL_INTERVAL);
poll(); // Jalankan pertama kali langsung
