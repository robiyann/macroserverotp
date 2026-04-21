const fs = require('fs');
const path = require('path');

class GopayPool {
    constructor() {
        this.configPath = path.join(__dirname, 'gopay_pool.json');
        this.slots = [];
        this.initialized = false;
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                this.slots = data.map(slot => ({
                    ...slot,
                    status: 'available' // State: available, in_use, resetting
                }));
                this.initialized = true;
                console.log(`[Pool] Loaded ${this.slots.length} GoPay slots.`);
            } else {
                console.log(`[Pool] Configuration file not found at ${this.configPath}. Fallback to manual mode.`);
                this.initialized = false;
            }
        } catch (e) {
            console.error('[Pool] Error loading config:', e.message);
            this.initialized = false;
        }
    }

    claim() {
        if (!this.initialized) return null;
        
        const slot = this.slots.find(s => s.status === 'available');
        if (slot) {
            slot.status = 'in_use';
            return { ...slot };
        }
        return null; // All busy
    }

    release(id) {
        const slot = this.slots.find(s => s.id == id || s.server_number == id);
        if (slot) {
            slot.status = 'available';
            console.log(`[Pool] Slot ${id} released (available).`);
            return true;
        }
        return false;
    }

    markResetting(id) {
        const slot = this.slots.find(s => s.id == id || s.server_number == id);
        if (slot) {
            slot.status = 'resetting';
            console.log(`[Pool] Slot ${id} status: RESETTING...`);
            return true;
        }
        return false;
    }

    markResetDone(id) {
        const slot = this.slots.find(s => s.id == id || s.server_number == id);
        if (slot) {
            slot.status = 'available';
            console.log(`[Pool] Slot ${id} Reset Done -> AVAILABLE.`);
            return true;
        }
        return false;
    }

    getStatus() {
        return this.slots.map(s => ({
            id: s.id,
            phone: s.phone,
            status: s.status
        }));
    }
}

const pool = new GopayPool();
pool.load();

module.exports = pool;
