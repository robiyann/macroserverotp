const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

const { extractOTP } = require('./utils/otpParser');
const gopayPool = require('./gopayPool');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'otps.json');

// Middleware
app.use(cors());

// Filter log web agar tidak nge-spam setiap kali halaman dashboard / di-reload
app.use(morgan(':method :url :status - :response-time ms', {
    skip: function (req, res) { return req.url === '/' || req.url === '/gopay/status'; }
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Helper logger function buat debugging yang lebih cantik & bersih
const logHelper = (prefix, message) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[${time}] ${prefix.padEnd(16)} | ${message}`);
};

// Load or Initialize OTP Data
let otpData = [];
if (fs.existsSync(DATA_FILE)) {
    try {
        otpData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error('Error loading data file:', e);
        otpData = [];
    }
}

function saveDate() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(otpData, null, 2));
}

// OTP Subscriptions (request queue)
let subscriptions = []; // { requestId, phone, server, otp, createdAt }
const SUB_TTL_MS = 90 * 1000; // 90 detik TTL

// Auto-Cleanup logic (Runs every 2 seconds)
setInterval(() => {
    const now = Date.now();
    const originalLength = otpData.length;
    
    // Filter out OTPs older than 30 seconds (30000 ms)
    otpData = otpData.filter(item => {
        const age = now - new Date(item.timestamp).getTime();
        return age < 30000;
    });

    if (otpData.length !== originalLength) {
        logHelper('[CLEANUP]', `Terhapus ${originalLength - otpData.length} OTP lama yg expired (30d)`);
        saveDate();
    }

    // Cleanup subscriptions expired
    const beforeSub = subscriptions.length;
    subscriptions = subscriptions.filter(s => now - s.createdAt < SUB_TTL_MS);
    if (subscriptions.length !== beforeSub) {
        logHelper('[SUBSCRIPTION]', `Timeout: ${beforeSub - subscriptions.length} antrean subsription OTP bot dibuang`);
    }
}, 2000);

// Routes

/**
 * Endpoint for MacroDroid to POST notifications.
 * Body: { sender, text, server_number, PhoneNumber }
 */
app.post('/receive', (req, res) => {
    const { sender, text, server_number, PhoneNumber } = req.body;
    
    logHelper('[MACRODROID]', `Notif masuk | Srv: ${server_number || '?'} | No: ${PhoneNumber || '?'}`);

    if (!sender || !text) {
        logHelper('[MACRODROID]', `Error: Payload tidak lengkap! sender/text kosong`);
        return res.status(400).json({ error: 'Missing sender or text' });
    }

    // Still try to extract OTP if available
    const otp = extractOTP(text);
    const timestamp = new Date().toISOString();

    const entry = {
        server_number: server_number || 'Unknown',
        PhoneNumber: PhoneNumber || 'Unknown',
        sender,
        text,
        otp: otp || null, // null if it's just a status message
        timestamp
    };

    otpData.unshift(entry);
    saveDate();

    if (otp) {
        logHelper('[OTP_SAVED]', `Berhasil tangkap OTP: ${otp} (Untuk no: ${PhoneNumber})`);
        
        // [NEW] Auto-assign OTP ke subscriber yang cocok
        const matchingSub = subscriptions.find(s =>
            s.otp === null &&
            String(server_number) === s.server &&
            (PhoneNumber === s.phone || PhoneNumber.includes(s.phone) || s.phone.includes(PhoneNumber))
        );
        if (matchingSub) {
            matchingSub.otp = otp;
            logHelper('[OTP_MATCH!]', `>> OTP ${otp} langsung didistribusikan ke antrean request bot!`);
        }
    } else {
        logHelper('[MACRODROID]', `Teks Normal Disimpan: "${text.substring(0, 30).replace(/\n/g, ' ')}..."`);
    }
    
    res.json({ success: true, otp });
});

/**
 * Endpoint for GoPay Status updates (e.g. Unlink Success).
 * Body: { text, server_number, PhoneNumber }
 */
app.post('/statusgpay', (req, res) => {
    const { text, server_number, PhoneNumber, status } = req.body;
    
    logHelper('[WEBHOOK_HP]', `Laporan Link Reset (${status || 'INFO'}): ${text}`);

    const entry = {
        server_number: server_number || 'Unknown',
        PhoneNumber: PhoneNumber || 'Unknown',
        sender: 'GoPay System',
        text: text || 'No status text provided',
        status: status || null,
        otp: null,
        timestamp: new Date().toISOString()
    };

    otpData.unshift(entry);
    saveDate();

    // Integrasi Pool: Jika status "reset done", tandai slot sebagai available
    if (status === 'reset done' && server_number) {
        gopayPool.markResetDone(server_number);
    }
    
    res.json({ success: true, message: 'GoPay status saved' });
});

/**
 * [NEW] GoPay Pool Endpoints
 */

// Claim slot yang tersedia
app.get('/gopay/claim', (req, res) => {
    const slot = gopayPool.claim();
    if (slot) {
        res.json(slot);
    } else {
        res.status(503).json({ error: 'All GoPay slots are currently busy or resetting' });
    }
});

// Release slot (kemudian otomatis reset-link ke HP agar slot dijamin bersih)
app.get('/gopay/release', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing slot id' });
    
    const slots = gopayPool._loadState();
    const slot = slots.find(s => s.id == id || s.server_number == id);
    
    if (slot && slot.webhook_action && slot.device_id) {
        gopayPool.markResetting(slot.id);
        triggerAction(slot.device_id, slot.webhook_action).catch(err => {
            console.error(`[Pool] Gagal auto-reset slot ${id} saat release: ${err.message}`);
        });
        res.json({ success: true, message: "Slot returned and is now resetting" });
    } else {
        // Fallback or missing data
        const success = gopayPool.release(id);
        res.json({ success, message: "Slot forcefully released (no webhook info)" });
    }
});

// Cek status semua slot untuk monitoring
app.get('/gopay/status', (req, res) => {
    res.json(gopayPool.getStatus());
});

// Reload config GoPay Pool tanpa restart
app.get('/gopay/reload', (req, res) => {
    const result = gopayPool.reload();
    if (result.success) {
        logHelper('[POOL_ADMIN]', `Command Reload dieksekusi. Total slot aktif: ${result.count}`);
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// Reset SEMUA slot ke available (admin/recovery endpoint)
app.get('/gopay/reset-all', (req, res) => {
    const before = gopayPool.getStatus();
    
    // Internal reset method handles the file lock + array saving
    const changedSlots = gopayPool.resetAll() || [];
    
    // AUTO TRIGGER RESET-LINK on all slots
    changedSlots.forEach(slot => {
        if (slot.device_id && slot.webhook_action) {
            triggerAction(slot.device_id, slot.webhook_action).catch(() => {});
        }
    });

    const after = gopayPool.getStatus();
    logHelper('[POOL_ADMIN]', `Command Reset-All dieksekusi. Menyegarkan ${changedSlots.length} HP & Menembak ulang webhooks.`);
    res.json({ success: true, resetCount: changedSlots.length, before, after });
});

// [NEW] Tambah slot GoPay baru ke pool (live, tanpa restart)
app.post('/gopay/add', (req, res) => {
    const { phone, pin, device_id, webhook_action } = req.body;
    if (!phone || !pin || !device_id || !webhook_action) {
        return res.status(400).json({ error: 'Missing required fields: phone, pin, device_id, webhook_action' });
    }

    try {
        // Baca config yang ada
        const CONFIG_FILE = path.join(__dirname, 'gopay_pool.json');
        let configData = [];
        if (fs.existsSync(CONFIG_FILE)) {
            configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }

        // Generate ID baru (max existing id + 1)
        const newId = configData.length > 0 ? Math.max(...configData.map(s => s.id || 0)) + 1 : 1;

        // Cek duplikat phone
        if (configData.some(s => String(s.phone) === String(phone))) {
            return res.status(409).json({ error: `Nomor ${phone} sudah ada di pool!` });
        }

        const newSlot = { id: newId, phone: String(phone), pin: String(pin), device_id, webhook_action };
        configData.push(newSlot);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));

        // Reload pool langsung tanpa restart
        const reloadResult = gopayPool.reload();
        logHelper('[POOL_ADMIN]', `Slot baru ditambah: HP ${phone} (ID: ${newId}). Total: ${reloadResult?.count || '?'} slot.`);
        res.json({ success: true, id: newId, slot: newSlot, pool: reloadResult });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// [NEW] Hapus slot GoPay dari pool (live, tanpa restart)
app.delete('/gopay/remove', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing slot id' });

    try {
        const CONFIG_FILE = path.join(__dirname, 'gopay_pool.json');
        let configData = [];
        if (fs.existsSync(CONFIG_FILE)) {
            configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }

        const before = configData.length;
        configData = configData.filter(s => s.id != id);

        if (configData.length === before) {
            return res.status(404).json({ error: `Slot ID ${id} tidak ditemukan` });
        }

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
        const reloadResult = gopayPool.reload();
        logHelper('[POOL_ADMIN]', `Slot ID ${id} dihapus dari pool. Total: ${reloadResult?.count || '?'} slot.`);
        res.json({ success: true, removed: id, pool: reloadResult });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Helper to trigger MacroDroid
 */
function triggerAction(deviceId, action) {
    return new Promise((resolve, reject) => {
        const webhookUrl = `https://trigger.macrodroid.com/${deviceId}/${action}`;
        logHelper('[TRIGGER_HP]', `Menembak webhook command "${action}" ke Device HP...`);
        
        https.get(webhookUrl, (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => {
                logHelper('[TRIGGER_HP]', `Respon HP: ${data}`);
                resolve(data);
            });
        }).on('error', (err) => {
            console.error(`[Trigger] Error: ${err.message}`);
            reject(err);
        });
    });
}

