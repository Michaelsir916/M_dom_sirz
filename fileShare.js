const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const FILES_PATH = path.join(__dirname, 'shared_files.json');
const USERS_PATH = path.join(__dirname, 'share_users.json');
const KNOWN_CHATS_PATH = path.join(__dirname, 'known_chats.json');
const BROADCAST_HISTORY_PATH = path.join(__dirname, 'broadcast_history.json');
const SCHEDULED_BROADCASTS_PATH = path.join(__dirname, 'scheduled_broadcasts.json');
const AUTOPOST_PATH = path.join(__dirname, 'autopost_configs.json');
const PENDING_JOIN_REQUESTS_PATH = path.join(__dirname, 'pending_join_requests.json');

const DEFAULT_CONFIG = {
    forceSubGroupIds: [],   // multiple groups supported
    forceSubSettings: {},   // groupId -> { mode: 'auto'|'pending', delayHours: number }
    sourceGroupId: null,
    shareCount: 1,
    autoDeleteMinutes: 0,   // 0 = disabled
    dailyLimit: 0,          // 0 = unlimited
    cooldownSeconds: 10,
    referralBonus: 3,       // bonus file-credits earned per successful referral
    errorLogChatId: null,   // channel/group id where bot errors are posted
    forceSubInviteLinks: {}, // groupId -> cached "request to join" invite link
    broadcastForwardMode: false, // false = copyMessage (no tag), true = forwardMessage (tag)
    broadcastBatchSize: 25,      // messages sent per second-ish batch (stay under Telegram's ~30/sec cap)
    protectContent: false,       // true = files sent to users can't be forwarded/saved
    maintenanceMode: false,      // true = bot only responds to admins + whitelisted users
    maintenanceWhitelist: [],    // user ids (strings) allowed through during maintenance
    megaUploadMode: 'personal',  // 'personal' = files go to whichever chat sent the link, 'channel' = always to megaUploadChannelId
    megaUploadChannelId: null    // destination channel for admin's MEGA links when megaUploadMode is 'channel'
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
        users[key] = {
            lastRequestAt: 0, dailyDate: '', dailyCount: 0, totalRequests: 0, seen: [],
            referrals: [], referredBy: null, bonusCredits: 0
        };
    }
    // Backfill fields for users created before the referral system existed
    if (users[key].referrals === undefined) users[key].referrals = [];
    if (users[key].referredBy === undefined) users[key].referredBy = null;
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

// Checks + records a /random request (cooldown + daily limit). Returns { allowed, reason, retryAfter }
function recordRequest(userId, cooldownSeconds, dailyLimit) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    if (u.blocked) u.blocked = false; // they're back — clear the stale block flag
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

// ===== Referral system =====

// True if this user has never interacted with the bot before (no entry yet).
// Must be checked BEFORE any call that implicitly creates the user record.
function isNewUser(userId) {
    const users = loadUsers();
    return !users[String(userId)];
}

// Links a new user to whoever referred them, and credits the referrer with
// bonus file-credits. Only awards once per new user (checked via referredBy).
function registerReferral(newUserId, referrerId) {
    const newKey = String(newUserId);
    const refKey = String(referrerId);

    if (newKey === refKey) return { success: false, reason: 'self' };

    const users = loadUsers();
    const newUser = getUser(users, newKey);

    if (newUser.referredBy) return { success: false, reason: 'already_referred' };

    const referrer = getUser(users, refKey);
    if (!referrer.referrals.includes(newKey)) referrer.referrals.push(newKey);

    const config = loadConfig();
    referrer.bonusCredits = (referrer.bonusCredits || 0) + config.referralBonus;
    newUser.referredBy = refKey;

    users[newKey] = newUser;
    users[refKey] = referrer;
    saveUsers(users);

    return { success: true, referrerId: refKey, bonus: config.referralBonus, referralCount: referrer.referrals.length };
}

// Spends one bonus credit (earned via referrals) to bypass the daily limit.
// Returns true if a credit was available and consumed.
function consumeBonusCredit(userId) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    if ((u.bonusCredits || 0) <= 0) return false;
    u.bonusCredits -= 1;
    users[key] = u;
    saveUsers(users);
    return true;
}

