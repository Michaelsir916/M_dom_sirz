const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const FILES_PATH = path.join(__dirname, 'shared_files.json');
const USERS_PATH = path.join(__dirname, 'share_users.json');
const KNOWN_CHATS_PATH = path.join(__dirname, 'known_chats.json');
const PROMO_PATH = path.join(__dirname, 'promo_codes.json');
const ERRORLOG_PATH = path.join(__dirname, 'error_log.json');
const PEAKHOURS_PATH = path.join(__dirname, 'peak_hours.json');

const DEFAULT_CONFIG = {
    forceSubGroupIds: [],   // multiple groups supported
    sourceGroupId: null,
    shareCount: 1,
    autoDeleteMinutes: 0,   // 0 = disabled
    dailyLimit: 0,          // 0 = unlimited
    cooldownSeconds: 10,
    adminLogChatId: null,        // where dead-link checks / digests are posted; falls back to first ADMIN_ID
    errorAlertThreshold: 5,      // errors within the window below before an alert fires
    errorAlertWindowMinutes: 5,
    deadLinkCheckHours: 6,       // how often the dead-link cleaner scans the pool
    weeklyDigestEnabled: true
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

// Adds a file reference. Dedupes on (chat_id, message_id). If the entry
// already exists and a sourceLink is now known but wasn't recorded yet
// (e.g. the generic listener beat the direct call to it), it gets filled in.
function addSharedFile(chatId, messageId, type, sourceLink = null) {
    const files = loadSharedFiles();
    const existing = files.find(f => f.chat_id === chatId && f.message_id === messageId);
    if (existing) {
        if (sourceLink && !existing.source_link) {
            existing.source_link = sourceLink;
            saveSharedFiles(files);
        }
        return false;
    }
    files.push({
        chat_id: chatId,
        message_id: messageId,
        type,
        source_link: sourceLink || null,
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

// Finds every pool entry that came from a given MEGA link (admin re-sends the
// same source link to remove it instead of hunting for the index).
function findFilesBySourceLink(link) {
    return loadSharedFiles().filter(f => f.source_link === link);
}

// Removes every pool entry that came from a given MEGA link. Returns the
// removed entries.
function removeFilesBySourceLink(link) {
    const files = loadSharedFiles();
    const removed = files.filter(f => f.source_link === link);
    if (removed.length === 0) return removed;
    const remaining = files.filter(f => f.source_link !== link);
    saveSharedFiles(remaining);
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
        users[key] = { lastRequestAt: 0, dailyDate: '', dailyCount: 0, totalRequests: 0, seen: [], bonusCredits: 0 };
    }
    if (users[key].bonusCredits === undefined) users[key].bonusCredits = 0;
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

// Checks + records a /random request (cooldown + daily limit). Returns { allowed, reason, retryAfter, usedBonusCredit }
// If the daily limit is hit but the user has redeemed promo-code bonus
// credits, one credit is spent instead of blocking the request.
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

    let usedBonusCredit = false;
    if (dailyLimit > 0 && u.dailyCount >= dailyLimit) {
        if ((u.bonusCredits || 0) > 0) {
            u.bonusCredits -= 1;
            usedBonusCredit = true;
        } else {
            return { allowed: false, reason: 'daily_limit' };
        }
    }

    if (!usedBonusCredit) u.dailyCount += 1;
    u.totalRequests = (u.totalRequests || 0) + 1;
    u.lastRequestAt = now;
    users[key] = u;
    saveUsers(users);
    recordHourlyRequest();
    return { allowed: true, usedBonusCredit };
}

// Returns THIS user's own /random stats (not admin-wide): files received,
// cooldown remaining, daily-limit remaining. Read-only, does not persist.
function getUserStats(userId, cooldownSeconds, dailyLimit) {
    const users = loadUsers();
    const u = getUser(users, userId);
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    let cooldownRemaining = 0;
    if (cooldownSeconds > 0 && u.lastRequestAt) {
        const elapsedSec = (now - u.lastRequestAt) / 1000;
        if (elapsedSec < cooldownSeconds) {
            cooldownRemaining = Math.ceil(cooldownSeconds - elapsedSec);
        }
    }

    const requestsToday = (u.dailyDate === today) ? u.dailyCount : 0;
    const dailyRemaining = dailyLimit > 0 ? Math.max(0, dailyLimit - requestsToday) : null; // null = unlimited

    return {
        totalFilesReceived: (u.seen || []).length,
        totalRequests: u.totalRequests || 0,
        requestsToday,
        cooldownRemaining,
        dailyRemaining,
        bonusCredits: u.bonusCredits || 0
    };
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

// ===== Promo codes (bonus credits) =====
// A code grants N bonus /random requests to whoever redeems it, usable once
// the user's daily limit is hit. maxUses = 0 means unlimited redemptions.
function loadPromoCodes() {
    return safeReadJson(PROMO_PATH, {});
}

function savePromoCodes(codes) {
    atomicWrite(PROMO_PATH, codes);
}

function createPromoCode(code, credits, maxUses = 0) {
    const codes = loadPromoCodes();
    const key = String(code).trim().toUpperCase();
    if (!key) return null;
    codes[key] = {
        code: key,
        credits,
        maxUses,
        usedBy: [], // [{ userId, at }]
        createdAt: new Date().toISOString()
    };
    savePromoCodes(codes);
    return codes[key];
}

function deletePromoCode(code) {
    const codes = loadPromoCodes();
    const key = String(code).trim().toUpperCase();
    if (!codes[key]) return false;
    delete codes[key];
    savePromoCodes(codes);
    return true;
}

function listPromoCodes() {
    return Object.values(loadPromoCodes()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// Returns { success, reason } or { success: true, credits }
function redeemPromoCode(code, userId) {
    const codes = loadPromoCodes();
    const key = String(code).trim().toUpperCase();
    const entry = codes[key];
    if (!entry) return { success: false, reason: 'not_found' };

    const uid = String(userId);
    if (entry.usedBy.some(e => e.userId === uid)) {
        return { success: false, reason: 'already_used' };
    }
    if (entry.maxUses > 0 && entry.usedBy.length >= entry.maxUses) {
        return { success: false, reason: 'exhausted' };
    }

    entry.usedBy.push({ userId: uid, at: Date.now() });
    savePromoCodes(codes);

    const users = loadUsers();
    const u = getUser(users, uid);
    u.bonusCredits = (u.bonusCredits || 0) + entry.credits;
    users[uid] = u;
    saveUsers(users);

    return { success: true, credits: entry.credits };
}

// Count of promo redemptions since a given timestamp (used by the weekly digest)
function getPromoRedemptionsSince(sinceTs) {
    const codes = loadPromoCodes();
    let count = 0;
    for (const entry of Object.values(codes)) {
        count += entry.usedBy.filter(e => e.at >= sinceTs).length;
    }
    return count;
}

// ===== Peak-hour insight =====
// One counter bucket per hour-of-day (0-23), incremented on every allowed
// /random request. Helps decide good broadcast timing.
function getPeakHours() {
    const hours = safeReadJson(PEAKHOURS_PATH, null);
    if (!Array.isArray(hours) || hours.length !== 24) return new Array(24).fill(0);
    return hours;
}

function recordHourlyRequest() {
    const hours = getPeakHours();
    const h = new Date().getHours();
    hours[h] = (hours[h] || 0) + 1;
    atomicWrite(PEAKHOURS_PATH, hours);
}

// ===== Error log (used for the grouped error-rate alert + weekly digest) =====
function recordError(message) {
    const log = safeReadJson(ERRORLOG_PATH, []);
    log.push({ at: Date.now(), message: String(message).slice(0, 300) });
    const trimmed = log.slice(-500); // keep it bounded
    atomicWrite(ERRORLOG_PATH, trimmed);
    return trimmed;
}

function getRecentErrors(windowMs) {
    const log = safeReadJson(ERRORLOG_PATH, []);
    const cutoff = Date.now() - windowMs;
    return log.filter(e => e.at >= cutoff);
}

function getErrorCountSince(sinceTs) {
    const log = safeReadJson(ERRORLOG_PATH, []);
    return log.filter(e => e.at >= sinceTs).length;
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
    findFilesBySourceLink,
    removeFilesBySourceLink,
    getUnseenFiles,
    markSeen,
    recordRequest,
    getAllUserIds,
    getStats,
    getUserStats,
    isAdmin,
    recordKnownChat,
    getKnownChats,
    removeKnownChat,
    createPromoCode,
    deletePromoCode,
    listPromoCodes,
    redeemPromoCode,
    getPromoRedemptionsSince,
    getPeakHours,
    recordError,
    getRecentErrors,
    getErrorCountSince
};
