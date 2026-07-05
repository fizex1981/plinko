const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { Server } = require("socket.io");

// ===== TIKTOK CONNECTOR =====
let WebcastPushConnection = null;

try {
    const TikTokLive = require('tiktok-live-connector');
    WebcastPushConnection = TikTokLive.WebcastPushConnection || TikTokLive.default?.WebcastPushConnection;
    if (WebcastPushConnection) {
        console.log('✅ TikTok connector loaded (v2 style)');
    } else {
        throw new Error('WebcastPushConnection not found');
    }
} catch (e1) {
    try {
        const { WebcastPushConnection: WPC } = require('tiktok-live-connector');
        WebcastPushConnection = WPC;
        console.log('✅ TikTok connector loaded (v1 style)');
    } catch (e2) {
        try {
            const tiktok = require('tiktok-live-connector');
            WebcastPushConnection = tiktok.WebcastPushConnection;
            console.log('✅ TikTok connector loaded (fallback)');
        } catch (e3) {
            console.log('❌ Failed to load TikTok connector:', e3.message);
            console.log('⚠️ Run: npm install tiktok-live-connector@2.0.0');
        }
    }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    } 
});

app.use(express.json());
app.use(express.static(__dirname));

const ADMIN_PASSWORD = "plinko3815";

// ============================================================
// AVATAR CACHE SYSTEM
// ============================================================
const AVATAR_DIR = path.join(__dirname, 'avatars');
const AVATAR_CACHE = new Map();
const DOWNLOAD_QUEUE = [];
let IS_DOWNLOADING = false;

if (!fs.existsSync(AVATAR_DIR)) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

async function downloadAvatar(url, username) {
    return new Promise((resolve) => {
        DOWNLOAD_QUEUE.push({ url, username, resolve });
        processQueue();
    });
}

async function processQueue() {
    if (IS_DOWNLOADING || DOWNLOAD_QUEUE.length === 0) return;
    
    IS_DOWNLOADING = true;
    const item = DOWNLOAD_QUEUE.shift();
    
    try {
        const { url, username, resolve } = item;
        const cleanUser = username.startsWith('@') ? username.substring(1) : username;
        const filename = `${cleanUser}.png`;
        const filepath = path.join(AVATAR_DIR, filename);
        
        if (fs.existsSync(filepath)) {
            const stats = fs.statSync(filepath);
            const age = Date.now() - stats.mtimeMs;
            if (age < 24 * 60 * 60 * 1000) {
                AVATAR_CACHE.set(cleanUser, { path: filepath, timestamp: Date.now() });
                resolve(`/avatars/${filename}`);
                IS_DOWNLOADING = false;
                processQueue();
                return;
            }
        }
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(url, { 
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        clearTimeout(timeout);
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filepath, Buffer.from(buffer));
        
        AVATAR_CACHE.set(cleanUser, { path: filepath, timestamp: Date.now() });
        console.log(`✅ Avatar saved: ${cleanUser}`);
        resolve(`/avatars/${filename}`);
        
    } catch (e) {
        console.log(`⚠️ Failed to download avatar:`, e.message);
        item.resolve(null);
    }
    
    IS_DOWNLOADING = false;
    processQueue();
}

function cleanOldAvatars() {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    let deleted = 0;
    
    try {
        const files = fs.readdirSync(AVATAR_DIR);
        
        files.forEach(file => {
            const filepath = path.join(AVATAR_DIR, file);
            const stats = fs.statSync(filepath);
            const age = now - stats.mtimeMs;
            
            if (age > TWENTY_FOUR_HOURS) {
                fs.unlinkSync(filepath);
                deleted++;
                const username = file.replace('.png', '');
                AVATAR_CACHE.delete(username);
            }
        });
        
        if (deleted > 0) {
            console.log(`🧹 Deleted ${deleted} old avatars (>24h)`);
        }
    } catch (e) {}
}

setInterval(cleanOldAvatars, 60 * 60 * 1000);
cleanOldAvatars();

// ============================================================
// JSON STORAGE
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');

const defaultData = {
    viewers: [],
    peakViewers: 0,
    highScoreAllTime: {
        username: '',
        avatar: '😺',
        avatarPath: '',
        score: 0,
        timestamp: Date.now()
    },
    leaderboard24h: [],
    lastLeaderboardReset: new Date().toDateString(),
    settings: {
        mode: 'offline',
        username: 'ohmeowku',
        connected: false
    },
    stats: {
        totalLikes: 0,
        totalGifts: 0,
        gamesPlayed: 0,
        totalViewers: 0
    },
    giftCounts: {
        rose: 0,
        donut: 0,
        donat: 0,
        fingerheart: 0
    },
    lastUpdated: Date.now()
};

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            return { ...defaultData, ...data };
        }
    } catch (e) {}
    return { ...defaultData };
}