function getReferralStats(userId) {
    const users = loadUsers();
    const u = getUser(users, userId);
    return {
        referralCount: (u.referrals || []).length,
        bonusCredits: u.bonusCredits || 0,
        referredBy: u.referredBy || null
    };
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
        referralCount: (u.referrals || []).length,
        bonusCredits: u.bonusCredits || 0
    };
}

// includeBlocked=false (default) excludes users flagged blocked (they've
// blocked the bot, per a prior failed send) so broadcasts/stats skip them.
function getAllUserIds(includeBlocked = false) {
    const users = loadUsers();
    return Object.keys(users).filter(key => includeBlocked || !users[key].blocked);
}

// Flags a user as having blocked the bot (learned from a failed send).
// Kept as a flag rather than a delete so their stats/history aren't lost —
// if they unblock and use the bot again the flag is cleared automatically
// the next time recordRequest() touches their record.
function markUserBlocked(userId) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    u.blocked = true;
    users[key] = u;
    saveUsers(users);
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
// addedBy (optional): the user id of the admin who added the bot to this chat,
// captured from the my_chat_member update. Once set, it's never overwritten by
// later calls that don't pass it (so a plain message/channel_post sighting
// can't clobber the real "who added it" attribution).
function recordKnownChat(chatId, title, type, addedBy) {
    const chats = loadKnownChats();
    const key = String(chatId);
    const existing = chats[key];
    const resolvedAddedBy = addedBy !== undefined ? addedBy : (existing ? existing.addedBy : undefined);
    if (existing && existing.title === title && existing.type === type && existing.addedBy === resolvedAddedBy) return;
    chats[key] = {
        id: chatId,
        title: title || 'Untitled',
        type,
        addedBy: resolvedAddedBy,
        last_seen: new Date().toISOString()
    };
    saveKnownChats(chats);
}

// adminId (optional): if provided, only returns chats added by that admin,
// PLUS legacy chats with no recorded addedBy (grandfathered in so nothing
// already configured silently disappears — they'll get properly attributed
// the next time the bot sees a my_chat_member update for them).
function getKnownChats(adminId) {
    const all = Object.values(loadKnownChats());
    const filtered = adminId === undefined
        ? all
        : all.filter(c => c.addedBy === undefined || c.addedBy === null || String(c.addedBy) === String(adminId));
    return filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

function removeKnownChat(chatId) {
    const chats = loadKnownChats();
    const key = String(chatId);
    if (chats[key]) {
        delete chats[key];
        saveKnownChats(chats);
    }
}

// ===== Broadcast history =====
function loadBroadcastHistory() {
    return safeReadJson(BROADCAST_HISTORY_PATH, []);
}

function saveBroadcastHistory(list) {
    atomicWrite(BROADCAST_HISTORY_PATH, list);
}

// Records a completed broadcast. Keeps only the most recent 200 entries.
function addBroadcastHistory(entry) {
    const list = loadBroadcastHistory();
    list.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at: new Date().toISOString(),
        ...entry
    });
    saveBroadcastHistory(list.slice(0, 200));
}

function getBroadcastHistory(limit = 10) {
    return loadBroadcastHistory().slice(0, limit);
}

// ===== Scheduled broadcasts =====
function loadScheduledBroadcasts() {
    return safeReadJson(SCHEDULED_BROADCASTS_PATH, []);
}

function saveScheduledBroadcasts(list) {
    atomicWrite(SCHEDULED_BROADCASTS_PATH, list);
}

// entry: { sendAt (ISO string), kind: 'text'|'photo'|'video'|'animation',
//          text, fileId, caption, forwardMode, createdBy }
function addScheduledBroadcast(entry) {
    const list = loadScheduledBroadcasts();
    const record = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sent: false, ...entry };
    list.push(record);
    saveScheduledBroadcasts(list);
    return record;
}

