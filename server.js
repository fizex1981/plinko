const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { Server } = require("socket.io");

let WebcastPushConnection = null;
try {
    const tiktok = require("tiktok-live-connector");
    console.log("TikTok exports:", Object.keys(tiktok));
    WebcastPushConnection = tiktok.WebcastPushConnection;
    console.log("Connector type:", typeof WebcastPushConnection);
    console.log("✅ TikTok connector loaded successfully");
} catch (e) {
    console.error("❌ TikTok connector load failed:", e);
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
// AVATAR CACHE SYSTEM (TANPA RESIZE)
// ============================================================
const AVATAR_DIR = path.join(__dirname, 'avatars');
const AVATAR_CACHE = new Map();
const DOWNLOAD_QUEUE = [];
let IS_DOWNLOADING = false;

if (!fs.existsSync(AVATAR_DIR)) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

// ============================================================
// DOWNLOAD AVATAR DENGAN QUEUE (LIMIT 1 CONCURRENT)
// ============================================================
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
        
        // Check if already exists
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
        
        // Download with timeout
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

// ============================================================
// AUTO DELETE AVATARS OLDER THAN 24 HOURS
// ============================================================
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
    } catch (e) {
        // Ignore errors
    }
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
    highScore24: {
        username: '',
        avatar: '😺',
        score: 0,
        timestamp: Date.now()
    },
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
// SERVER STATE
// ============================================================
let mode = appData.settings.mode || "offline";
let username = appData.settings.username || "ohmeowku";
let connected = appData.settings.connected || false;
let tiktokConnection = null;
let activeViewers = new Set(appData.viewers || []);
let peakViewers = appData.peakViewers || 0;
let totalLikes = appData.stats.totalLikes || 0;
let totalGifts = appData.stats.totalGifts || 0;
let gamesPlayed = appData.stats.gamesPlayed || 0;

function saveState() {
    appData.viewers = Array.from(activeViewers);
    appData.peakViewers = peakViewers;
    appData.settings = { mode, username, connected };
    appData.stats = { totalLikes, totalGifts, gamesPlayed, totalViewers: activeViewers.size };
    return saveData(appData);
}

function updateHighScore(highScore) {
    if (highScore.score > appData.highScore24.score) {
        appData.highScore24 = {
            username: highScore.username || '',
            avatar: highScore.avatar || '😺',
            score: parseInt(highScore.score) || 0,
            timestamp: Date.now()
        };
        saveData(appData);
        return true;
    }
    return false;
}

function updateGiftCount(giftName) {
    if (appData.giftCounts.hasOwnProperty(giftName)) {
        appData.giftCounts[giftName]++;
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
    return Math.max(100, peakViewers * 100);
}

function emitStatus() {
    const target = getTarget();
    io.emit("status", {
        mode,
        username,
        connected,
        viewers: activeViewers.size,
        target: target,
        peak: peakViewers,
        stats: appData.stats,
        highScore: appData.highScore24
    });
    io.emit("like_target_update", { target: target });
}

app.use('/avatars', express.static(AVATAR_DIR));

// ============================================================
// API ROUTES
// ============================================================

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        mode,
        connected,
        username,
        viewers: activeViewers.size,
        target: getTarget(),
        peak: peakViewers,
        uptime: process.uptime(),
        highScore: appData.highScore24,
        stats: appData.stats,
        giftCounts: appData.giftCounts,
        avatarCount: AVATAR_CACHE.size
    });
});

app.get('/api/data', (req, res) => {
    res.json({
        highScore: appData.highScore24,
        stats: appData.stats,
        giftCounts: appData.giftCounts,
        peakViewers: appData.peakViewers,
        settings: appData.settings,
        lastUpdated: appData.lastUpdated
    });
});

app.post('/api/highscore', (req, res) => {
    const { username, avatar, score } = req.body;
    if (username && score !== undefined) {
        const newHigh = {
            username: username,
            avatar: avatar || '😺',
            score: parseInt(score) || 0
        };
        const isNewRecord = updateHighScore(newHigh);
        res.json({ 
            success: true, 
            highScore: appData.highScore24,
            isNewRecord: isNewRecord
        });
    } else {
        res.status(400).json({ success: false, error: 'Missing data' });
    }
});