function saveData(data) {
    try {
        data.lastUpdated = Date.now();
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        return false;
    }
}

let appData = loadData();

// ============================================================
// LEADERBOARD 24 JAM
// ============================================================
const LEADERBOARD_RESET_HOUR = 0; // 12:00 AM
const LEADERBOARD_MAX = 10;
let leaderboard24h = appData.leaderboard24h || [];

function resetLeaderboard24h() {
    if (leaderboard24h.length > 0) {
        console.log(`🏆 [24H] Leaderboard reset - ${leaderboard24h.length} entries cleared`);
        leaderboard24h = [];
        appData.leaderboard24h = leaderboard24h;
        saveData(appData);
        io.emit('leaderboard_24h_update', { leaderboard: [], reset: true });
    }
}

function checkAndResetLeaderboard() {
    const now = new Date();
    const currentHour = now.getHours();
    const today = now.toDateString();
    
    if (currentHour === LEADERBOARD_RESET_HOUR) {
        if (appData.lastLeaderboardReset !== today) {
            resetLeaderboard24h();
            appData.lastLeaderboardReset = today;
            saveData(appData);
        }
    }
}

function updateLeaderboard24h(username, avatar, avatarPath, score) {
    checkAndResetLeaderboard();
    
    const existing = leaderboard24h.find(item => item.username === username);
    
    if (existing) {
        if (score > existing.score) {
            existing.score = score;
            existing.avatar = avatar || existing.avatar;
            existing.avatarPath = avatarPath || existing.avatarPath;
            existing.timestamp = Date.now();
        }
    } else {
        leaderboard24h.push({
            username: username,
            avatar: avatar || '😺',
            avatarPath: avatarPath || '',
            score: score,
            timestamp: Date.now()
        });
    }
    
    leaderboard24h.sort((a, b) => b.score - a.score);
    
    if (leaderboard24h.length > LEADERBOARD_MAX) {
        leaderboard24h = leaderboard24h.slice(0, LEADERBOARD_MAX);
    }
    
    appData.leaderboard24h = leaderboard24h;
    saveData(appData);
    io.emit('leaderboard_24h_update', { leaderboard: leaderboard24h });
}

// ============================================================
// SERVER STATE
// ============================================================
let mode = appData.settings.mode || "offline";
let username = appData.settings.username || "ohmeowku";
let connected = appData.settings.connected || false;
let tiktokConnection = null;

// REAL vs BOT viewers
let realViewers = new Set();
let botViewers = new Set();

// Queue kekal sehingga server ditutup
let viewerQueue = new Set();

let peakViewers = appData.peakViewers || 0;
let totalLikes = appData.stats.totalLikes || 0;
let totalGifts = appData.stats.totalGifts || 0;
let gamesPlayed = appData.stats.gamesPlayed || 0;

// Event counter untuk log
let eventCounter = {
    member: 0,
    member_leave: 0,
    room_viewer_list: 0,
    room_user_count: 0,
    disconnected: 0,
    like: 0,
    gift: 0,
    chat: 0
};

