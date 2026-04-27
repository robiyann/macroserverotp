const fs = require('fs');
const path = require('path');

class GopayPool {
    constructor() {
        this.configPath = path.join(__dirname, 'gopay_pool.json');
        this.statePath = path.join(__dirname, 'gopay_state.json');
        this.lockPath = path.join(__dirname, 'gopay_pool.lock');
        this.initialized = false;
        this.TTL_MS = 5 * 60 * 1000; // 5 Minutes TTL
    }

    _withLock(callback) {
        let locked = false;
        let attempts = 0;
        const maxAttempts = 100; // 100 * 50ms = 5 seconds
        
        while (!locked && attempts < maxAttempts) {
            try {
                fs.mkdirSync(this.lockPath);
                locked = true;
            } catch (err) {
                if (err.code === 'EEXIST') {
                    // Try to clear a dead lock (older than 10s)
                    try {
                        const stat = fs.statSync(this.lockPath);
                        if (Date.now() - stat.mtimeMs > 10000) {
                            fs.rmdirSync(this.lockPath);
                        }
                    } catch (e) {}
                    
                    attempts++;
                    const start = Date.now(); while(Date.now() - start < 50) {} // busy wait 50ms
                } else {
                    throw err;
                }
            }
        }
        if (!locked) {
            console.error('[Pool] Timeout Waiting for File Lock!');
            return null; // failed to acquire lock
        }
        
        try {
            return callback();
        } finally {
            try { fs.rmdirSync(this.lockPath); } catch (e) {}
        }
    }

    _loadState() {
        if (!fs.existsSync(this.statePath)) return [];
        try {
            return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        } catch (e) {
            return [];
        }
    }

    _saveState(stateArray) {
        fs.writeFileSync(this.statePath, JSON.stringify(stateArray, null, 2));
    }

    get slots() {
        // Fallback for direct array access in server.js reset-all trigger
        return this._loadState();
    }

    load() {
        this._withLock(() => {
            try {
                if (fs.existsSync(this.configPath)) {
                    const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                    let currentState = this._loadState();
                    
                    const newSlots = data.map(slot => {
                        const existing = currentState.find(s => s.id === slot.id);
                        return {
                            ...slot,
                            status: existing ? existing.status : 'available',
                            claimedAt: existing ? existing.claimedAt : null
                        };
                    });
                    
                    this._saveState(newSlots);
                    this.initialized = true;
                    console.log(`[Pool] Loaded ${newSlots.length} GoPay slots. Mode: Anti-Collision PM2`);
                } else {
                    console.log(`[Pool] Configuration file not found at ${this.configPath}. Fallback to manual mode.`);
                    this.initialized = false;
                }
            } catch (e) {
                console.error('[Pool] Error loading config:', e.message);
                this.initialized = false;
            }
        });
        
        if (this.initialized) {
            this.startCleanupInterval();
        }
    }

    startCleanupInterval() {
        setInterval(() => {
            this._withLock(() => {
                const now = Date.now();
                const slots = this._loadState();
                let changed = false;

                slots.forEach(slot => {
                    if (slot.status !== 'available' && slot.claimedAt && (now - slot.claimedAt > this.TTL_MS)) {
                        const prevStatus = slot.status;
                        slot.status = 'available';
                        slot.claimedAt = null;
                        changed = true;
                        console.log(`[Pool] TTL EXPIRED: Slot ${slot.id} was stuck in ${prevStatus} for >5m. Force reset to available.`);
                    }
                });

                if (changed) this._saveState(slots);
            });
        }, 30000); // Check every 30 seconds
    }

    claim() {
        if (!this.initialized) return null;
        
        return this._withLock(() => {
            const slots = this._loadState();
            
            // Only claim truly available slots
            const slot = slots.find(s => s.status === 'available');
            if (slot) {
                slot.status = 'in_use';
                slot.claimedAt = Date.now();
                this._saveState(slots);
                return { ...slot };
            }
            return null; // All busy
        });
    }

    release(id) {
        return this._withLock(() => {
            const slots = this._loadState();
            const index = slots.findIndex(s => s.id == id || s.server_number == id);
            
            if (index !== -1) {
                const slot = slots[index];
                const prev = slot.status;
                slot.status = 'available';
                slot.claimedAt = null;
                
                // Round-robin: pindahkan slot ke antrian paling belakang setelah dipakai
                slots.splice(index, 1);
                slots.push(slot);
                
                this._saveState(slots);
                console.log(`[Pool] Slot ${id} released (${prev} -> available). Moved to back of queue.`);
                return true;
            }
            return false;
        });
    }

    markResetting(id) {
        return this._withLock(() => {
            const slots = this._loadState();
            const slot = slots.find(s => s.id == id || s.server_number == id);
            
            if (slot) {
                slot.status = 'resetting';
                this._saveState(slots);
                console.log(`[Pool] Slot ${id} status: RESETTING...`);
                return true;
            }
            return false;
        });
    }

    markResetDone(id) {
        return this._withLock(() => {
            const slots = this._loadState();
            const index = slots.findIndex(s => s.id == id || s.server_number == id);
            
            if (index !== -1) {
                const slot = slots[index];
                if (slot.status === 'available') {
                    console.log(`[Pool] Slot ${id} reported Reset Done, but was already available. Ignoring.`);
                    return true;
                }
                const prev = slot.status;
                slot.status = 'available';
                slot.claimedAt = null;

                // Round-robin: pindah ke belakang antrian agar giliran merata
                slots.splice(index, 1);
                slots.push(slot);

                this._saveState(slots);
                console.log(`[Pool] Slot ${id} Reset Done (${prev} -> available). Siap digunakan task berikutnya.`);
                return true;
            }
            return false;
        });
    }

    resetAll() {
        return this._withLock(() => {
            const slots = this._loadState();
            let changedSlots = [];
            slots.forEach(slot => {
                const prev = slot.status;
                slot.status = 'available';
                slot.claimedAt = null;
                if (prev !== 'available') {
                    console.log(`[Pool] RESET-ALL: Slot ${slot.id} (${prev} -> available)`);
                    changedSlots.push(slot);
                }
            });
            this._saveState(slots);
            return changedSlots; // Return list of reset slots so server.js can trigger their webhooks
        });
    }

    getStatus() {
        const now = Date.now();
        const slots = this._loadState();
        return slots.map(s => {
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