/**
 * Endpoint to trigger MacroDroid on the phone.
 * Query: ?action=your_identifier
 */
app.get('/trigger-hp', (req, res) => {
    const { action } = req.query;
    let DEVICE_ID = '75a484c3-631d-4ab6-a5e1-77daae598087'; // Default HP-1

    if (!action) {
        return res.status(400).json({ error: 'Missing action identifier' });
    }

    // Integrasi Pool: Cari Device ID berdasarkan webhook action
    if (gopayPool.initialized) {
        const slots = gopayPool._loadState();
        const slot = slots.find(s => s.webhook_action === action);
        if (slot && slot.device_id) {
            DEVICE_ID = slot.device_id;
            // Tandai sedang resetting
            gopayPool.markResetting(slot.id);
        }
    }

    triggerAction(DEVICE_ID, action)
        .then(data => res.json({ success: true, message: `Command "${action}" sent to HP`, response: data }))
        .catch(err => res.status(500).json({ success: false, error: err.message }));
});

/**
 * [NEW] Bot mendaftar sebagai subscriber OTP untuk phone/server tertentu.
 * Returns requestId unik yang dipakai untuk poll /otp/claim/:requestId
 */
app.post('/otp/subscribe', (req, res) => {
    const { phone, server } = req.body;
    if (!phone || !server) {
        return res.status(400).json({ error: 'Missing phone or server' });
    }
    const requestId = require('crypto').randomUUID();
    const sub = { requestId, phone: String(phone), server: String(server), otp: null, createdAt: Date.now() };
    subscriptions.push(sub);
    logHelper('[BOT_SUBSCRIBE]', `Bot (Srv #${server}) standby bersiap menangkap SMS dari HP: ${phone}`);
    res.json({ requestId, ttl: SUB_TTL_MS / 1000 });
});