function getAllViewers() {
    return new Set([...realViewers, ...botViewers]);
}

function getViewerCount() {
    return realViewers.size + botViewers.size;
}

function saveState() {
    appData.viewers = Array.from(getAllViewers());
    appData.peakViewers = peakViewers;
    appData.settings = { mode, username, connected };
    appData.stats = { totalLikes, totalGifts, gamesPlayed, totalViewers: getViewerCount() };
    appData.leaderboard24h = leaderboard24h;
    return saveData(appData);
}

function updateHighScore(username, avatar, avatarPath, score) {
    // Update all-time highscore
    if (score > appData.highScoreAllTime.score) {
        appData.highScoreAllTime = {
            username: username || '',
            avatar: avatar || '😺',
            avatarPath: avatarPath || '',
            score: parseInt(score) || 0,
            timestamp: Date.now()
        };
        saveData(appData);
    }
    
    // Update leaderboard 24 jam
    updateLeaderboard24h(username, avatar, avatarPath, parseInt(score));
    
    return true;
}

function updateGiftCount(giftName) {
    const giftMap = {
        'rose': 'rose',
        'donut': 'donut', 
        'donat': 'donat',
        'fingerheart': 'fingerheart',
        'Finger Heart': 'fingerheart'
    };
    const key = giftMap[giftName] || giftName;
    if (appData.giftCounts.hasOwnProperty(key)) {
        appData.giftCounts[key]++;
        totalGifts++;
        saveData(appData);
    }
}

function incrementGamesPlayed() {
    gamesPlayed++;
    saveData(appData);
}

function incrementLikes(count) {
    totalLikes += count || 1;
    saveData(appData);
}

function getTarget() {
    return Math.max(100, getViewerCount() * 100);
}

function emitStatus() {
    const target = getTarget();
    io.emit("status", {
        mode,
        username,
        connected,
        viewers: getViewerCount(),
        realViewers: realViewers.size,
        botViewers: botViewers.size,
        target: target,
        peak: peakViewers,
        stats: appData.stats,
        highScore: appData.highScoreAllTime,
        leaderboard24h: leaderboard24h
    });
    io.emit("like_target_update", { target: target });
}

// ============================================================
// ===== REFRESH VIEWER LIST SETIAP 30 SAAT =====
// ============================================================
async function refreshViewerList() {
    if (!connected || !tiktokConnection) {
        console.log('🔄 [REFRESH] Skipped - not connected');
        return;
    }
    
    try {
        // Cuba dapatkan viewer list
        let viewers = null;
        
        if (typeof tiktokConnection.getViewerList === 'function') {
            viewers = await tiktokConnection.getViewerList();
        } else if (typeof tiktokConnection.getRoomViewerList === 'function') {
            viewers = await tiktokConnection.getRoomViewerList();
        }
        
        if (!viewers || viewers.length === 0) {
            console.log('🔄 [REFRESH] No viewers data');
            return;
        }
        
        // Build current viewers set
        const currentViewers = new Set();
        viewers.forEach(v => {
            const userId = v.uniqueId || v.userId || v;
            if (userId) currentViewers.add(userId);
        });
        
        console.log(`🔄 [REFRESH] Room: ${currentViewers.size} viewers, Our: ${realViewers.size}`);
        
        // Cari viewer yang leave
        const leftViewers = [];
        realViewers.forEach(user => {
            if (!currentViewers.has(user)) {
                leftViewers.push(user);
            }
        });
        
        if (leftViewers.length > 0) {
            console.log(`👋 [REFRESH] ${leftViewers.length} viewers left: ${leftViewers.join(', ')}`);
            
            leftViewers.forEach(user => {
                realViewers.delete(user);
                io.emit('viewer_leave', { 
                    user: user, 
                    uniqueId: user,
                    isBot: false,
                    reason: 'refresh_left_room'
                });
                console.log(`   ✅ Emitted viewer_leave for: ${user}`);
            });
            
            emitStatus();
            saveState();
        } else {
            console.log(`🔄 [REFRESH] No viewers left`);
        }
        
    } catch (e) {
        console.log(`🔄 [REFRESH] Error: ${e.message}`);
    }
}

