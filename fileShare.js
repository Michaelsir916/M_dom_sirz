const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const FILES_PATH = path.join(__dirname, 'shared_files.json');
const USERS_PATH = path.join(__dirname, 'share_users.json');
const KNOWN_CHATS_PATH = path.join(__dirname, 'known_chats.json');

const DEFAULT_CONFIG = {
    forceSubGroupIds: [],   // multiple groups supported
    sourceGroupId: null,
    shareCount: 1,
    autoDeleteMinutes: 0,   // 0 = disabled
    dailyLimit: 0,          // 0 = unlimited
    cooldownSeconds: 10
};

function atomicWrite(filePath, data) {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
}

function safeReadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error(`Error reading ${filePath}:`, e.message);
        return fallback;
    }
}

// ===== Config =====
function loadConfig() {
    const raw = safeReadJson(CONFIG_PATH, {});
    return { ...DEFAULT_CONFIG, ...raw };
}

function saveConfig(config) {
    atomicWrite(CONFIG_PATH, config);
}

// ===== Shared Files (tracked by chat_id + message_id, not file_id) =====
function loadSharedFiles() {
    return safeReadJson(FILES_PATH, []);
}

function saveSharedFiles(files) {
    atomicWrite(FILES_PATH, files);
}

// Adds a file reference. Dedupes on (chat_id, message_id).
function addSharedFile(chatId, messageId, type) {
    const files = loadSharedFiles();
    if (files.some(f => f.chat_id === chatId && f.message_id === messageId)) return false;
    files.push({
        chat_id: chatId,
        message_id: messageId,
        type,
        added_at: new Date().toISOString()
    });
    saveSharedFiles(files);
    return true;
}

// Removes a file entry (used for self-healing when the source message is gone)
function removeSharedFile(chatId, messageId) {
    const files = loadSharedFiles();
    const filtered = files.filter(f => !(f.chat_id === chatId && f.message_id === messageId));
    if (filtered.length !== files.length) saveSharedFiles(filtered);
}

function deleteFileByIndex(index) {
    const files = loadSharedFiles();
    if (index < 0 || index >= files.length) return null;
    const [removed] = files.splice(index, 1);
    saveSharedFiles(files);
    return removed;
}

// ===== Per-user tracking: cooldown, daily limit, "seen" history (no repeats) =====
function loadUsers() {
    return safeReadJson(USERS_PATH, {});
}

function saveUsers(users) {
    atomicWrite(USERS_PATH, users);
}

function getUser(users, userId) {
    const key = String(userId);
    if (!users[key]) {
        users[key] = { lastRequestAt: 0, dailyDate: '', dailyCount: 0, totalRequests: 0, seen: [] };
    }
    return users[key];
}

// Files this user has NOT received yet
function getUnseenFiles(userId) {
    const users = loadUsers();
    const u = getUser(users, userId);
    const seenSet = new Set(u.seen);
    return loadSharedFiles().filter(f => !seenSet.has(`${f.chat_id}:${f.message_id}`));
}

// Marks the given files as seen for this user
function markSeen(userId, files) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    for (const f of files) {
        const tag = `${f.chat_id}:${f.message_id}`;
        if (!u.seen.includes(tag)) u.seen.push(tag);
    }
    users[key] = u;
    saveUsers(users);
}

// Checks + records a /random request (cooldown + daily limit). Returns { allowed, reason, retryAfter }
function recordRequest(userId, cooldownSeconds, dailyLimit) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    if (cooldownSeconds > 0 && u.lastRequestAt) {
        const elapsedSec = (now - u.lastRequestAt) / 1000;
        if (elapsedSec < cooldownSeconds) {
            return { allowed: false, reason: 'cooldown', retryAfter: Math.ceil(cooldownSeconds - elapsedSec) };
        }
    }

    if (u.dailyDate !== today) {
        u.dailyDate = today;
        u.dailyCount = 0;
    }

    if (dailyLimit > 0 && u.dailyCount >= dailyLimit) {
        return { allowed: false, reason: 'daily_limit' };
    }

    u.dailyCount += 1;
    u.totalRequests = (u.totalRequests || 0) + 1;
    u.lastRequestAt = now;
    users[key] = u;
    saveUsers(users);
    return { allowed: true };
}

function getAllUserIds() {
    return Object.keys(loadUsers());
}

function getStats() {
    const files = loadSharedFiles();
    const users = loadUsers();
    const today = new Date().toISOString().slice(0, 10);
    let requestsToday = 0;
    for (const u of Object.values(users)) {
        if (u.dailyDate === today) requestsToday += u.dailyCount;
    }
    return {
        totalFiles: files.length,
        totalUsers: Object.keys(users).length,
        requestsToday
    };
}

// ===== Known Chats (groups/channels the bot has seen) =====
// Populated automatically whenever the bot receives an update from a
// group/supergroup/channel. Used to build "tap to pick" buttons instead of
// making the admin type IDs or run commands inside the target chat.
function loadKnownChats() {
    return safeReadJson(KNOWN_CHATS_PATH, {});
}

function saveKnownChats(chats) {
    atomicWrite(KNOWN_CHATS_PATH, chats);
}

// Records/updates a chat's id, title and type. Cheap no-op write skip if unchanged.
function recordKnownChat(chatId, title, type) {
    const chats = loadKnownChats();
    const key = String(chatId);
    const existing = chats[key];
    if (existing && existing.title === title && existing.type === type) return;
    chats[key] = { id: chatId, title: title || 'Untitled', type, last_seen: new Date().toISOString() };
    saveKnownChats(chats);
}

function getKnownChats() {
    return Object.values(loadKnownChats()).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

function removeKnownChat(chatId) {
    const chats = loadKnownChats();
    const key = String(chatId);
    if (chats[key]) {
        delete chats[key];
        saveKnownChats(chats);
    }
}

// ===== Admin check =====
function isAdmin(userId) {
    const adminIds = (process.env.ADMIN_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    return adminIds.includes(String(userId));
}

module.exports = {
    loadConfig,
    saveConfig,
    loadSharedFiles,
    addSharedFile,
    removeSharedFile,
    deleteFileByIndex,
    getUnseenFiles,
    markSeen,
    recordRequest,
    getAllUserIds,
    getStats,
    isAdmin,
    recordKnownChat,
    getKnownChats,
    removeKnownChat
};
