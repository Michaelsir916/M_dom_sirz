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
const VIP_CLICKS_PATH = path.join(__dirname, 'vip_clicks.json');
const PROMO_CODES_PATH = path.join(__dirname, 'promo_codes.json');
const PENDING_DELETIONS_PATH = path.join(__dirname, 'pending_deletions.json');
const CATEGORIES_PATH = path.join(__dirname, 'categories.json');
const FOLDER_JOBS_PATH = path.join(__dirname, 'mega_folder_jobs.json');
const FOLDER_UPLOAD_HISTORY_PATH = path.join(__dirname, 'mega_folder_upload_history.json');

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
    megaUploadChannelId: null,   // destination channel for admin's MEGA links when megaUploadMode is 'channel'
    aboutJoinGroupLink: null,    // url shown on the "👥 Join Group" button in the non-admin About panel
    aboutLinkText: 'Click Here', // custom clickable hyperlink text shown in the non-admin About panel
    aboutLinkUrl: null,          // url that aboutLinkText links to
    vipChannelLink: null,        // url the "💎 Buy VIP" button sends users to
    vipPromoText: null,          // optional promo copy shown above the Join button
    categoryStorageChannelId: null, // dedicated channel VIP category videos are archived to (see fileShare.js VIP Categories section)
    megaAccounts: [] // [{ id, email, password, label, disabledUntil }] — pool used by the Folder Upload feature for account rotation
};

// ===== Config backup (used by /backupconfig) =====
// Every JSON data file the bot persists, so a single zip captures everything
// needed to restore state after a "config reset" (corrupted file, bad
// Termux kill mid-write, accidental delete, etc).
const CONFIG_BACKUP_FILES = [
    { path: CONFIG_PATH, name: 'config.json' },
    { path: FILES_PATH, name: 'shared_files.json' },
    { path: USERS_PATH, name: 'share_users.json' },
    { path: KNOWN_CHATS_PATH, name: 'known_chats.json' },
    { path: BROADCAST_HISTORY_PATH, name: 'broadcast_history.json' },
    { path: SCHEDULED_BROADCASTS_PATH, name: 'scheduled_broadcasts.json' },
    { path: AUTOPOST_PATH, name: 'autopost_configs.json' },
    { path: PENDING_JOIN_REQUESTS_PATH, name: 'pending_join_requests.json' },
    { path: VIP_CLICKS_PATH, name: 'vip_clicks.json' },
    { path: PROMO_CODES_PATH, name: 'promo_codes.json' },
    { path: PENDING_DELETIONS_PATH, name: 'pending_deletions.json' },
    { path: CATEGORIES_PATH, name: 'categories.json' },
    { path: FOLDER_JOBS_PATH, name: 'mega_folder_jobs.json' },
    { path: FOLDER_UPLOAD_HISTORY_PATH, name: 'mega_folder_upload_history.json' }
];

// Only returns files that actually exist yet (a fresh install may not have
// created shared_files.json, autopost_configs.json, etc.).
function getConfigBackupFiles() {
    return CONFIG_BACKUP_FILES.filter(f => fs.existsSync(f.path));
}

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