// ============================================================
// API ROUTES
// ============================================================

app.use('/avatars', express.static(AVATAR_DIR));

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        mode,
        connected,
        username,
        viewers: getViewerCount(),
        realViewers: realViewers.size,
        botViewers: botViewers.size,
        target: getTarget(),
        peak: peakViewers,
        uptime: process.uptime(),
        highScore: appData.highScoreAllTime,
        stats: appData.stats,
        giftCounts: appData.giftCounts,
        leaderboard24h: leaderboard24h,
        avatarCount: AVATAR_CACHE.size,
        eventCounter: eventCounter
    });
});

app.get('/api/data', (req, res) => {
    res.json({
        highScore: appData.highScoreAllTime,
        stats: appData.stats,
        giftCounts: appData.giftCounts,
        peakViewers: appData.peakViewers,
        settings: appData.settings,
        lastUpdated: appData.lastUpdated,
        realViewers: Array.from(realViewers),
        botViewers: Array.from(botViewers),
        leaderboard24h: leaderboard24h
    });
});

app.get('/api/leaderboard24h', (req, res) => {
    checkAndResetLeaderboard();
    res.json(leaderboard24h);
});

app.get('/api/highscore', (req, res) => {
    res.json(appData.highScoreAllTime);
});

app.post('/api/highscore', (req, res) => {
    const { username, avatar, avatarPath, score } = req.body;
    if (username && score !== undefined) {
        updateHighScore(username, avatar, avatarPath, parseInt(score));
        res.json({ 
            success: true, 
            highScore: appData.highScoreAllTime,
            leaderboard24h: leaderboard24h
        });
    } else {
        res.status(400).json({ success: false, error: 'Missing data' });
    }
});

app.post('/api/stats', (req, res) => {
    const { totalLikes: likes, totalGifts: gifts, gamesPlayed: games } = req.body;
    if (likes !== undefined) totalLikes = likes;
    if (gifts !== undefined) totalGifts = gifts;
    if (games !== undefined) gamesPlayed = games;
    saveState();
    res.json({ success: true, stats: { totalLikes, totalGifts, gamesPlayed } });
});

app.get('/api/gifts', (req, res) => {
    res.json(appData.giftCounts);
});

// ============================================================
// ADMIN ROUTES
// ============================================================

app.post('/admin/login', (req, res) => {
    res.json({ success: req.body.password === ADMIN_PASSWORD });
});

app.post('/admin/logout', (req, res) => {
    res.json({ success: true });
});

app.post('/admin/mode', (req, res) => {
    mode = req.body.mode || 'offline';
    saveState();
    emitStatus();
    res.json({ success: true, mode });
});

