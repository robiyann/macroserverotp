# OTP Server & MacroDroid Automation System

A centralized Node.js/Express server designed to receive WhatsApp notifications from Android devices (via MacroDroid), extract OTP codes, and provide a polling API for automated bots. It also supports remote triggers and status logging for GoPay automation.

## 🚀 Server Details (VPS)
- **Base URL**: `http://146.190.85.126:3000`
- **Dashboard**: `http://146.190.85.126:3000/` (Monitoring real-time logs)
- **Data Persistence**: `otps.json` (Stores messages for 30 seconds)

---

## 🛠 API Reference (For Bot/Agent Integration)

| Endpoint | Method | Params | Description |
| :--- | :--- | :--- | :--- |
| `/otp` | `GET` | `server`, `phone` | Returns the latest fresh OTP (max 30s old). |
| `/trigger-hp` | `GET` | `action` | Triggers a MacroDroid Webhook on the device. |
| `/receive` | `POST` | (JSON Body) | Receives notification data from MacroDroid. |
| `/statusgpay` | `POST` | (JSON Body) | Logs custom status updates (e.g., "reset done"). |

---

## 📱 MacroDroid Configuration (HP)

### A. OTP Forwarding
**Trigger**: Notification Received (WhatsApp)  
**Action**: HTTP Request (POST) to `/receive`  
**Payload**:
```json
{
  "sender": "[notification_title]",
  "text": "[notification_text]",
  "server_number": "1",
  "PhoneNumber": "85848101010"
}
```

### B. Status Reporting (e.g. Unlink Success)
**Action**: HTTP Request (POST) to `/statusgpay`  
**Payload**:
```json
{
  "text": "Unlink GoPay Berhasil [hour]:[minute]",
  "server_number": "1",
  "status": "reset done",
  "PhoneNumber": "85848101010"
}
```

### C. Inbound Trigger (Webhook)
**Trigger**: Webhook  
**Identifier**: `reset-link` (or any custom identifier)  
**URL**: `https://trigger.macrodroid.com/75a484c3-631d-4ab6-a5e1-77daae598087/{identifier}`

---

## 🤖 Integration Scripts

### 1. `pool_test.js`
Polls the server specifically looking for a new OTP code.
```bash
node pool_test.js
```

### 2. `pool_status.js`
Polls the server waiting for a specific status update (e.g. `reset done`).
```bash
node pool_status.js
```

---

## 🔒 Security & Optimization
- **TTL (Time-To-Live)**: All data is automatically deleted from the server after **30 seconds** of arrival.
- **Filtering**: Only 4-6 digit numeric codes are extracted as OTPs.
- **Logging**: Detailed incoming/outgoing logs are visible in the VPS terminal and Dashboard.

---
*Created by Antigravity AI for Bot/Agent Automation.*