// Adds a file reference. Dedupes on (chat_id, message_id), and — when a
// fileUniqueId is supplied — also on the underlying file itself, so the
// exact same video re-forwarded/re-posted under a different message_id
// (e.g. someone reposts the same clip into the source channel again)
// doesn't get queued and auto-posted twice.
function addSharedFile(chatId, messageId, type, fileUniqueId) {
    const files = loadSharedFiles();
    if (files.some(f => f.chat_id === chatId && f.message_id === messageId)) return false;
    if (fileUniqueId && files.some(f => f.file_unique_id === fileUniqueId)) return false;
    files.push({
        chat_id: chatId,
        message_id: messageId,
        type,
        file_unique_id: fileUniqueId || null,
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
            referrals: [], referredBy: null, bonusCredits: 0, joinedAt: new Date().toISOString()
        };
    }
    // Backfill fields for users created before the referral system existed
    if (users[key].referrals === undefined) users[key].referrals = [];
    if (users[key].referredBy === undefined) users[key].referredBy = null;
    if (users[key].bonusCredits === undefined) users[key].bonusCredits = 0;
    // vipExpiresAt: null = not VIP, -1 = unlimited (never expires), number = ms epoch expiry
    if (users[key].vipExpiresAt === undefined) users[key].vipExpiresAt = null;
    if (users[key].vipSource === undefined) users[key].vipSource = null; // 'promo' | 'manual'
    if (users[key].vipCode === undefined) users[key].vipCode = null;
    // Not backfilled with a fake date — left undefined so "new this week"
    // calculations only count users who actually joined after this field
    // was introduced, instead of falsely counting old users as brand new.
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

// ===== Pending message deletions (restart-safe auto-delete) =====
// Auto-delete used to rely purely on an in-memory setTimeout, which is lost
// on any pm2 restart/crash/redeploy that happens before the timer fires —
// the message then never gets deleted. Every scheduled deletion is now also
// persisted here; a periodic sweep (see getDuePendingDeletions, called from
// bot.js on a tick + once at startup) can finish the job even if the
// in-memory timer never got the chance to run.
function loadPendingDeletions() {
    return safeReadJson(PENDING_DELETIONS_PATH, []);
}

function savePendingDeletions(list) {
    atomicWrite(PENDING_DELETIONS_PATH, list);
}

// Records a message for deletion at deleteAt (ms epoch timestamp).
function schedulePendingDeletion(chatId, messageId, deleteAt) {
    const list = loadPendingDeletions();
    list.push({ chat_id: chatId, message_id: messageId, delete_at: deleteAt });
    savePendingDeletions(list);
}

// Entries whose delete_at has already passed — due for deletion right now.
function getDuePendingDeletions() {
    const now = Date.now();
    return loadPendingDeletions().filter(e => e.delete_at <= now);
}

// Removes one entry (after it's been deleted, or to give up on it).
function removePendingDeletion(chatId, messageId) {
    const list = loadPendingDeletions();
    const filtered = list.filter(e => !(e.chat_id === chatId && e.message_id === messageId));
    if (filtered.length !== list.length) savePendingDeletions(filtered);
}

// Checks + records a /random request (cooldown + daily limit). Returns { allowed, reason, retryAfter }
function recordRequest(userId, cooldownSeconds, dailyLimit) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    let dirty = false;
    if (u.blocked) { u.blocked = false; dirty = true; } // they're back — clear the stale block flag
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    if (cooldownSeconds > 0 && u.lastRequestAt) {
        const elapsedSec = (now - u.lastRequestAt) / 1000;
        if (elapsedSec < cooldownSeconds) {
            if (dirty) { users[key] = u; saveUsers(users); } // still persist the unblock even though this request is denied
            return { allowed: false, reason: 'cooldown', retryAfter: Math.ceil(cooldownSeconds - elapsedSec) };
        }
    }

    if (u.dailyDate !== today) {
        u.dailyDate = today;
        u.dailyCount = 0;
        dirty = true;
    }

    if (dailyLimit > 0 && u.dailyCount >= dailyLimit) {
        if (dirty) { users[key] = u; saveUsers(users); }
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

// ===== VIP status (granted via promo code redemption or manually by admin) =====

// Grants VIP to a user. days > 0 = expires in that many days from now.
// days <= 0 = unlimited (never expires). source/code are just for display
// in /myvip and the admin panel.
function grantVip(userId, days, source, code) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    u.vipExpiresAt = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : -1;
    u.vipSource = source || 'manual';
    u.vipCode = code || null;
    users[key] = u;
    saveUsers(users);
    return u.vipExpiresAt;
}

// Same as grantVip but takes a raw millisecond duration instead of whole
// days — needed since promo codes can now grant minutes/hours, not just
// day-granularity VIP. durationMs <= 0 = unlimited (never expires).
function grantVipMs(userId, durationMs, source, code) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    u.vipExpiresAt = durationMs > 0 ? Date.now() + durationMs : -1;
    u.vipSource = source || 'manual';
    u.vipCode = code || null;
    users[key] = u;
    saveUsers(users);
    return u.vipExpiresAt;
}

function revokeVip(userId) {
    const users = loadUsers();
    const key = String(userId);
    const u = getUser(users, key);
    u.vipExpiresAt = null;
    u.vipSource = null;
    u.vipCode = null;
    users[key] = u;
    saveUsers(users);
}

// True if the user currently has active (non-expired) VIP. Lazily treats a
// past expiry as "not VIP" without needing a scheduled job to clean it up.
function isUserVip(userId) {
    const users = loadUsers();
    const u = getUser(users, userId);
    if (u.vipExpiresAt === -1) return true;
    if (!u.vipExpiresAt) return false;
    return u.vipExpiresAt > Date.now();
}