// ============================================================
// ===== CONNECT =====
// ============================================================
app.post('/admin/connect', async (req, res) => {
    username = (req.body.username || username || "").trim().replace(/^@/, "");
    
    if (!username) {
        return res.json({ success: false, error: 'Please enter TikTok username' });
    }

    if (mode === 'offline') {
        connected = true;
        saveState();
        io.emit('live_status', { connected: true, username });
        emitStatus();
        return res.json({ success: true, status: 'OFFLINE MODE' });
    }
    
    try {
        if (!WebcastPushConnection) {
            return res.json({ 
                success: false, 
                error: 'TikTok connector not available. Please install: npm install tiktok-live-connector@2.0.0' 
            });
        }
        
        if (tiktokConnection) {
            try { 
                tiktokConnection.disconnect(); 
            } catch (e) {}
            tiktokConnection = null;
        }
        
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║                    CONNECTING TO TIKTOK                   ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`📡 Username: @${username}`);
        console.log(`🕐 Time: ${new Date().toISOString()}`);
        console.log('');
        
        tiktokConnection = new WebcastPushConnection(username);
        
        const connectPromise = tiktokConnection.connect();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout (15s) - Make sure the user is LIVE')), 15000);
        });
        
        await Promise.race([connectPromise, timeoutPromise]);
        
        connected = true;
        saveState();
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║                    ✅ CONNECTED!                          ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
        
        // Reset state
        realViewers.clear();
        
        // Reset event counter
        eventCounter = {
            member: 0,
            member_leave: 0,
            room_viewer_list: 0,
            room_user_count: 0,
            disconnected: 0,
            like: 0,
            gift: 0,
            chat: 0
        };

        // ============================================================
        // ===== MEMBER EVENT =====
        // ============================================================
        tiktokConnection.on('member', async (data) => {
            const user = data.uniqueId || data.userId;
            
            if (user) {
                realViewers.add(user);
                viewerQueue.add(user);
                
                if (getViewerCount() > peakViewers) {
                    peakViewers = getViewerCount();
                    saveState();
                }
                
                let avatarPath = null;
                if (data.profilePictureUrl) {
                    avatarPath = await downloadAvatar(data.profilePictureUrl, user);
                }
                
                // AUTO ENTRY DISABLED: user must LIKE or send GIFT to spawn.
                io.emit('viewer_waiting',{user:user,message:'Tap LIKE to enter the game!'});
                emitStatus();
                console.log(`👤 Viewer joined: ${user} (Total: ${realViewers.size})`);
            }
        });

        // ============================================================
        // ===== MEMBER_LEAVE EVENT =====
        // ============================================================
        tiktokConnection.on('member_leave', (data) => {
            const user = data.uniqueId || data.userId;
            
            if (user && realViewers.has(user)) {
                realViewers.delete(user);
                io.emit('viewer_leave', { 
                    user: user, 
                    uniqueId: user,
                    isBot: false,
                    reason: 'leave'
                });
                emitStatus();
                saveState();
                console.log(`👋 Viewer left (member_leave): ${user} (Remaining: ${realViewers.size})`);
            }
        });

        // ============================================================
        // ===== ROOM_VIEWER_LIST EVENT =====
        // ============================================================
        tiktokConnection.on('room_viewer_list', async (data) => {
            if (data && data.viewers && Array.isArray(data.viewers)) {
                const currentViewers = new Set();
                data.viewers.forEach(v => {
                    const userId = v.uniqueId || v.userId;
                    if (userId) currentViewers.add(userId);
                });
                
                // Cari viewer yang leave
                const leftViewers = [];
                realViewers.forEach(user => {
                    if (!currentViewers.has(user)) {
                        leftViewers.push(user);
                    }
                });
                
                if (leftViewers.length > 0) {
                    console.log(`👋 [room_viewer_list] ${leftViewers.length} viewers left: ${leftViewers.join(', ')}`);
                    
                    leftViewers.forEach(user => {
                        realViewers.delete(user);
                        io.emit('viewer_leave', { 
                            user: user, 
                            uniqueId: user,
                            isBot: false,
                            reason: 'left_room'
                        });
                    });
                    
                    emitStatus();
                    saveState();
                }
            }
        });

        // ============================================================
        // ===== ROOM_USER_COUNT EVENT =====
        // ============================================================
        tiktokConnection.on('room_user_count', (data) => {
            // Hanya log, tidak memadam
            const count = data.viewerCount || data.count || 0;
            // console.log(`📊 Room user count: ${count}, Our realViewers: ${realViewers.size}`);
        });

        // ============================================================
        // ===== DISCONNECTED EVENT =====
        // ============================================================
        tiktokConnection.on('disconnected', () => {
            console.log('🔌 Disconnected from TikTok');
            connected = false;
            tiktokConnection = null;
            
            const users = Array.from(realViewers);
            realViewers.clear();
            
            users.forEach(user => {
                io.emit('viewer_leave', { 
                    user: user, 
                    uniqueId: user,
                    isBot: false,
                    reason: 'disconnect'
                });
            });
            
            saveState();
            emitStatus();
            console.log(`🧹 Removed ${users.length} real viewers due to disconnect`);
        });

        // ============================================================
        // ===== LIKE EVENT =====
        // ============================================================
        tiktokConnection.on('like', async (data) => {
            const count = data.likeCount || 1;
            const user = data.uniqueId || data.userId;
            if(!user) return;
            console.log(`❤️ Like from: ${user} (+${count})`);
            incrementLikes(count);
            let avatarPath = '';
            if (data.profilePictureUrl) {
                avatarPath = await downloadAvatar(data.profilePictureUrl, user) || '';
            }
            viewerQueue.delete(user);
            io.emit('like', { count, user, uniqueId:user, avatar: avatarPath });
            io.emit('spawn_user',{user,avatar:avatarPath,source:'like'});
        });

        // ============================================================
        // ===== GIFT EVENT =====
        // ============================================================
        tiktokConnection.on('gift', async (data) => {
            const user = data.uniqueId || data.userId;
            const giftName = data.giftName || data.giftType;
            const avatar = data.profilePictureUrl || '';
            
            if (user && giftName) {
                let avatarPath = null;
                if (avatar) {
                    avatarPath = await downloadAvatar(avatar, user);
                }
                
                let mappedGift = giftName;
                const lower = giftName.toLowerCase();
                if (lower.includes('rose')) mappedGift = 'rose';
                else if (lower.includes('donut')) mappedGift = 'donut';
                else if (lower.includes('donat')) mappedGift = 'donat';
                else if (lower.includes('finger') || lower.includes('heart')) mappedGift = 'fingerheart';
                
                if (['rose', 'donut', 'donat', 'fingerheart'].includes(mappedGift)) {
                    updateGiftCount(mappedGift);
                }
                
                io.emit('force_spawn', { user, uniqueId:user, avatar: avatarPath || '', source:'gift' });
                if(user){ viewerQueue.delete(user); io.emit('spawn_user',{user,avatar:avatarPath||'',source:'gift'}); }
                io.emit('gift', { 
                    user: user, 
                    giftName: mappedGift,
                    originalName: giftName,
                    avatar: avatarPath || '',
                    count: data.giftCount || 1
                });
            }
        });

        // ============================================================
        // ===== CHAT EVENT =====
        // ============================================================
        tiktokConnection.on('chat', (data) => {
            // Hanya log ringkas
            eventCounter.chat++;
            if (eventCounter.chat % 50 === 0) {
                console.log(`💬 [chat] ${eventCounter.chat} messages received`);
            }
        });

        // ============================================================
        // ===== ERROR EVENT =====
        // ============================================================
        tiktokConnection.on('error', (err) => {
            console.log('❌ TikTok error:', err.message);
        });

        console.log('✅ All event listeners registered');
        emitStatus();
        res.json({ success: true, message: `Connected to @${username}` });
        
    } catch (e) {
        console.log('❌ Connection failed:', e.message);
        connected = false;
        tiktokConnection = null;
        saveState();
        res.json({ success: false, error: e.message || 'Connection failed' });
    }
});

