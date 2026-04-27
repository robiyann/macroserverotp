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

    _mergeConfigIntoState(configData, currentState) {
        // 1. Ambil semua yang ada di currentState tapi masih ada di configData
        let merged = currentState.map(existing => {
            const config = configData.find(c => c.id === existing.id);
            if (config) {
                return {
                    ...config,
                    status: existing.status,
                    claimedAt: existing.claimedAt,
                    usageCount: existing.usageCount || 0,
                    resetCount: existing.resetCount || 0,
                    usageHistory: existing.usageHistory || []
                };
            }
            return null;
        }).filter(Boolean);

        // 2. Tambahkan nomor baru dari config yang belum ada di state (taruh di belakang)
        configData.forEach(slot => {
            const alreadyIn = merged.some(m => m.id === slot.id);
            if (!alreadyIn) {
                merged.push({
                    ...slot,
                    status: 'available',
                    claimedAt: null,
                    usageCount: 0,
                    resetCount: 0,
                    usageHistory: []
                });
            }
        });

        return merged;
    }

    _saveState(stateArray) {
        fs.writeFileSync(this.statePath, JSON.stringify(stateArray, null, 2));
    }

    _logPool(message, isError = false) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        const prefix = '[POOL_MGR]'.padEnd(16);
        if (isError) console.error(`[${time}] ${prefix} | ERROR: ${message}`);
        else console.log(`[${time}] ${prefix} | ${message}`);
    }

    load() {
        this._withLock(() => {
            try {
                if (fs.existsSync(this.configPath)) {
                    const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                    let currentState = this._loadState();
                    
                    const newSlots = this._mergeConfigIntoState(data, currentState);
                    
                    this._saveState(newSlots);
                    this.initialized = true;
                    this._logPool(`Memuat ${newSlots.length} Data GoPay. Fairness Rotation: ACTIVE.`);
                } else {
                    this._logPool(`Config tidak ditemukan di ${this.configPath}. Fallback manual.`, true);
                    this.initialized = false;
                }
            } catch (e) {
                this._logPool(`Gagal load pool config: ${e.message}`, true);
                this.initialized = false;
            }
        });
        
        if (this.initialized) {
            this.startCleanupInterval();
        }
    }

    reload() {
        return this._withLock(() => {
            try {
                if (!fs.existsSync(this.configPath)) {
                    this._logPool(`Config tidak ditemukan di ${this.configPath} saat reload.`, true);
                    return { success: false, message: 'Config file not found' };
                }

                const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                let currentState = this._loadState();
                
                const mergedState = this._mergeConfigIntoState(data, currentState);
                
                this._saveState(mergedState);
                this._logPool(`Config di-reload. Total slot: ${mergedState.length}. Urutan antrean tetap dipertahankan.`);
                return { success: true, count: mergedState.length };

            } catch (e) {
                this._logPool(`Gagal reload pool config: ${e.message}`, true);
                return { success: false, message: e.message };
            }
        });
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
                        this._logPool(`TTL EXPIRED: Antrean Slot ${slot.id} macet selama lebih dari 5 Menit. Paksa hapus ke 'Available'.`);
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
                
                // Analytics Tracking
                slot.usageCount = (slot.usageCount || 0) + 1;
                if (!slot.usageHistory) slot.usageHistory = [];
                slot.usageHistory.unshift({
                    event: 'claimed',
                    timestamp: new Date().toISOString()
                });
                if (slot.usageHistory.length > 5) {
                    slot.usageHistory.pop(); // Keep only last 5
                }
                
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
                
                if (!slot.usageHistory) slot.usageHistory = [];
                slot.usageHistory.unshift({
                    event: 'released_manually',
                    timestamp: new Date().toISOString()
                });
                if (slot.usageHistory.length > 5) slot.usageHistory.pop();
                
                // Round-robin: pindahkan slot ke antrian paling belakang setelah dipakai
                slots.splice(index, 1);
                slots.push(slot);
                
                this._saveState(slots);
                this._logPool(`Slot ${id} dibebaskan (${prev} -> available). Antrean digeser ke belakang.`);
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
                
                if (!slot.usageHistory) slot.usageHistory = [];
                slot.usageHistory.unshift({
                    event: 'resetting_triggered',
                    timestamp: new Date().toISOString()
                });
                if (slot.usageHistory.length > 5) slot.usageHistory.pop();
                
                this._saveState(slots);
                this._logPool(`Slot ${id} merubah status -> RESETTING...`);
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
                    this._logPool(`Slot ${id} lapor Reset Done, tapi nomor sudah Available. (Abaikan)`);
                    return true;
                }
                const prev = slot.status;
                slot.status = 'available';
                slot.claimedAt = null;

                slot.resetCount = (slot.resetCount || 0) + 1;
                if (!slot.usageHistory) slot.usageHistory = [];
                slot.usageHistory.unshift({
                    event: 'reset_done',
                    timestamp: new Date().toISOString()
                });
                if (slot.usageHistory.length > 5) slot.usageHistory.pop();

                // Round-robin: pindah ke belakang antrian agar giliran merata
                slots.splice(index, 1);
                slots.push(slot);

                this._saveState(slots);
                this._logPool(`Slot ${id} selesai di-Reset (${prev} -> available). Siap dipinjam robot berikutnya!`);
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
                    this._logPool(`Command RESET-ALL: Slot ${slot.id} dipaksa bebas (${prev} -> available)`);
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
