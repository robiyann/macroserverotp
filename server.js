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

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(otpData, null, 2));
}

// OTP Subscriptions (request queue)
let subscriptions = []; // { requestId, phone, server, otp, createdAt }
const SUB_TTL_MS = 90 * 1000; // 90 detik TTL

// Auto-Cleanup logic (Runs every 10 seconds for performance)
setInterval(() => {
    const now = Date.now();
    const originalLength = otpData.length;
    
    // Filter out OTPs older than 24 hours (86,400,000 ms)
    const OTP_TTL_MS = 24 * 60 * 60 * 1000;
    otpData = otpData.filter(item => {
        const age = now - new Date(item.timestamp).getTime();
        return age < OTP_TTL_MS;
    });

    if (otpData.length !== originalLength) {
        logHelper('[CLEANUP]', `Terhapus ${originalLength - otpData.length} OTP lama yg expired (>24h)`);
        saveData();
    }

    // Cleanup subscriptions expired
    const beforeSub = subscriptions.length;
    subscriptions = subscriptions.filter(s => now - s.createdAt < SUB_TTL_MS);
    if (subscriptions.length !== beforeSub) {
        logHelper('[SUBSCRIPTION]', `Timeout: ${beforeSub - subscriptions.length} antrean subsription OTP bot dibuang`);
    }
}, 10000);

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
    saveData();

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
    saveData();

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
    
    // Atomic: baca state + cek status + set resetting dalam satu lock
    const result = gopayPool.releaseWithReset(parseInt(id) || id);
    
    if (result.action === 'not_found') {
        return res.status(404).json({ error: `Slot ${id} not found` });
    }
    
    if (result.action === 'skip') {
        // Slot bukan in_use (mungkin sudah available/resetting) — jangan trigger reset ulang
        return res.json({ success: true, message: `Slot ${id} is ${result.slot.status}, no reset needed` });
    }
    
    // action === 'reset' — slot sudah di-set ke 'resetting', trigger webhook
    if (result.slot.device_id && result.slot.webhook_action) {
        triggerAction(result.slot.device_id, result.slot.webhook_action).catch(err => {
            console.error(`[Pool] Gagal auto-reset slot ${id} saat release: ${err.message}`);
        });
    }
    
    res.json({ success: true, message: "Slot returned and is now resetting" });
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
        const CONFIG_FILE = path.join(__dirname, 'gopay_pool.json');
        let configData = [];
        if (fs.existsSync(CONFIG_FILE)) {
            configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }

        const newId = configData.length > 0 ? Math.max(...configData.map(s => s.id || 0)) + 1 : 1;

        if (configData.some(s => String(s.phone) === String(phone))) {
            return res.status(409).json({ error: `Nomor ${phone} sudah ada di pool!` });
        }

        const newSlot = { id: newId, phone: String(phone), pin: String(pin), device_id, webhook_action };
        configData.push(newSlot);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));

        const reloadResult = gopayPool.reload();
        logHelper('[POOL_ADMIN]', `Slot baru ditambah: HP ${phone} (ID: ${newId}). Total: ${reloadResult?.count || '?'} slot.`);
        res.json({ success: true, id: newId, slot: newSlot, pool: reloadResult });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// [NEW] Edit slot GoPay yang ada (live, tanpa restart)
