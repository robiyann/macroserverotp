const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

const { extractOTP } = require('./utils/otpParser');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'otps.json');

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
        console.log(`[Cleanup] Deleted ${originalLength - otpData.length} expired OTPs`);
        saveDate();
    }
}, 2000);

// Routes

/**
 * Endpoint for MacroDroid to POST notifications.
 * Body: { sender, text, server_number, PhoneNumber }
 */
app.post('/receive', (req, res) => {
    const { sender, text, server_number, PhoneNumber } = req.body;
    
    console.log(`[Incoming] Request from MacroDroid: server=${server_number}, phone=${PhoneNumber}`);

    if (!sender || !text) {
        console.log(`[Error] Missing sender or text in payload:`, req.body);
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
        console.log(`[Success] New OTP Saved: ${otp} for Phone: ${PhoneNumber}`);
    } else {
        console.log(`[Status] Notification Saved: "${text.substring(0, 30)}..."`);
    }
    
    res.json({ success: true, otp });
});

/**
 * Endpoint to trigger MacroDroid on the phone.
 * Query: ?action=your_identifier
 */
app.get('/trigger-hp', (req, res) => {
    const { action } = req.query;
    const DEVICE_ID = '75a484c3-631d-4ab6-a5e1-77daae598087';

    if (!action) {
        return res.status(400).json({ error: 'Missing action identifier' });
    }

    const webhookUrl = `https://trigger.macrodroid.com/${DEVICE_ID}/${action}`;

    console.log(`[Trigger] Sending command "${action}" to HP...`);

    https.get(webhookUrl, (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
            console.log(`[Trigger] Webhook response: ${data}`);
            res.json({ success: true, message: `Command "${action}" sent to HP`, response: data });
        });
    }).on("error", (err) => {
        console.error(`[Trigger] Error: ${err.message}`);
        res.status(500).json({ error: 'Failed to trigger MacroDroid', details: err.message });
    });
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

    const html = `
    <html>
    <head>
        <title>OTP Server Dashboard</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1a1a1a; color: #e0e0e0; margin: 0; padding: 20px; }
            .container { max-width: 1000px; margin: auto; background: #2d2d2d; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
            h1 { color: #fff; border-bottom: 2px solid #555; padding-bottom: 10px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th { text-align: left; background: #3d3d3d; padding: 10px; }
            .refresh { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; float: right; }
            .refresh:hover { background: #0056b3; }
        </style>
        <script>
            setTimeout(() => location.reload(), 5000);
        </script>
    </head>
    <body>
        <div class="container">
            <button class="refresh" onclick="location.reload()">Refresh Now</button>
            <h1>OTP Server Dashboard</h1>
            <p>Monitoring WhatsApp Notifications via MacroDroid</p>
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Srv #</th>
                        <th>Phone Number</th>
                        <th>Sender</th>
                        <th>Content</th>
                        <th>Extracted OTP</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows || '<tr><td colspan="6" style="text-align:center; padding: 20px;">Waiting for notifications...</td></tr>'}
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
