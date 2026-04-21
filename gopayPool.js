const fs = require('fs');
const path = require('path');

class GopayPool {
    constructor() {
        this.configPath = path.join(__dirname, 'gopay_pool.json');
        this.slots = [];
        this.initialized = false;
        this.TTL_MS = 5 * 60 * 1000; // 5 Minutes TTL
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                this.slots = data.map(slot => ({
                    ...slot,
                    status: 'available', // State: available, in_use, resetting, reset_done
                    claimedAt: null
                }));
                this.initialized = true;
                console.log(`[Pool] Loaded ${this.slots.length} GoPay slots.`);
                
                // Start background cleanup
                this.startCleanupInterval();
            } else {
                console.log(`[Pool] Configuration file not found at ${this.configPath}. Fallback to manual mode.`);
                this.initialized = false;
            }
        } catch (e) {
            console.error('[Pool] Error loading config:', e.message);
            this.initialized = false;
        }
    }

    startCleanupInterval() {
        setInterval(() => {
            const now = Date.now();
            this.slots.forEach(slot => {
                if (slot.status !== 'available' && slot.claimedAt && (now - slot.claimedAt > this.TTL_MS)) {
                    const prevStatus = slot.status;
                    slot.status = 'available';
                    slot.claimedAt = null;
                    console.log(`[Pool] TTL EXPIRED: Slot ${slot.id} was stuck in ${prevStatus} for >5m. Force reset to available.`);
                }
            });
        }, 30000); // Check every 30 seconds
    }

    claim() {
        if (!this.initialized) return null;
        
        // Only claim truly available slots
        const slot = this.slots.find(s => s.status === 'available');
        if (slot) {
            slot.status = 'in_use';
            slot.claimedAt = Date.now();
            return { ...slot };
        }
        return null; // All busy
    }

    release(id) {
        const index = this.slots.findIndex(s => s.id == id || s.server_number == id);
        if (index !== -1) {
            const slot = this.slots[index];
            const prev = slot.status;
            slot.status = 'available';
            slot.claimedAt = null;
            
            // Round-robin: pindahkan slot ke antrian paling belakang setelah dipakai
            this.slots.splice(index, 1);
            this.slots.push(slot);

            console.log(`[Pool] Slot ${id} released (${prev} -> available). Moved to back of queue.`);
            return true;
        }
        return false;
    }

    markResetting(id) {
        const slot = this.slots.find(s => s.id == id || s.server_number == id);
        if (slot) {
            slot.status = 'resetting';
            // Extend TTL slightly? No, stick to original claim time for safety
            console.log(`[Pool] Slot ${id} status: RESETTING...`);
            return true;
        }
        return false;
    }

    markResetDone(id) {
        const slot = this.slots.find(s => s.id == id || s.server_number == id);
        if (slot) {
            slot.status = 'reset_done';
            console.log(`[Pool] Slot ${id} Reset Done -> reset_done (still locked, waiting for release).`);
            return true;
        }
        return false;
    }

    getStatus() {
        const now = Date.now();
        return this.slots.map(s => {
            let remaining = null;
            if (s.status !== 'available' && s.claimedAt) {
                remaining = Math.max(0, Math.ceil((this.TTL_MS - (now - s.claimedAt)) / 1000));
            }
            return {
                id: s.id,
                phone: s.phone,
                status: s.status,
                ttl_seconds: remaining
            };
        });
    }
}

const pool = new GopayPool();
pool.load();

module.exports = pool;