app.post('/admin/disconnect', (req, res) => {
    connected = false;
    if (tiktokConnection) {
        try { tiktokConnection.disconnect(); } catch (e) {}
        tiktokConnection = null;
    }
    
    const users = Array.from(realViewers);
    realViewers.clear();
    
    users.forEach(user => {
        io.emit('viewer_leave', { 
            user: user, 
            uniqueId: user,
            isBot: false,
            reason: 'disconnect'
        });
    });
    
    saveState();
    emitStatus();
    res.json({ success: true });
});

// ============================================================
// ===== BOT VIEWER =====
// ============================================================
app.post('/admin/viewer', async (req, res) => {
    const u = req.body.user || ('viewer_' + Date.now());
    
    botViewers.add(u);
    realViewers.delete(u);
    
    if (getViewerCount() > peakViewers) {
        peakViewers = getViewerCount();
        saveState();
    }
    
    const cleanUser = u.startsWith('@') ? u.substring(1) : u;
    let avatarPath = null;
    if (AVATAR_CACHE.has(cleanUser)) {
        avatarPath = `/avatars/${cleanUser}.png`;
    }
    
    io.emit('viewer_join', { 
        user: u, 
        uniqueId: u, 
        nickname: u,
        isBot: true,
        avatar: avatarPath || '',
        avatarUrl: ''
    });
    io.emit('spawn_viewer', { user: u });
    emitStatus();
    saveState();
    
    console.log(`🤖 Bot viewer added: ${u}`);
    res.json({ success: true, user: u, isBot: true });
});