app.get('/api/highscore', (req, res) => {
    res.json(appData.highScore24);
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

app.post('/admin/connect', async (req, res) => {
    username = req.body.username || username;
    
    if (mode === 'offline') {
        connected = true;
        saveState();
        io.emit('live_status', { connected: true, username });
        emitStatus();
        return res.json({ success: true, status: 'OFFLINE CONNECTED' });
    }
    
    try {
        if (!WebcastPushConnection) {
            return res.json({ 
                success: false, 
                error: 'TikTok connector not installed' 
            });
        }
        
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch (e) {}
            tiktokConnection = null;
        }
        
        tiktokConnection = new WebcastPushConnection(username);
        
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout')), 15000);
        });
        
        await Promise.race([tiktokConnection.connect(), timeoutPromise]);
        
        connected = true;
        saveState();
        console.log(`✅ Connected to TikTok live: ${username}`);
        
        if (tiktokConnection) {
            tiktokConnection.on('member', async (data) => {
                const user = data.uniqueId || data.userId;
                if (user) {
                    activeViewers.add(user);
                    if (activeViewers.size > peakViewers) {
                        peakViewers = activeViewers.size;
                        saveState();
                    }
                    
                    let avatarPath = null;
                    if (data.profilePictureUrl) {
                        avatarPath = await downloadAvatar(data.profilePictureUrl, user);
                    }
                    
                    io.emit('viewer_join', { 
                        user: user, 
                        uniqueId: user, 
                        nickname: data.nickname || user,
                        isBot: false,
                        avatar: avatarPath || '',
                        avatarUrl: data.profilePictureUrl || ''
                    });
                    emitStatus();
                }
            });
            
            tiktokConnection.on('like', (data) => {
                const count = data.likeCount || data.totalLikeCount || 1;
                incrementLikes(count);
                io.emit('like', { count: count });
            });
            
            tiktokConnection.on('gift', async (data) => {
                const user = data.uniqueId || data.userId;
                const giftName = data.giftName || data.giftType;
                const avatar = data.profilePictureUrl || data.user?.profilePictureUrl || '';
                
                if (user && giftName) {
                    let avatarPath = null;
                    if (avatar) {
                        avatarPath = await downloadAvatar(avatar, user);
                    }
                    
                    let mappedGift = giftName;
                    if (giftName.toLowerCase().includes('rose')) mappedGift = 'rose';
                    else if (giftName.toLowerCase().includes('donut')) mappedGift = 'donut';
                    else if (giftName.toLowerCase().includes('donat')) mappedGift = 'donat';
                    else if (giftName.toLowerCase().includes('finger') || giftName.toLowerCase().includes('heart')) mappedGift = 'fingerheart';
                    
                    if (['rose', 'donut', 'donat', 'fingerheart'].includes(mappedGift)) {
                        updateGiftCount(mappedGift);
                    }
                    
                    io.emit('gift', { 
                        user: user, 
                        giftName: mappedGift,
                        originalName: giftName,
                        avatar: avatarPath || '',
                        avatarUrl: avatar,
                        count: data.giftCount || 1
                    });
                }
            });
            
            tiktokConnection.on('disconnected', () => {
                connected = false;
                saveState();
                emitStatus();
            });
            
            tiktokConnection.on('error', (err) => {
                console.log('⚠️ TikTok error:', err.message);
            });
        }
        
        emitStatus();
        res.json({ success: true, message: `Connected to ${username}` });
        
    } catch (e) {
        console.log(`❌ Connection failed: ${e.message}`);
        connected = false;
        tiktokConnection = null;
        saveState();
        res.json({ success: false, error: e.message });
    }
});

app.post('/admin/disconnect', (req, res) => {
    connected = false;
    if (tiktokConnection) {
        try { tiktokConnection.disconnect(); } catch (e) {}
        tiktokConnection = null;
    }
    saveState();
    emitStatus();
    res.json({ success: true });
});

app.post('/admin/viewer', async (req, res) => {
    const u = req.body.user || ('viewer_' + Date.now());
    activeViewers.add(u);
    
    if (activeViewers.size > peakViewers) {
        peakViewers = activeViewers.size;
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
    res.json({ success: true, user: u });
});

app.post('/admin/remove_bot', (req, res) => {
    const user = req.body.user;
    if (user && activeViewers.has(user)) {
        activeViewers.delete(user);
        saveState();
        io.emit('viewer_leave', { user: user, uniqueId: user });
        emitStatus();
        res.json({ success: true, message: `Removed ${user}` });
    } else {
        res.json({ success: false, message: 'User not found' });
    }
});

app.post('/admin/remove_bots', (req, res) => {
    const count = parseInt(req.body.count) || 10;
    const viewersArray = Array.from(activeViewers);
    const toRemove = viewersArray.slice(0, Math.min(count, viewersArray.length));
    
    let removed = 0;
    toRemove.forEach(user => {
        if (activeViewers.has(user)) {
            activeViewers.delete(user);
            io.emit('viewer_leave', { user: user, uniqueId: user });
            removed++;
        }
    });
    
    saveState();
    emitStatus();
    res.json({ success: true, removed: removed });
});

app.post('/admin/remove_all_bots', (req, res) => {
    const users = Array.from(activeViewers);
    activeViewers.clear();
    saveState();
    
    users.forEach(user => {
        io.emit('viewer_leave', { user: user, uniqueId: user });
    });
    
    emitStatus();
    res.json({ success: true, removed: users.length });
});

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

function getGiftUser(body) {
    if (body && body.user) return body.user;
    const first = Array.from(activeViewers)[0];
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
        viewers: activeViewers.size,
        target: getTarget(),
        peak: peakViewers,
        stats: appData.stats,
        highScore: appData.highScore24
    });
    
    activeViewers.forEach(user => {
        const cleanUser = user.startsWith('@') ? user.substring(1) : user;
        let avatarPath = null;
        if (AVATAR_CACHE.has(cleanUser)) {
            avatarPath = `/avatars/${cleanUser}.png`;
        }
        socket.emit('viewer_join', { 
            user: user, 
            uniqueId: user, 
            nickname: user,
            isBot: true,
            avatar: avatarPath || '',
            avatarUrl: ''
        });
    });
    
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============================================================
// AUTO-SAVE
// ============================================================
setInterval(saveState, 30000);

process.on('SIGINT', () => {
    saveState();
    process.exit(0);
});

process.on('SIGTERM', () => {
    saveState();
    process.exit(0);
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('================================================');
    console.log('🚀 SERVER RUNNING on port', PORT);
    console.log('📡 MODE =', mode);
    console.log('📁 Avatars saved to:', AVATAR_DIR);
    console.log('🧹 Auto-delete avatars after 24 hours');
    console.log('📥 Download queue: 1 concurrent');
    console.log('================================================');
});