// Full VIP status for display (My Stats, admin lookups).
function getVipInfo(userId) {
    const users = loadUsers();
    const u = getUser(users, userId);
    if (u.vipExpiresAt === -1) {
        return { active: true, unlimited: true, expiresAt: null, daysLeft: null, source: u.vipSource, code: u.vipCode };
    }
    if (!u.vipExpiresAt || u.vipExpiresAt <= Date.now()) {
        return { active: false, unlimited: false, expiresAt: null, daysLeft: null, source: null, code: null };
    }
    const daysLeft = Math.ceil((u.vipExpiresAt - Date.now()) / (24 * 60 * 60 * 1000));
    return { active: true, unlimited: false, expiresAt: u.vipExpiresAt, daysLeft, source: u.vipSource, code: u.vipCode };
}

// ===== Promo codes (admin-created, redeemed by users for VIP access) =====
function loadPromoCodes() {
    const raw = safeReadJson(PROMO_CODES_PATH, {});
    for (const key of Object.keys(raw)) normalizePromoCode(raw[key]);
    return raw;
}

// Migrates a code entry read from disk to the current shape in place.
// Old codes only have an integer `days` field — convert that to durationMs
// once, here, so every other function only ever has to deal with durationMs.
function normalizePromoCode(entry) {
    if (entry.durationMs === undefined) {
        entry.durationMs = entry.days > 0 ? entry.days * 24 * 60 * 60 * 1000 : 0;
    }
    if (entry.redeemByMs === undefined) entry.redeemByMs = null;
    if (entry.campaign === undefined) entry.campaign = null;
    if (entry.batchId === undefined) entry.batchId = null;
    return entry;
}

function savePromoCodes(codes) {
    atomicWrite(PROMO_CODES_PATH, codes);
}

// Unambiguous character set — no 0/O or 1/I, so a code read aloud or typed
// from a screenshot doesn't get mistyped.
const PROMO_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCodeToken(prefix) {
    let token = '';
    for (let i = 0; i < 6; i++) token += PROMO_CODE_CHARS[Math.floor(Math.random() * PROMO_CODE_CHARS.length)];
    const cleanPrefix = prefix ? String(prefix).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') : '';
    return cleanPrefix ? `${cleanPrefix}-${token}` : token;
}

// durationMs: 0 = unlimited/lifetime VIP when redeemed. maxUses: 0 = unlimited
// redemptions. Pass `code: null` to auto-generate one instead of a
// caller-chosen string (optionally under `prefix`, e.g. "GIVEAWAY-X7K9P2").
// redeemByMs: optional deadline after which the code itself can no longer be
// redeemed at all, separate from how long the VIP it grants lasts.
function createPromoCode({ code = null, durationMs = 0, maxUses = 0, createdBy, redeemByMs = null, campaign = null, batchId = null, prefix = null }) {
    const codes = loadPromoCodes();
    let key;
    if (code) {
        // Strip anything that isn't alnum/underscore/dash — also guarantees
        // the code can never contain a backtick, which would otherwise break
        // out of the `` `code` `` span used to display it in the admin panel.
        key = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
        if (!key) return { success: false, reason: 'empty' };
        if (codes[key]) return { success: false, reason: 'exists' };
    } else {
        let attempts = 0;
        do {
            key = generateCodeToken(prefix);
            attempts++;
        } while (codes[key] && attempts < 25);
        if (codes[key]) return { success: false, reason: 'generation_failed' };
    }

    codes[key] = {
        code: key,
        durationMs: durationMs > 0 ? durationMs : 0,
        maxUses: maxUses > 0 ? maxUses : 0,
        usedBy: [],
        createdBy: String(createdBy),
        createdAt: new Date().toISOString(),
        redeemByMs: redeemByMs || null,
        campaign: campaign || null,
        batchId: batchId || null
    };
    savePromoCodes(codes);
    return { success: true, code: codes[key] };
}