app.post('/gopay/edit', (req, res) => {
    const { id, phone, pin, device_id, webhook_action } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing slot id' });

    try {
        const CONFIG_FILE = path.join(__dirname, 'gopay_pool.json');
        let configData = [];
        if (fs.existsSync(CONFIG_FILE)) {
            configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }

        const slotIndex = configData.findIndex(s => s.id == id);
        if (slotIndex === -1) {
            return res.status(404).json({ error: `Slot ID ${id} tidak ditemukan` });
        }

        // Update fields if provided
        if (phone) configData[slotIndex].phone = String(phone);
        if (pin) configData[slotIndex].pin = String(pin);
        if (device_id) configData[slotIndex].device_id = device_id;
        if (webhook_action) configData[slotIndex].webhook_action = webhook_action;

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));

        // Reload pool langsung tanpa restart
        const reloadResult = gopayPool.reload();
        logHelper('[POOL_ADMIN]', `Slot ID ${id} berhasil diupdate. Total: ${reloadResult?.count || '?'} slot.`);
        res.json({ success: true, id, slot: configData[slotIndex], pool: reloadResult });
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
    
    // Safety filter to ensure we only return fresh OTPs (24 hours)
    const OTP_TTL_MS = 24 * 60 * 60 * 1000;
    const freshOtps = otpData.filter(item => {
        const age = now - new Date(item.timestamp).getTime();
        return age < OTP_TTL_MS;
    });

    let result = freshOtps;
    
    // If no filters, return all fresh OTPs for the dashboard
    if (!phone && !server) {
        return res.json(result);
    }
    
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
 * Root Dashboard - Modern Premium UI
 */
app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>OTP Server | Advanced Device Management</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
        <style>
            :root {
                --primary: #00d4ff;
                --secondary: #007bff;
                --success: #00ff88;
                --warning: #ffaa00;
                --danger: #ff4444;
                --bg: #0a0c10;
                --card-bg: rgba(30, 35, 45, 0.7);
                --border: rgba(255, 255, 255, 0.1);
                --text: #e0e6ed;
                --text-muted: #94a3b8;
            }

            * { box-sizing: border-box; }
            body { 
                font-family: 'Inter', sans-serif; 
                background: var(--bg); 
                background-image: radial-gradient(circle at 50% 0%, #1e293b 0%, #0a0c10 100%);
                color: var(--text); 
                margin: 0; 
                padding: 20px; 
                min-height: 100vh;
            }

            .container { max-width: 1300px; margin: auto; }
            
            header { 
                display: flex; 
                justify-content: space-between; 
                align-items: center; 
                margin-bottom: 30px;
                padding: 20px;
                background: var(--card-bg);
                backdrop-filter: blur(12px);
                border-radius: 16px;
                border: 1px solid var(--border);
            }

            h1 { margin: 0; font-size: 1.5rem; font-weight: 700; color: #fff; letter-spacing: -0.5px; }
            h1 span { color: var(--primary); }

            .btn {
                padding: 10px 20px;
                border-radius: 8px;
                border: none;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                font-size: 0.9rem;
                display: inline-flex;
                align-items: center;
                gap: 8px;
            }
            .btn-primary { background: var(--secondary); color: white; box-shadow: 0 4px 12px rgba(0, 123, 255, 0.3); }
            .btn-primary:hover { background: #0056b3; transform: translateY(-1px); }
            .btn-success { background: #1e7e34; color: white; }
            .btn-danger { background: rgba(255, 68, 68, 0.15); color: var(--danger); border: 1px solid rgba(255, 68, 68, 0.3); }
            .btn-danger:hover { background: var(--danger); color: white; }
            .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
            .btn-outline:hover { background: var(--border); }

            .grid { display: grid; grid-template-columns: 1fr; gap: 24px; }
            @media (min-width: 1100px) { .grid { grid-template-columns: 2fr 1fr; } }

            .card {
                background: var(--card-bg);
                backdrop-filter: blur(12px);
                border-radius: 20px;
                border: 1px solid var(--border);
                padding: 24px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            }

            .card h2 { margin-top: 0; font-size: 1.2rem; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
            
            table { width: 100%; border-collapse: collapse; }
            th { text-align: left; font-size: 0.8rem; text-transform: uppercase; color: var(--text-muted); padding: 12px 16px; border-bottom: 1px solid var(--border); }
            td { padding: 16px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }

            .status-badge {
                padding: 4px 10px;
                border-radius: 6px;
                font-size: 0.75rem;
                font-weight: 700;
                text-transform: uppercase;
            }
            .badge-available { background: rgba(0, 255, 136, 0.1); color: var(--success); border: 1px solid rgba(0, 255, 136, 0.2); }
            .badge-in_use { background: rgba(255, 170, 0, 0.1); color: var(--warning); border: 1px solid rgba(255, 170, 0, 0.2); }
            .badge-resetting { background: rgba(0, 212, 255, 0.1); color: var(--primary); border: 1px solid rgba(0, 212, 255, 0.2); }

            .history-pill {
                font-family: 'JetBrains Mono', monospace;
                font-size: 0.7rem;
                background: rgba(255,255,255,0.05);
                padding: 2px 6px;
                border-radius: 4px;
                margin: 2px;
                display: inline-block;
            }

            .form-group { margin-bottom: 16px; }
            label { display: block; margin-bottom: 8px; font-size: 0.85rem; color: var(--text-muted); }
            input {
                width: 100%;
                background: rgba(0,0,0,0.2);
                border: 1px solid var(--border);
                border-radius: 8px;
                padding: 12px;
                color: #fff;
                font-family: inherit;
                transition: border-color 0.2s;
            }
            input:focus { outline: none; border-color: var(--primary); background: rgba(0,0,0,0.3); }

            .otp-log {
                max-height: 500px;
                overflow-y: auto;
            }
            .otp-item {
                padding: 12px;
                border-bottom: 1px solid var(--border);
                display: flex;
                flex-direction: column;
                gap: 4px;
                animation: fadeIn 0.3s ease;
            }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
            
            .otp-header { display: flex; justify-content: space-between; font-size: 0.8rem; }
            .otp-phone { color: var(--primary); font-weight: 600; }
            .otp-time { color: var(--text-muted); }
            .otp-msg { font-size: 0.85rem; color: #cbd5e1; }
            .otp-code { 
                font-family: 'JetBrains Mono', monospace; 
                font-size: 1.1rem; 
                color: var(--success); 
                font-weight: 700;
                background: rgba(0, 255, 136, 0.05);
                padding: 4px 8px;
                border-radius: 4px;
                align-self: flex-start;
                margin-top: 4px;
            }

            /* Modal Styles */
            .modal {
                display: none;
                position: fixed;
                z-index: 1000;
                left: 0; top: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.8);
                backdrop-filter: blur(4px);
                align-items: center;
                justify-content: center;
            }
            .modal-content {
                background: #1e293b;
                padding: 30px;
                border-radius: 20px;
                width: 100%;
                max-width: 500px;
                border: 1px solid var(--border);
                box-shadow: 0 20px 50px rgba(0,0,0,0.5);
            }

            .loading-bar {
                height: 3px;
                width: 0%;
                background: var(--primary);
                position: fixed;
                top: 0; left: 0;
                transition: width 0.3s;
                z-index: 2000;
            }
            
            .refresh-status {
                font-size: 0.75rem;
                color: var(--text-muted);
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); display: inline-block; animation: pulse 2s infinite; }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }

            ::-webkit-scrollbar { width: 8px; }
            ::-webkit-scrollbar-track { background: transparent; }
            ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 10px; }
            ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
        </style>
    </head>
    <body>
        <div id="loading" class="loading-bar"></div>
        
        <div class="container">
            <header>
                <div>
                    <h1>OTP<span>SERVER</span></h1>
                    <div class="refresh-status"><span class="dot"></span> Live updates active (3s)</div>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-outline" onclick="reloadPool()">Reload Pool</button>
                    <button class="btn btn-primary" onclick="openAddModal()">+ Add Device</button>
                </div>
            </header>

            <div class="grid">
                <!-- Left Column: Devices -->
                <div class="card">
                    <h2>📱 Managed Devices</h2>
                    <div style="overflow-x: auto;">
                        <table id="devices-table">
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>Phone</th>
                                    <th>Status</th>
                                    <th>Used/Reset</th>
                                    <th>Webhook Action</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="devices-body">
                                <tr><td colspan="6" style="text-align:center; padding: 40px;">Loading devices...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Right Column: Logs -->
                <div class="card">
                    <h2>📜 Live OTP Logs</h2>
                    <div id="otp-list" class="otp-log">
                        <div style="text-align:center; padding: 40px; color: var(--text-muted);">Waiting for activity...</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Add/Edit Modal -->
        <div id="device-modal" class="modal">
            <div class="modal-content">
                <h2 id="modal-title">Add New Device</h2>
                <input type="hidden" id="edit-id">
                <div class="form-group">
                    <label>Phone Number (e.g. 85848101010)</label>
                    <input type="text" id="field-phone" placeholder="858... (without 0/+62)">
                </div>
                <div class="form-group">
                    <label>GoPay PIN</label>
                    <input type="text" id="field-pin" placeholder="123456">
                </div>
                <div class="form-group">
                    <label>MacroDroid Device ID (UUID)</label>
                    <input type="text" id="field-device" placeholder="UUID from MacroDroid">
                </div>
                <div class="form-group">
                    <label>Webhook Action Identifier</label>
                    <input type="text" id="field-webhook" placeholder="e.g. reset-link-1">
                </div>
                <div style="display: flex; gap: 10px; margin-top: 20px;">
                    <button class="btn btn-outline" style="flex: 1" onclick="closeModal()">Cancel</button>
                    <button class="btn btn-primary" style="flex: 2" id="btn-save" onclick="saveDevice()">Save Device</button>
                </div>
            </div>
        </div>

        <script>
            let isEditing = false;
            let lastUpdate = 0;

            async function updateDashboard() {
                try {
                    const [statusRes, otpRes] = await Promise.all([
                        fetch('/gopay/status'),
                        fetch('/otp')
                    ]);
                    
                    const devices = await statusRes.json();
                    let otps = [];
                    if (otpRes.ok) {
                        const data = await otpRes.json();
                        otps = Array.isArray(data) ? data : [data];
                    }

                    renderDevices(devices);
                    renderOTPs(otps);
                    lastUpdate = Date.now();
                } catch (e) {
                    console.error("Update failed:", e);
                }
            }

            function renderDevices(devices) {
                const tbody = document.getElementById('devices-body');
                if (!devices || devices.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 40px; color: var(--text-muted);">No devices configured</td></tr>';
                    return;
                }

                tbody.innerHTML = devices.map(s => {
                    let badgeClass = 'badge-available';
                    if (s.status === 'in_use') badgeClass = 'badge-in_use';
                    if (s.status === 'resetting') badgeClass = 'badge-resetting';

                    return \`
                        <tr>
                            <td style="font-weight:bold; color: var(--warning);">\${s.id}</td>
                            <td style="font-family: 'JetBrains Mono'; color: var(--primary);">\${s.phone}</td>
                            <td><span class="status-badge \${badgeClass}">\${s.status}</span></td>
                            <td>
                                <span style="color:#fff">\${s.usageCount || 0}</span>
                                <span style="color:var(--text-muted)">/</span>
                                <span style="color:var(--text-muted)">\${s.resetCount || 0}</span>
                            </td>
                            <td style="font-size: 0.8rem; color: var(--text-muted);">\${s.webhook_action || '-'}</td>
                            <td style="display: flex; gap: 8px;">
                                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 0.75rem;" onclick="openEditModal(\${JSON.stringify(s).replace(/"/g, '&quot;')})">Edit</button>
                                <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="removeDevice(\${s.id})">Delete</button>
                            </td>
                        </tr>
                    \`;
                }).join('');
            }

            function renderOTPs(otps) {
                const container = document.getElementById('otp-list');
                if (!otps || otps.length === 0) {
                    container.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-muted);">No recent OTP activity</div>';
                    return;
                }

                container.innerHTML = otps.map(item => \`
                    <div class="otp-item">
                        <div class="otp-header">
                            <span class="otp-phone">\${item.PhoneNumber || 'Unknown'}</span>
                            <span class="otp-time">\${new Date(item.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div class="otp-msg">\${item.text ? item.text.substring(0, 80) + '...' : 'No content'}</div>
                        \${item.otp ? \`<div class="otp-code">\${item.otp}</div>\` : ''}
                    </div>
                \`).join('');
            }

            // Modal & Actions
            function openAddModal() {
                isEditing = false;
                document.getElementById('modal-title').textContent = 'Add New Device';
                document.getElementById('edit-id').value = '';
                document.getElementById('field-phone').value = '';
                document.getElementById('field-pin').value = '';
                document.getElementById('field-device').value = '';
                document.getElementById('field-webhook').value = '';
                document.getElementById('device-modal').style.display = 'flex';
            }

            function openEditModal(slot) {
                isEditing = true;
                document.getElementById('modal-title').textContent = 'Edit Device #' + slot.id;
                document.getElementById('edit-id').value = slot.id;
                document.getElementById('field-phone').value = slot.phone;
                document.getElementById('field-pin').value = slot.pin || '';
                document.getElementById('field-device').value = slot.device_id || '';
                document.getElementById('field-webhook').value = slot.webhook_action || '';
                document.getElementById('device-modal').style.display = 'flex';
            }

            function closeModal() {
                document.getElementById('device-modal').style.display = 'none';
            }

            async function saveDevice() {
                const id = document.getElementById('edit-id').value;
                const phone = document.getElementById('field-phone').value.trim();
                const pin = document.getElementById('field-pin').value.trim();
                const device_id = document.getElementById('field-device').value.trim();
                const webhook_action = document.getElementById('field-webhook').value.trim();

                if (!phone || !pin || !device_id || !webhook_action) {
                    alert('All fields are required!');
                    return;
                }

                const endpoint = isEditing ? '/gopay/edit' : '/gopay/add';
                const body = { phone, pin, device_id, webhook_action };
                if (isEditing) body.id = id;

                try {
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const data = await res.json();
                    if (res.ok) {
                        closeModal();
                        updateDashboard();
                    } else {
                        alert('Error: ' + data.error);
                    }
                } catch (e) {
                    alert('Request failed: ' + e.message);
                }
            }

            async function removeDevice(id) {
                if (!confirm('Permanently remove device #' + id + '?')) return;
                try {
                    const res = await fetch('/gopay/remove?id=' + id, { method: 'DELETE' });
                    if (res.ok) updateDashboard();
                    else alert('Delete failed');
                } catch (e) { alert('Error: ' + e.message); }
            }

            async function reloadPool() {
                const btn = event.target;
                const originalText = btn.textContent;
                btn.textContent = 'Reloading...';
                try {
                    const res = await fetch('/gopay/reload');
                    const data = await res.json();
                    alert('Pool reloaded: ' + data.count + ' slots active.');
                    updateDashboard();
                } catch (e) { alert('Reload failed'); }
                btn.textContent = originalText;
            }

            // Auto refresh logic
            setInterval(updateDashboard, 3000);
            updateDashboard();
        </script>
    </body>
    </html>
    \`;
    res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`OTP Server is running on http://localhost:${PORT}`);
    console.log(`Accepting connections from all interfaces (0.0.0.0)`);
});