// ============================================================
// ===== REMOVE BOT =====
// ============================================================
app.post('/admin/remove_bot', (req, res) => {
    const user = req.body.user;
    if (user && botViewers.has(user)) {
        botViewers.delete(user);
        saveState();
        io.emit('viewer_leave', { 
            user: user, 
            uniqueId: user,
            isBot: true,
            reason: 'admin_remove'
        });
        emitStatus();
        console.log(`🤖 Bot removed by admin: ${user}`);
        res.json({ success: true, message: `Removed bot ${user}` });
    } else {
        res.json({ success: false, message: 'Bot not found' });
    }
});

app.post('/admin/remove_bots', (req, res) => {
    const count = parseInt(req.body.count) || 10;
    const viewersArray = Array.from(botViewers);
    const toRemove = viewersArray.slice(0, Math.min(count, viewersArray.length));
    
    let removed = 0;
    toRemove.forEach(user => {
        if (botViewers.has(user)) {
            botViewers.delete(user);
            io.emit('viewer_leave', { 
                user: user, 
                uniqueId: user,
                isBot: true,
                reason: 'admin_remove'
            });
            removed++;
        }
    });
    
    saveState();
    emitStatus();
    console.log(`🤖 Removed ${removed} bots`);
    res.json({ success: true, removed: removed });
});

app.post('/admin/remove_all_bots', (req, res) => {
    const users = Array.from(botViewers);
    botViewers.clear();
    saveState();
    
    users.forEach(user => {
        io.emit('viewer_leave', { 
            user: user, 
            uniqueId: user,
            isBot: true,
            reason: 'admin_remove'
        });
    });
    
    emitStatus();
    console.log(`🤖 Removed all ${users.length} bots`);
    res.json({ success: true, removed: users.length });
});

// ============================================================
// ===== LIKES =====
// ============================================================
app.post('/admin/likes', (req, res) => {
    const count = req.body.count || 100;
    incrementLikes(count);
    io.emit('like', { count: count });
    res.json({ success: true });
});

app.post('/admin/reset_likes', (req, res) => {
    totalLikes = 0;
    saveState();
    io.emit('like_reset', { count: 0 });
    res.json({ success: true });
});

// ============================================================
// ===== GIFTS =====
// ============================================================
function getGiftUser(body) {
    if (body && body.user) return body.user;
    const first = Array.from(getAllViewers())[0];
    return first || 'viewer_1';
}

app.post('/admin/rose', (req, res) => {
    const user = getGiftUser(req.body);
    updateGiftCount('rose');
    io.emit('gift', { user: user, giftName: 'Rose' });
    res.json({ success: true });
});

app.post('/admin/donut', (req, res) => {
    const user = getGiftUser(req.body);
    updateGiftCount('donut');
    io.emit('gift', { user: user, giftName: 'Donut' });
    res.json({ success: true });
});