/**
 * [NEW] Bot poll untuk mendapatkan OTP yang sudah di-assign ke requestId-nya.
 * Jika sudah ada OTP, langsung consume (hapus subscription).
 */
app.get('/otp/claim/:requestId', (req, res) => {
    const { requestId } = req.params;
    const now = Date.now();

    const idx = subscriptions.findIndex(s => s.requestId === requestId);
    if (idx === -1) {
        return res.status(404).json({ error: 'Subscription not found or expired' });
    }
    
    const sub = subscriptions[idx];
    
    // Cek TTL
    if (now - sub.createdAt > SUB_TTL_MS) {
        subscriptions.splice(idx, 1);
        return res.status(404).json({ error: 'Subscription expired' });
    }
    
    if (sub.otp) {
        // Consume: hapus subscription setelah diklaim
        subscriptions.splice(idx, 1);
        logHelper('[BOT_CLAIM!]', `Bot sukses mengambil OTP [ ${sub.otp} ]. Proses selesai.`);
        res.json({ otp: sub.otp, phone: sub.phone, server: sub.server });
    } else {
        res.status(404).json({ error: 'OTP not yet received' });
    }
});

/**
 * Endpoint to get the latest OTP.
 * Returns only if it's NOT expired (max 30 seconds old).
 */
app.get('/otp', (req, res) => {
    const { phone, server } = req.query;
    const now = Date.now();
    
    // Safety filter to ensure we only return fresh OTPs
    const freshOtps = otpData.filter(item => {
        const age = now - new Date(item.timestamp).getTime();
        return age < 30000;
    });

    let result = freshOtps;
    
    if (phone) {
        // Match specific phone number
        result = result.filter(item => item.PhoneNumber === phone || item.PhoneNumber.includes(phone));
    }
    
    if (server) {
        // Match specific server number
        result = result.filter(item => item.server_number === server || item.server_number.toString() === server);
    }
    
    if (result.length > 0) {
        res.json(result[0]); // Return the latest one
    } else {
        res.status(404).json({ error: 'No fresh OTP found (Expired or not received)' });
    }
});

/**
 * Root Dashboard
 */