function removeScheduledBroadcast(id) {
    const list = loadScheduledBroadcasts();
    const filtered = list.filter(s => s.id !== id);
    if (filtered.length !== list.length) saveScheduledBroadcasts(filtered);
    return filtered.length !== list.length;
}

function markScheduledBroadcastSent(id) {
    const list = loadScheduledBroadcasts();
    const rec = list.find(s => s.id === id);
    if (rec) {
        rec.sent = true;
        saveScheduledBroadcasts(list);
    }
}

// Due = not sent yet and sendAt has passed
function getDueScheduledBroadcasts() {
    const now = Date.now();
    return loadScheduledBroadcasts().filter(s => !s.sent && new Date(s.sendAt).getTime() <= now);
}

function getPendingScheduledBroadcasts() {
    return loadScheduledBroadcasts().filter(s => !s.sent);
}

// ===== Auto-post system (per-admin, isolated channels) =====
// Keyed by admin user id. Each admin configures their own destination
// channel, interval, caption, thumbnail source and blur — fully isolated
// from every other admin's configuration.
function loadAutopostConfigs() {
    return safeReadJson(AUTOPOST_PATH, {});
}

function saveAutopostConfigs(configs) {
    atomicWrite(AUTOPOST_PATH, configs);
}

const DEFAULT_AUTOPOST = {
    channelId: null,
    intervalMinutes: 0,    // 0 = disabled; stored in minutes so hours+minutes are both supported
    caption: 'New Post 🎬',
    thumbnailMode: 'video', // 'video' = use the video's own thumbnail, 'custom' = admin-uploaded
    customThumbnailFileId: null,
    blurEnabled: false,
    enabled: false,
    postedTags: [],         // "chatId:messageId" tags already posted, never repeats
    lastPostAt: 0
};

// Old configs stored `intervalHours` (whole hours only). Migrate them to
// `intervalMinutes` on read so existing setups keep working unchanged.
function normalizeAutopostConfig(raw) {
    const cfg = { ...DEFAULT_AUTOPOST, ...raw };
    if (!cfg.intervalMinutes && raw && raw.intervalHours) {
        cfg.intervalMinutes = raw.intervalHours * 60;
    }
    delete cfg.intervalHours;
    return cfg;
}

function getAutopostConfig(adminId) {
    const configs = loadAutopostConfigs();
    const key = String(adminId);
    return normalizeAutopostConfig(configs[key] || {});
}

function setAutopostConfig(adminId, patch) {
    const configs = loadAutopostConfigs();
    const key = String(adminId);
    configs[key] = normalizeAutopostConfig({ ...(configs[key] || {}), ...patch });
    saveAutopostConfigs(configs);
    return configs[key];
}

function getAllAutopostConfigs() {
    const configs = loadAutopostConfigs();
    return Object.keys(configs).map(adminId => ({ adminId, ...normalizeAutopostConfig(configs[adminId]) }));
}

function markAutopostTagPosted(adminId, tag) {
    const configs = loadAutopostConfigs();
    const key = String(adminId);
    const cfg = { ...DEFAULT_AUTOPOST, ...(configs[key] || {}) };
    if (!cfg.postedTags.includes(tag)) cfg.postedTags.push(tag);
    cfg.lastPostAt = Date.now();
    configs[key] = cfg;
    saveAutopostConfigs(configs);
}

// ===== Force-Sub per-group mode (auto-approve vs pending+delay) =====
const DEFAULT_FORCESUB_SETTINGS = { mode: 'auto', delayHours: 24 };

function getForceSubSettings(groupId) {
    const config = loadConfig();
    const key = String(groupId);
    return { ...DEFAULT_FORCESUB_SETTINGS, ...(config.forceSubSettings[key] || {}) };
}

function setForceSubSettings(groupId, patch) {
    const config = loadConfig();
    const key = String(groupId);
    config.forceSubSettings[key] = { ...DEFAULT_FORCESUB_SETTINGS, ...(config.forceSubSettings[key] || {}), ...patch };
    saveConfig(config);
    return config.forceSubSettings[key];
}