// Creates `count` codes in one go, all sharing a generated batchId so they
// can be pulled back together afterwards (see listPromoCodesByBatch). Always
// auto-generates each code's token — a bulk batch of caller-chosen strings
// doesn't make sense.
function createPromoCodeBatch(count, { durationMs = 0, maxUses = 0, createdBy, redeemByMs = null, campaign = null, prefix = null }) {
    const batchId = `batch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const created = [];
    for (let i = 0; i < count; i++) {
        const result = createPromoCode({ code: null, durationMs, maxUses, createdBy, redeemByMs, campaign, batchId, prefix });
        if (result.success) created.push(result.code);
    }
    return { batchId, codes: created };
}

function deletePromoCode(code) {
    const key = String(code).trim().toUpperCase();
    const codes = loadPromoCodes();
    if (!codes[key]) return false;
    delete codes[key];
    savePromoCodes(codes);
    return true;
}

function listPromoCodes() {
    return Object.values(loadPromoCodes()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function listPromoCodesByBatch(batchId) {
    return Object.values(loadPromoCodes()).filter(c => c.batchId === batchId);
}

// Redeems a code for a user: validates existence, the code's own redeem-by
// deadline (if any), the use-limit, and that this user hasn't already
// redeemed this specific code — then grants VIP for the code's durationMs.
function redeemPromoCode(userId, code) {
    const key = String(code).trim().toUpperCase();
    const codes = loadPromoCodes();
    const entry = codes[key];
    if (!entry) return { success: false, reason: 'not_found' };

    if (entry.redeemByMs && Date.now() > entry.redeemByMs) {
        return { success: false, reason: 'expired' };
    }

    const userKey = String(userId);
    if (entry.usedBy.some(u => u.userId === userKey)) {
        return { success: false, reason: 'already_used' };
    }
    if (entry.maxUses > 0 && entry.usedBy.length >= entry.maxUses) {
        return { success: false, reason: 'limit_reached' };
    }

    entry.usedBy.push({ userId: userKey, usedAt: new Date().toISOString() });
    codes[key] = entry;
    savePromoCodes(codes);

    const expiresAt = grantVipMs(userId, entry.durationMs, 'promo', key);
    return { success: true, durationMs: entry.durationMs, unlimited: entry.durationMs === 0, expiresAt, code: key };
}

// ===== VIP Categories (admin-curated video categories, VIP-only access) =====
// Deliberately a SEPARATE store from shared_files.json (the free /random
// pool). Videos here are never read by getUnseenFiles/addSharedFile and are
// never mixed into the free pool — the only way a video enters a category is
// addVideoToCategory(), and the only way it's ever delivered is through the
// VIP-gated category browser in bot.js. That separation (not just a flag on
// a shared record) is what guarantees free members can never reach this
// content, by construction rather than by a check that could be missed.
//
// Stored by file_id/file_unique_id rather than (chat_id, message_id) like
// the free pool — this lets an admin add a video from ANY chat (a forward,
// a fresh upload straight to the bot, whatever) without needing a permanent
// source channel to copyMessage from later. Telegram file_ids remain valid
// as long as the underlying file exists on their servers.
function loadCategories() {
    return safeReadJson(CATEGORIES_PATH, {});
}

function saveCategories(categories) {
    atomicWrite(CATEGORIES_PATH, categories);
}

function genId(prefix) {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const CATEGORY_NAME_MAX_LEN = 64;

// Creates a category. Names are unique (case-insensitive) so two categories
// that only differ by casing/whitespace can't be created by accident.
function createCategory(name, createdBy) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { success: false, reason: 'empty' };
    if (trimmed.length > CATEGORY_NAME_MAX_LEN) return { success: false, reason: 'too_long' };

    const categories = loadCategories();
    const dupe = Object.values(categories).some(c => c.name.toLowerCase() === trimmed.toLowerCase());
    if (dupe) return { success: false, reason: 'exists' };

    const id = genId('cat_');
    const category = {
        id,
        name: trimmed,
        createdAt: new Date().toISOString(),
        createdBy: String(createdBy),
        videos: []
    };
    categories[id] = category;
    saveCategories(categories);
    return { success: true, category };
}

function renameCategory(id, newName) {
    const trimmed = String(newName || '').trim();
    if (!trimmed) return { success: false, reason: 'empty' };
    if (trimmed.length > CATEGORY_NAME_MAX_LEN) return { success: false, reason: 'too_long' };

    const categories = loadCategories();
    const category = categories[id];
    if (!category) return { success: false, reason: 'not_found' };

    const dupe = Object.values(categories).some(c => c.id !== id && c.name.toLowerCase() === trimmed.toLowerCase());
    if (dupe) return { success: false, reason: 'exists' };

    category.name = trimmed;
    saveCategories(categories);
    return { success: true, category };
}

// Deletes a category and its video references. The underlying Telegram
// files/messages elsewhere are completely untouched — this only forgets
// this bot's pointer to them.
function deleteCategory(id) {
    const categories = loadCategories();
    if (!categories[id]) return false;
    delete categories[id];
    saveCategories(categories);
    return true;
}

function listCategories() {
    return Object.values(loadCategories()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// Only categories that currently hold at least one video — used for the
// user-facing browse list so a VIP member never opens an empty category.
function listNonEmptyCategories() {
    return listCategories().filter(c => (c.videos || []).length > 0);
}

function getCategory(id) {
    return loadCategories()[id] || null;
}

// Adds one video (photo/video/animation) to a category. The video must
// already have been archived into the dedicated Category Storage Channel
// (see bot.js) — this just records the POINTER to that channel post
// (chat_id + message_id), the same proven approach the free /random pool
// uses (copyMessage from a permanent channel post), rather than storing a
// raw file_id. That makes delivery self-healing: if a post is ever removed
// from the storage channel, copyMessage fails predictably and the dangling
// entry can be cleaned up automatically (see removeCategoryVideoByMessage).
//
// Dedupes on file_unique_id WITHIN the same category — re-adding the exact
// same clip to a category it's already in is a no-op. The same video is
// still allowed to belong to multiple different categories on purpose.
function addVideoToCategory(categoryId, { chatId, messageId, fileUniqueId, type, addedBy, caption }) {
    const categories = loadCategories();
    const category = categories[categoryId];
    if (!category) return { success: false, reason: 'not_found' };

    if (fileUniqueId && category.videos.some(v => v.file_unique_id === fileUniqueId)) {
        return { success: false, reason: 'duplicate' };
    }

    const video = {
        id: genId('v_'),
        chat_id: chatId,
        message_id: messageId,
        file_unique_id: fileUniqueId || null,
        type: type || 'video',
        caption: caption || null,
        added_at: new Date().toISOString(),
        added_by: String(addedBy)
    };
    category.videos.push(video);
    saveCategories(categories);
    return { success: true, video, count: category.videos.length };
}

function removeVideoFromCategory(categoryId, videoId) {
    const categories = loadCategories();
    const category = categories[categoryId];
    if (!category) return false;
    const before = category.videos.length;
    category.videos = category.videos.filter(v => v.id !== videoId);
    if (category.videos.length === before) return false;
    saveCategories(categories);
    return true;
}

// Self-heal: removes any category video entries pointing at a
// (chat_id, message_id) that Telegram reports as gone (e.g. deleted
// straight from the storage channel). Scans every category, since one
// storage channel serves all of them — mirrors removeSharedFile()'s
// self-healing for the free pool.
function removeCategoryVideoByMessage(chatId, messageId) {
    const categories = loadCategories();
    let removed = false;
    for (const cat of Object.values(categories)) {
        const before = cat.videos.length;
        cat.videos = cat.videos.filter(v => !(String(v.chat_id) === String(chatId) && v.message_id === messageId));
        if (cat.videos.length !== before) removed = true;
    }
    if (removed) saveCategories(categories);
    return removed;
}

function getCategoryStats() {
    const categories = listCategories();
    return {
        totalCategories: categories.length,
        totalVideos: categories.reduce((sum, c) => sum + (c.videos || []).length, 0)
    };
}

// ===== Category engagement tracking (Trending Categories) =====
// `views` counts each successful open/browse/preview event (not each video
// delivered within a batch — a 15-video batch is still one "view"). Fine
// for a VIP-scale user base. `viewerIds` dedupes so we can also show
// unique-viewer counts if useful later. Both are best-effort — missing on
// older categories, which read back as 0/[] via the `|| 0` / `|| []`
// fallbacks below rather than needing a migration.
function recordCategoryView(categoryId, userId, count = 1) {
    const categories = loadCategories();
    const category = categories[categoryId];
    if (!category) return;
    category.views = (category.views || 0) + count;
    if (!Array.isArray(category.viewerIds)) category.viewerIds = [];
    const uid = String(userId);
    if (!category.viewerIds.includes(uid)) category.viewerIds.push(uid);
    saveCategories(categories);
}

function getCategoryLeaderboard(limit = 10) {
    const categories = listCategories();
    return categories
        .map(c => ({
            id: c.id,
            name: c.name,
            views: c.views || 0,
            uniqueViewers: Array.isArray(c.viewerIds) ? c.viewerIds.length : 0,
            videoCount: (c.videos || []).length
        }))
        .sort((a, b) => b.views - a.views)
        .slice(0, limit);
}

// ===== MEGA Accounts (Folder Upload — multi-account rotation) =====
// Credentials live in config.json alongside everything else. Passwords are
// stored in plain text here, same trust model as BOT_TOKEN/API_HASH in
// .env — anyone with shell access to the VPS already has full control, so
// this isn't adding a new exposure. Keep the VPS itself locked down.
function getMegaAccounts() {
    return loadConfig().megaAccounts || [];
}

function addMegaAccount(email, password, label) {
    const config = loadConfig();
    const accounts = config.megaAccounts || [];
    if (accounts.some(a => a.email.toLowerCase() === String(email).toLowerCase())) {
        return { success: false, reason: 'exists' };
    }
    const account = {
        id: genId('acc_'),
        email: String(email).trim(),
        password: String(password),
        label: (label || String(email).trim()).slice(0, 40),
        disabledUntil: null,
        addedAt: new Date().toISOString()
    };
    accounts.push(account);
    config.megaAccounts = accounts;
    saveConfig(config);
    return { success: true, account };
}

function removeMegaAccount(id) {
    const config = loadConfig();
    const accounts = config.megaAccounts || [];
    const before = accounts.length;
    config.megaAccounts = accounts.filter(a => a.id !== id);
    if (config.megaAccounts.length === before) return false;
    saveConfig(config);
    return true;
}

// Puts an account on cooldown (e.g. after a quota/bandwidth error) so the
// rotation picker skips it until the cooldown expires.
function setMegaAccountCooldown(id, untilMs) {
    const config = loadConfig();
    const accounts = config.megaAccounts || [];
    const account = accounts.find(a => a.id === id);
    if (!account) return false;
    account.disabledUntil = untilMs;
    config.megaAccounts = accounts;
    saveConfig(config);
    return true;
}

// ===== Folder Upload jobs (resume-on-failure) =====
// One job = one admin-selected MEGA subfolder being downloaded + delivered.
// State is written after every single file so a crash/restart mid-job can
// pick up exactly where it left off instead of re-downloading everything.
function loadFolderJobs() {
    return safeReadJson(FOLDER_JOBS_PATH, {});
}

function saveFolderJobs(jobs) {
    atomicWrite(FOLDER_JOBS_PATH, jobs);
}

function createFolderJob(job) {
    const jobs = loadFolderJobs();
    jobs[job.id] = job;
    saveFolderJobs(jobs);
    return job;
}

function updateFolderJob(id, patch) {
    const jobs = loadFolderJobs();
    if (!jobs[id]) return null;
    jobs[id] = { ...jobs[id], ...patch };
    saveFolderJobs(jobs);
    return jobs[id];
}

function getFolderJob(id) {
    return loadFolderJobs()[id] || null;
}

function listRunningFolderJobs() {
    return Object.values(loadFolderJobs()).filter(j => j.status === 'running');
}

// Every job regardless of status — used by the startup resume sweep, which
// needs to see paused/stopping jobs too (not just 'running' ones) so it can
// land them in a clean terminal state after a crash/restart.
function listAllFolderJobs() {
    return Object.values(loadFolderJobs());
}

// Jobs a human would still care about seeing in /uploadjobs — anything not
// yet finished. Excludes 'done'/'failed' terminal jobs to keep the list short.
function listActiveFolderJobs() {
    return Object.values(loadFolderJobs()).filter(j =>
        ['running', 'pause_requested', 'paused', 'stop_requested', 'cancelled'].includes(j.status)
    );
}

function deleteFolderJob(id) {
    const jobs = loadFolderJobs();
    if (!jobs[id]) return false;
    delete jobs[id];
    saveFolderJobs(jobs);
    return true;
}

// ===== Folder upload history (duplicate detection) =====
// Keyed by the MEGA folder's own node handle (stable per folder regardless
// of how the admin navigated to it) + the destination, so re-uploading the
// exact same folder to the exact same place is what gets flagged — sending
// it to a *different* channel/category a second time is allowed silently.
function loadFolderUploadHistory() {
    return safeReadJson(FOLDER_UPLOAD_HISTORY_PATH, {});
}

function saveFolderUploadHistory(history) {
    atomicWrite(FOLDER_UPLOAD_HISTORY_PATH, history);
}

function folderHistoryKey(folderNodeId, destinationType, destinationId) {
    return `${folderNodeId}:${destinationType}:${destinationId}`;
}

function findFolderUpload(folderNodeId, destinationType, destinationId) {
    const history = loadFolderUploadHistory();
    return history[folderHistoryKey(folderNodeId, destinationType, destinationId)] || null;
}

function recordFolderUpload(folderNodeId, destinationType, destinationId, meta) {
    const history = loadFolderUploadHistory();
    const key = folderHistoryKey(folderNodeId, destinationType, destinationId);
    history[key] = { ...meta, uploadedAt: new Date().toISOString() };
    saveFolderUploadHistory(history);
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

// ===== Weekly summary helpers =====
// Counts users whose `joinedAt` (added once the field existed — see getUser)
// falls on/after the given cutoff. Users created before this field existed
// are simply excluded, not miscounted as new.
function getUsersJoinedSince(sinceMs) {
    const users = loadUsers();
    return Object.values(users).filter(u => u.joinedAt && new Date(u.joinedAt).getTime() >= sinceMs).length;
}

// Counts pool files added on/after the given cutoff, using each file's
// existing `added_at` timestamp (set when addSharedFile() first tracks it).
function getFilesAddedSince(sinceMs) {
    return loadSharedFiles().filter(f => f.added_at && new Date(f.added_at).getTime() >= sinceMs).length;
}

// Top N referrers all-time, by referral count. Used for a leaderboard
// spotlight in the weekly summary.
function getTopReferrers(limit = 3) {
    const users = loadUsers();
    return Object.entries(users)
        .map(([id, u]) => ({ id, count: (u.referrals || []).length }))
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
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
    sourceChannelId: null,   // deprecated single-source field, kept for migration only — see sourceChannelIds
    sourceChannelIds: [],    // where videos are pulled FROM (one or more channels), must not include channelId
    intervalMinutes: 0,    // 0 = disabled; stored in minutes so hours+minutes are both supported
    caption: 'New Post 🎬',
    thumbnailMode: 'video', // 'video' = use the video's own thumbnail, 'custom' = admin-uploaded
    customThumbnailFileId: null,
    blurEnabled: false,
    enabled: false,
    postedTags: [],         // "chatId:messageId" tags already posted/permanently skipped, never repeats
    retryCounts: {},        // "chatId:messageId" -> number of failed attempts so far (cleared on success/give-up)
    postTimestamps: [],     // ms epoch of every successful post, for daily/weekly stats (pruned to last 90 days)
    lowQueueWarned: false,  // true while queue is below threshold, so the warning fires once per low period
    lastPostAt: 0
};

// Old configs stored a single `sourceChannelId`. Migrate it into the new
// `sourceChannelIds` array (once) so multi-source support doesn't lose
// anyone's existing setup.
function migrateSourceChannels(cfg, raw) {
    if ((!cfg.sourceChannelIds || cfg.sourceChannelIds.length === 0) && raw && raw.sourceChannelId) {
        cfg.sourceChannelIds = [raw.sourceChannelId];
    }
    return cfg;
}

// Returns a fresh default object every call — DEFAULT_AUTOPOST.postedTags/
// retryCounts must never be spread directly, since `{ ...DEFAULT_AUTOPOST }`
// only copies the *reference* to those arrays/objects. Every brand-new admin
// config would then share (and mutate) the very same array/object, silently
// leaking postedTags/retryCounts across admins. Cloning here keeps each
// config's mutable fields independent.
function freshDefaultAutopost() {
    return { ...DEFAULT_AUTOPOST, postedTags: [], retryCounts: {}, sourceChannelIds: [], postTimestamps: [] };
}

// Old configs stored `intervalHours` (whole hours only). Migrate them to
// `intervalMinutes` on read so existing setups keep working unchanged.
function normalizeAutopostConfig(raw) {
    const cfg = { ...freshDefaultAutopost(), ...raw };
    if (!cfg.intervalMinutes && raw && raw.intervalHours) {
        cfg.intervalMinutes = raw.intervalHours * 60;
    }
    delete cfg.intervalHours;
    migrateSourceChannels(cfg, raw);
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

const POST_STATS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // keep 90 days of post timestamps for stats

function markAutopostTagPosted(adminId, tag) {
    const configs = loadAutopostConfigs();
    const key = String(adminId);
    const cfg = { ...freshDefaultAutopost(), ...(configs[key] || {}) };
    if (!cfg.postedTags.includes(tag)) cfg.postedTags.push(tag);
    if (cfg.retryCounts && cfg.retryCounts[tag] != null) {
        cfg.retryCounts = { ...cfg.retryCounts };
        delete cfg.retryCounts[tag];
    }
    const now = Date.now();
    cfg.postTimestamps = [...(cfg.postTimestamps || []), now].filter(t => now - t < POST_STATS_RETENTION_MS);
    cfg.lastPostAt = now;
    configs[key] = cfg;
    saveAutopostConfigs(configs);
}

// Auto-post stats for the panel/"📊 Stats" view: how many posts today, this
// week, and all-time (all-time = postedTags.length, which never shrinks).
// Uses IST calendar days regardless of the server's own system timezone.
function istDateString(ms) {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // "YYYY-MM-DD"
}

function getAutopostStats(adminId) {
    const cfg = getAutopostConfig(adminId);
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const todayStr = istDateString(now);
    const timestamps = cfg.postTimestamps || [];
    return {
        today: timestamps.filter(t => istDateString(t) === todayStr).length,
        week: timestamps.filter(t => now - t < 7 * DAY_MS).length,
        allTime: cfg.postedTags.length
    };
}

function markAutopostTagSkipped(adminId, tag) {
    const configs = loadAutopostConfigs();
    const key = String(adminId);
    const cfg = { ...freshDefaultAutopost(), ...(configs[key] || {}) };
    if (!cfg.postedTags.includes(tag)) cfg.postedTags.push(tag);
    if (cfg.retryCounts && cfg.retryCounts[tag] != null) {
        cfg.retryCounts = { ...cfg.retryCounts };
        delete cfg.retryCounts[tag];
    }
    configs[key] = cfg;
    saveAutopostConfigs(configs);
}

// Records one failed attempt at posting `tag` and returns the new attempt
// count. Used to cap retries (see MAX_AUTOPOST_RETRIES in bot.js) so a
// permanently-broken video doesn't get retried forever.
function incrementAutopostRetry(adminId, tag) {
    const configs = loadAutopostConfigs();
    const key = String(adminId);
    const cfg = { ...freshDefaultAutopost(), ...(configs[key] || {}) };
    cfg.retryCounts = { ...cfg.retryCounts };
    cfg.retryCounts[tag] = (cfg.retryCounts[tag] || 0) + 1;
    configs[key] = cfg;
    saveAutopostConfigs(configs);
    return cfg.retryCounts[tag];
}

// Clears the retry counter for a tag (called after it's finally posted, or
// once it's been given up on and marked permanently skipped).
function clearAutopostRetry(adminId, tag) {
    const configs = loadAutopostConfigs();
    const key = String(adminId);
    const cfg = { ...freshDefaultAutopost(), ...(configs[key] || {}) };
    if (cfg.retryCounts && cfg.retryCounts[tag] != null) {
        cfg.retryCounts = { ...cfg.retryCounts };
        delete cfg.retryCounts[tag];
        configs[key] = cfg;
        saveAutopostConfigs(configs);
    }
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

// True once this user's "pending" mode join request has actually been
// approved (auto-approved after delayHours, or approved manually) — i.e.
// they were genuinely added to the group, not just that they once tapped
// the request-to-join link. Used to decide whether a live re-check against
// the group is warranted (see checkMembership's join→leave→rejoin guard).
function isJoinRequestApproved(chatId, userId) {
    const rec = loadPendingJoinRequests().find(r => String(r.chatId) === String(chatId) && String(r.userId) === String(userId));
    return !!(rec && rec.approved);
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

// ===== VIP promotion button click tracking =====
// Keyed by userId -> { count, lastClickedAt }. Lets the admin see total
// clicks and unique interested users in the VIP Promotion panel.
function loadVipClicks() {
    return safeReadJson(VIP_CLICKS_PATH, {});
}

function saveVipClicks(clicks) {
    atomicWrite(VIP_CLICKS_PATH, clicks);
}

function recordVipClick(userId) {
    const clicks = loadVipClicks();
    const key = String(userId);
    const existing = clicks[key] || { count: 0 };
    clicks[key] = { count: existing.count + 1, lastClickedAt: new Date().toISOString() };
    saveVipClicks(clicks);
}

function getVipStats() {
    const clicks = loadVipClicks();
    const users = Object.keys(clicks);
    const totalClicks = users.reduce((sum, id) => sum + (clicks[id].count || 0), 0);
    return { totalClicks, uniqueUsers: users.length };
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
    getUsersJoinedSince,
    getFilesAddedSince,
    getTopReferrers,
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
    markAutopostTagSkipped,
    incrementAutopostRetry,
    clearAutopostRetry,
    getAutopostStats,
    getForceSubSettings,
    setForceSubSettings,
    recordJoinRequest,
    hasJoinRequest,
    markJoinRequestApproved,
    isJoinRequestApproved,
    getDueJoinRequestsForApproval,
    isMaintenanceAllowed,
    addMaintenanceWhitelist,
    removeMaintenanceWhitelist,
    getMaintenanceWhitelist,
    getConfigBackupFiles,
    recordVipClick,
    getVipStats,
    grantVip,
    grantVipMs,
    revokeVip,
    isUserVip,
    getVipInfo,
    createPromoCode,
    createPromoCodeBatch,
    deletePromoCode,
    listPromoCodes,
    listPromoCodesByBatch,
    redeemPromoCode,
    schedulePendingDeletion,
    getDuePendingDeletions,
    removePendingDeletion,
    createCategory,
    renameCategory,
    deleteCategory,
    listCategories,
    listNonEmptyCategories,
    getCategory,
    addVideoToCategory,
    removeVideoFromCategory,
    removeCategoryVideoByMessage,
    getCategoryStats,
    recordCategoryView,
    getCategoryLeaderboard,
    getMegaAccounts,
    addMegaAccount,
    removeMegaAccount,
    setMegaAccountCooldown,
    createFolderJob,
    updateFolderJob,
    getFolderJob,
    listRunningFolderJobs,
    listAllFolderJobs,
    listActiveFolderJobs,
    deleteFolderJob,
    findFolderUpload,
    recordFolderUpload
};