app.post('/admin/donat', (req, res) => {
    const user = getGiftUser(req.body);
    updateGiftCount('donat');
    io.emit('gift', { user: user, giftName: 'Donat' });
    res.json({ success: true });
});

app.post('/admin/fingerheart', (req, res) => {
    const user = getGiftUser(req.body);
    updateGiftCount('fingerheart');
    io.emit('gift', { user: user, giftName: 'Finger Heart' });
    res.json({ success: true });
});

app.post('/admin/timer', (req, res) => {
    const seconds = parseInt(req.body.seconds) || 60;
    io.emit('set_timer', { seconds: seconds });
    res.json({ success: true });
});

app.post('/admin/games_played', (req, res) => {
    incrementGamesPlayed();
    res.json({ success: true, gamesPlayed });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    socket.emit('status', {
        mode,
        username,
        connected,
        viewers: getViewerCount(),
        realViewers: realViewers.size,
        botViewers: botViewers.size,
        target: getTarget(),
        peak: peakViewers,
        stats: appData.stats,
        highScore: appData.highScoreAllTime,
        leaderboard24h: leaderboard24h
    });
    
    getAllViewers().forEach(user => {
        const isBot = botViewers.has(user);
        const cleanUser = user.startsWith('@') ? user.substring(1) : user;
        let avatarPath = null;
        if (AVATAR_CACHE.has(cleanUser)) {
            avatarPath = `/avatars/${cleanUser}.png`;
        }
        socket.emit('viewer_join', { 
            user: user, 
            uniqueId: user, 
            nickname: user,
            isBot: isBot,
            avatar: avatarPath || '',
            avatarUrl: ''
        });
    });
    
    socket.on('balloon_removed', (data) => {
        const user = data.user;
        if (user) {
            const cleanUser = user.startsWith('@') ? user.substring(1) : user;
            if (realViewers.has(cleanUser)) {
                realViewers.delete(cleanUser);
                console.log(`👤 Viewer removed (balloon dropped): ${cleanUser}`);
                emitStatus();
                saveState();
            }
        }
    });
    
    
    socket.on('round_finished', () => {
        io.emit('force_round_reset');
        console.log('🏁 Round finished - waiting for new likes');
    });


    socket.on('player_killed', ({user}) => {
        if (!user) return;
        realViewers.delete(user);
        appData.viewers = (appData.viewers || []).filter(v => v !== user);
        saveState();
        io.emit('player_killed', {user});
        console.log(`💀 Removed ${user} from active round (score preserved)`);
    });

socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============================================================
// ===== SETUP INTERVALS =====
// ============================================================

// Refresh viewer list setiap 30 saat
setInterval(refreshViewerList, 30000);

// Check leaderboard reset setiap jam
setInterval(checkAndResetLeaderboard, 60 * 60 * 1000);

// Auto-save setiap 30 saat
setInterval(saveState, 30000);

// ============================================================
// ===== SHUTDOWN HANDLERS =====
// ============================================================
process.on('SIGINT', () => {
    saveState();
    process.exit(0);
});

process.on('SIGTERM', () => {
    saveState();
    process.exit(0);
});

// ============================================================
// ===== START SERVER =====
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🚀 SERVER RUNNING                                      ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  📡 Port: ${PORT}`);
    console.log(`║  📡 Mode: ${mode}`);
    console.log(`║  🔌 TikTok: ${WebcastPushConnection ? '✅ LOADED' : '❌ NOT LOADED'}`);
    console.log(`║  📁 Avatars: ${AVATAR_DIR}`);
    console.log(`║  🔄 Refresh: Every 30 seconds`);
    console.log(`║  🏆 Leaderboard: 24h (resets at 12:00 AM)`);
    console.log(`║  👤 Real viewers: member_leave + room_viewer_list + refresh`);
    console.log(`║  🤖 Bot viewers: Can be removed by admin`);
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('📡 Waiting for TikTok events...');
    console.log('');
});