// ===== Pending join requests (for "pending" mode force-sub groups) =====
// A user who has sent a join request to a "pending" group is treated as
// force-sub-verified immediately (they get files right away), even though
// the request itself is only actually approved into the group later —
// either automatically after delayHours, or never if delayHours is 0.
function loadPendingJoinRequests() {
    return safeReadJson(PENDING_JOIN_REQUESTS_PATH, []);
}

function savePendingJoinRequests(list) {
    atomicWrite(PENDING_JOIN_REQUESTS_PATH, list);
}

// Records that a join request arrived. Idempotent — re-requesting doesn't
// reset the original requestedAt (so a delay countdown can't be stalled).
function recordJoinRequest(chatId, userId) {
    const list = loadPendingJoinRequests();
    const exists = list.find(r => String(r.chatId) === String(chatId) && String(r.userId) === String(userId));
    if (exists) return exists;
    const record = { chatId, userId, requestedAt: Date.now(), approved: false };
    list.push(record);
    savePendingJoinRequests(list);
    return record;
}

function hasJoinRequest(chatId, userId) {
    return loadPendingJoinRequests().some(r => String(r.chatId) === String(chatId) && String(r.userId) === String(userId));
}

function markJoinRequestApproved(chatId, userId) {
    const list = loadPendingJoinRequests();
    const rec = list.find(r => String(r.chatId) === String(chatId) && String(r.userId) === String(userId));
    if (rec) {
        rec.approved = true;
        savePendingJoinRequests(list);
    }
}

// Due = not yet approved, and the group's configured delay has elapsed.
// Groups with delayHours=0 never show up here (manual-only approval).
function getDueJoinRequestsForApproval() {
    const now = Date.now();
    return loadPendingJoinRequests().filter(r => {
        if (r.approved) return false;
        const settings = getForceSubSettings(r.chatId);
        if (settings.mode !== 'pending' || !settings.delayHours) return false;
        return now - r.requestedAt >= settings.delayHours * 3600 * 1000;
    });
}

// ===== Admin check =====
function isAdmin(userId) {
    const adminIds = (process.env.ADMIN_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    return adminIds.includes(String(userId));
}

// ===== Maintenance mode =====
// During maintenance, only admins and whitelisted users get normal bot
// behavior — everyone else sees a plain "under maintenance" notice.
function isMaintenanceAllowed(userId) {
    if (isAdmin(userId)) return true;
    const config = loadConfig();
    return (config.maintenanceWhitelist || []).includes(String(userId));
}

function addMaintenanceWhitelist(userId) {
    const config = loadConfig();
    const key = String(userId);
    if (!config.maintenanceWhitelist.includes(key)) {
        config.maintenanceWhitelist.push(key);
        saveConfig(config);
    }
    return config.maintenanceWhitelist;
}

function removeMaintenanceWhitelist(userId) {
    const config = loadConfig();
    const key = String(userId);
    config.maintenanceWhitelist = config.maintenanceWhitelist.filter(id => id !== key);
    saveConfig(config);
    return config.maintenanceWhitelist;
}

function getMaintenanceWhitelist() {
    return loadConfig().maintenanceWhitelist || [];
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
    getUserStats,
    isNewUser,
    registerReferral,
    consumeBonusCredit,
    getReferralStats,
    isAdmin,
    recordKnownChat,
    getKnownChats,
    removeKnownChat,
    markUserBlocked,
    addBroadcastHistory,
    getBroadcastHistory,
    addScheduledBroadcast,
    removeScheduledBroadcast,
    markScheduledBroadcastSent,
    getDueScheduledBroadcasts,
    getPendingScheduledBroadcasts,
    getAutopostConfig,
    setAutopostConfig,
    getAllAutopostConfigs,
    markAutopostTagPosted,
    getForceSubSettings,
    setForceSubSettings,
    recordJoinRequest,
    hasJoinRequest,
    markJoinRequestApproved,
    getDueJoinRequestsForApproval,
    isMaintenanceAllowed,
    addMaintenanceWhitelist,
    removeMaintenanceWhitelist,
    getMaintenanceWhitelist
};