app.get('/', (req, res) => {
    const rows = otpData.map(item => `
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #444;">${new Date(item.timestamp).toLocaleString()}</td>
            <td style="padding: 10px; border-bottom: 1px solid #444; color: #ffa500;">${item.server_number || '-'}</td>
            <td style="padding: 10px; border-bottom: 1px solid #444; color: #00d4ff;">${item.PhoneNumber || '-'}</td>
            <td style="padding: 10px; border-bottom: 1px solid #444;">${item.sender || '-'}</td>
            <td style="padding: 10px; border-bottom: 1px solid #444;">${item.text || '-'}</td>
            <td style="padding: 10px; border-bottom: 1px solid #444; font-weight: bold; color: #00ff00;">${item.otp || '-'}</td>
        </tr>
    `).join('');

    const gopayStatus = gopayPool.getStatus(); // Need to fetch analytics status

    // Load data pool secara live dari file (jangan pakai require karena di-cache nodejs)
    const poolState = gopayPool._loadState();

    const html = `
    <html>
    <head>
        <title>OTP Server Dashboard</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1a1a1a; color: #e0e0e0; margin: 0; padding: 20px; }
            .container { max-width: 1200px; margin: auto; background: #2d2d2d; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); margin-bottom: 20px; }
            h1 { color: #fff; border-bottom: 2px solid #555; padding-bottom: 10px; }
            h2 { color: #00d4ff; font-weight: normal; margin-top: 5px; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th { text-align: left; background: #3d3d3d; padding: 10px; }
            td { padding: 8px; border-bottom: 1px solid #444; }
            .refresh { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; float: right; margin-left: 10px; }
            .refresh:hover { background: #0056b3; }
            .history-pill { background: #444; padding: 2px 6px; border-radius: 4px; font-size: 0.75em; margin: 2px 0; display: inline-block; border-left: 3px solid #666; }
            .status-badge { padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 0.85em; text-transform: uppercase; }
            .badge-available { background: #1e7e34; color: white; }
            .badge-in_use { background: #d39e00; color: #1a1a1a; }
            .badge-resetting { background: #117a8b; color: white; }
            .btn-del { background: #c0392b; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8em; }
            .btn-del:hover { background: #922b21; }
            .add-form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; align-items: flex-end; }
            .add-form input { background: #3d3d3d; border: 1px solid #555; color: #e0e0e0; padding: 8px 10px; border-radius: 4px; font-size: 0.9em; flex: 1; min-width: 130px; }
            .add-form input::placeholder { color: #888; }
            .add-form input:focus { outline: none; border-color: #28a745; }
            .btn-add { background: #28a745; color: white; border: none; padding: 9px 20px; border-radius: 4px; cursor: pointer; font-size: 0.9em; white-space: nowrap; }
            .btn-add:hover { background: #1e7e34; }
            .msg-box { margin-top: 10px; padding: 8px 14px; border-radius: 4px; font-size: 0.9em; display: none; }
        </style>
        <script>
            setTimeout(() => location.reload(), 5000);
        </script>
    </head>
    <body>
        <div class="container">
            <button class="refresh" onclick="location.reload()">Refresh Now</button>
            <button class="refresh" style="background:#28a745;" onclick="fetch('/gopay/reload').then(r=>r.json()).then(d=>alert('Reload: '+d.count+' slots')).then(()=>location.reload())">Reload Pool</button>
            <h1>GoPay Device Stats</h1>
            <p>Pool Usage and Analytics</p>
            <table>
                <thead>
                    <tr>
                        <th>ID (Srv)</th>
                        <th>Phone</th>
                        <th>PIN</th>
                        <th>Webhook Action</th>
                        <th>Status</th>
                        <th>Used</th>
                        <th>Reset</th>
                        <th>History</th>
                        <th>Aksi</th>
                    </tr>
                </thead>
                <tbody>
                    ${poolState.map(s => {
                        let statusClass = 'badge-available';
                        if(s.status==='in_use') statusClass = 'badge-in_use';
                        if(s.status==='resetting') statusClass = 'badge-resetting';
                        
                        const historyHtml = (s.usageHistory || []).map(h => 
                            '<div class="history-pill">' + h.event + ' <span style="color:#aaa;font-size:0.9em">(' + new Date(h.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}) + ')</span></div>'
                        ).join('');

                        return `
                        <tr id="row-slot-${s.id}">
                            <td style="color: #ffa500; font-weight:bold;">${s.id}</td>
                            <td style="color: #00d4ff;">${s.phone}</td>
                            <td style="color: #bbb; font-size:0.85em;">${s.pin || '-'}</td>
                            <td style="color: #bbb; font-size:0.85em;">${s.webhook_action || '-'}</td>
                            <td><span class="status-badge ${statusClass}">${s.status}</span></td>
                            <td style="font-weight:bold; color: #fff;">${s.usageCount || 0}x</td>
                            <td style="color: #bbb;">${s.resetCount || 0}x</td>
                            <td style="max-width: 220px; font-size: 0.9em; line-height:1.2;">${historyHtml || '<i style="color:#666">No Activity</i>'}</td>
                            <td><button class="btn-del" onclick="removeSlot(${s.id})">Hapus</button></td>
                        </tr>
                        `;
                    }).join('') || '<tr><td colspan="9" style="text-align:center;">No pool data</td></tr>'}
                </tbody>
            </table>

            <h2 style="margin-top:24px;">➕ Tambah Slot GoPay Baru</h2>
            <div class="add-form">
                <input id="inp-phone" type="text" placeholder="No HP (tanpa 0/+62, mis: 85848101010)">
                <input id="inp-pin" type="text" placeholder="PIN GoPay (mis: 120402)" style="max-width:160px;">
                <input id="inp-device" type="text" placeholder="MacroDroid Device ID (UUID)">
                <input id="inp-webhook" type="text" placeholder="Webhook Action (mis: reset-link-13)" style="max-width:220px;">
                <button class="btn-add" onclick="addSlot()">+ Tambah Slot</button>
            </div>
            <div id="add-msg" class="msg-box"></div>
        </div>
        <script>
            async function addSlot() {
                const phone = document.getElementById('inp-phone').value.trim();
                const pin = document.getElementById('inp-pin').value.trim();
                const device_id = document.getElementById('inp-device').value.trim();
                const webhook_action = document.getElementById('inp-webhook').value.trim();
                const msgBox = document.getElementById('add-msg');
                if (!phone || !pin || !device_id || !webhook_action) {
                    msgBox.style.display = 'block'; msgBox.style.background = '#7b241c';
                    msgBox.textContent = '⚠️ Semua field harus diisi!'; return;
                }
                try {
                    const res = await fetch('/gopay/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone, pin, device_id, webhook_action })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        msgBox.style.display = 'block'; msgBox.style.background = '#1e7e34';
                        msgBox.textContent = '✅ Slot HP ' + phone + ' berhasil ditambahkan (ID: ' + data.id + '). Halaman akan refresh...';
                        setTimeout(() => location.reload(), 1500);
                    } else {
                        msgBox.style.display = 'block'; msgBox.style.background = '#7b241c';
                        msgBox.textContent = '❌ Gagal: ' + data.error;
                    }
                } catch(e) {
                    msgBox.style.display = 'block'; msgBox.style.background = '#7b241c';
                    msgBox.textContent = '❌ Error: ' + e.message;
                }
            }
            async function removeSlot(id) {
                if (!confirm('Hapus slot ID ' + id + ' dari pool? Aksi ini tidak bisa dibatalkan.')) return;
                try {
                    const res = await fetch('/gopay/remove?id=' + id, { method: 'DELETE' });
                    const data = await res.json();
                    if (res.ok) {
                        const row = document.getElementById('row-slot-' + id);
                        if (row) row.style.opacity = '0.3';
                        setTimeout(() => location.reload(), 800);
                    } else {
                        alert('Gagal hapus: ' + data.error);
                    }
                } catch(e) { alert('Error: ' + e.message); }
            }
        </script>

        <div class="container">
            <h2>Live OTP Logs</h2>
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Srv #</th>
                        <th>Phone Number</th>
                        <th>Status</th>
                        <th>Sender</th>
                        <th>Content</th>
                        <th>OTP</th>
                    </tr>
                </thead>
                <tbody>
                    ${otpData.slice(0, 50).map(item => `
                        <tr>
                            <td>${new Date(item.timestamp).toLocaleString()}</td>
                            <td style="color: #ffa500;">${item.server_number || '-'}</td>
                            <td style="color: #00d4ff;">${item.PhoneNumber || '-'}</td>
                            <td><span style="background: #555; padding: 2px 6px; border-radius: 4px; font-size: 0.8em;">${item.status || '-'}</span></td>
                            <td>${item.sender || '-'}</td>
                            <td style="max-width: 400px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${item.text}">${item.text || '-'}</td>
                            <td style="font-weight: bold; color: #00ff00;">${item.otp || '-'}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="7" style="text-align:center; padding: 20px;">Waiting for notifications...</td></tr>'}
                </tbody>
            </table>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`OTP Server is running on http://localhost:${PORT}`);
    console.log(`Accepting connections from all interfaces (0.0.0.0)`);
});
