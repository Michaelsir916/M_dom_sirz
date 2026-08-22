const { Telegraf } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mega = require('megajs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');
const archiver = require('archiver');
let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; } // blur feature degrades gracefully if not installed
require('dotenv').config();
const {
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
    getReferrerRank,
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
    revokeVip,
    isUserVip,
    getVipInfo,
    createPromoCode,
    deletePromoCode,
    listPromoCodes,
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
    getCategoryStats
} = require('./fileShare');
const queue = require('./queue');

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: Infinity });

// Runs before every single handler. When maintenance mode is ON, only admins
// and whitelisted users pass through — everyone else gets a plain notice.
// Channel posts are anonymous (no ctx.from), so they're left alone here;
// the per-command trusted-admin checks elsewhere still gate those.
bot.use(async (ctx, next) => {
    const config = loadConfig();
    if (!config.maintenanceMode || !ctx.from) return next();
    if (isMaintenanceAllowed(ctx.from.id)) return next();

    if (ctx.updateType === 'callback_query') {
        await ctx.answerCbQuery('🛠 Bot under maintenance.', { show_alert: true }).catch(() => {});
        return;
    }
    if (ctx.chat && ctx.chat.type === 'private') {
        await ctx.reply('🛠 Bot under maintenance.').catch(() => {});
    }
    // In groups, stay silent rather than replying to every message.
});

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
});

let mtprotoStarted = false;
async function startMtproto() {
    if (!mtprotoStarted) {
        console.log('🔄 Starting MTProto Client...');
        await client.start({ botAuthToken: process.env.BOT_TOKEN });
        mtprotoStarted = true;
        console.log('✅ MTProto Client Started!');
    }
}
let botUsername = '';
const botStartedAt = Date.now();

// Telegram throws this whenever editMessageText/editMessageCaption is called
// with content+markup identical to what's already displayed (e.g. pressing
// "Back" into a panel that hasn't changed since it was last drawn). It's
// not a bug — nothing needs to change — so it's treated as a harmless no-op
// everywhere rather than logged as an error.
function isMessageNotModifiedError(error) {
    return !!(error && error.description && error.description.includes('message is not modified'));
}

// --- Error log channel ---
// Sends bot errors/events to an admin-configured Telegram chat (set via
// /setlogchannel) so crashes/bugs and auto-post issues can be spotted
// without SSH-ing into Termux to read logs.
//
// Dedup: if the exact same message (same dedupeKey) was already sent within
// the last 5 minutes, it's suppressed — one repeated bug/error only shows up
// once per 5-minute window instead of flooding the log channel every tick.
const recentLogEntries = new Map(); // dedupeKey -> last-sent timestamp (ms)
const LOG_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function shouldSendLog(dedupeKey) {
    if (!dedupeKey) return true;
    const now = Date.now();
    const last = recentLogEntries.get(dedupeKey);
    if (last && (now - last) < LOG_DEDUPE_WINDOW_MS) return false;
    recentLogEntries.set(dedupeKey, now);
    // Occasional cleanup so this map doesn't grow forever on a long-running process.
    if (recentLogEntries.size > 500) {
        for (const [k, t] of recentLogEntries) {
            if (now - t > LOG_DEDUPE_WINDOW_MS) recentLogEntries.delete(k);
        }
    }
    return true;
}

// Low-level sender shared by logError() and logAutopostEvent(). dedupeKey is
// optional — omit it to always send (used for one-off admin-triggered stuff).
async function sendToLogChannel(text, dedupeKey) {
    try {
        const config = loadConfig();
        if (!config.errorLogChatId) return;
        if (!shouldSendLog(dedupeKey)) return;

        try {
            await bot.telegram.sendMessage(config.errorLogChatId, text, { parse_mode: 'Markdown' });
        } catch (parseErr) {
            // Text sometimes contains unbalanced Markdown entities
            // (backticks/underscores/asterisks) — fall back to plain text
            // so the log message still gets through.
            const plain = text.replace(/[*`_]/g, '');
            await bot.telegram.sendMessage(config.errorLogChatId, plain);
        }
    } catch (logSendError) {
        console.error('Cannot send to error log channel:', logSendError.message);
    }
}

async function logError(label, error) {
    const message = (error && error.message) ? error.message : String(error);
    const stack = (error && error.stack) ? error.stack.split('\n').slice(0, 4).join('\n') : '';
    console.error(`❌ ${label}:`, message);
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const text = `🚨 *Bot Error*\n\n*When:* ${timestamp} IST\n*Where:* ${label}\n*Error:* \`${message}\`` +
        (stack ? `\n\n\`\`\`\n${stack}\n\`\`\`` : '');
    // Dedup key: same label + same error message within 5 min = one log entry only.
    await sendToLogChannel(text, `err:${label}:${message}`);
}

// Non-crash auto-post events (skips, retries, empty queue, etc). Always
// routed through the same dedup-aware sender so a stuck/broken video
// doesn't spam the log channel every minute.
async function logAutopostEvent(text, dedupeKey) {
    console.log(`ℹ️ Auto-post event: ${text.replace(/\n/g, ' ').slice(0, 120)}`);
    await sendToLogChannel(text, dedupeKey);
}

// --- Unauthorized access attempt logging ---
// Fires whenever a non-admin tries an admin-only command/button, so the
// admin can see who's probing the bot. Dedup: same user + same thing they
// tried, within 5 min, only logs once (a curious/spammy user tapping the
// same button repeatedly shouldn't flood the log channel).
async function logUnauthorizedAccess(ctx, attempted) {
    const userId = (ctx.from && ctx.from.id) || 'unknown';
    const username = ctx.from && ctx.from.username ? `@${ctx.from.username}` : ((ctx.from && ctx.from.first_name) || 'unknown');
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const text = `🚫 *Unauthorized Access Attempt*\n\n*When:* ${timestamp} IST\n*User:* ${username} (\`${userId}\`)\n*Tried:* \`${attempted}\``;
    console.log(`🚫 Unauthorized attempt: user ${userId} (${username}) tried "${attempted}"`);
    await sendToLogChannel(text, `unauth:${userId}:${attempted}`);
}

// Central admin gate. Returns true if the caller is an admin. Otherwise
// logs the attempt and (for button taps) acknowledges the callback so
// Telegram doesn't show a spinning loading state, then returns false so
// the handler can bail out with `if (!(await requireAdmin(ctx))) return;`.
async function requireAdmin(ctx, viaAction = false) {
    if (isAdmin(ctx.from && ctx.from.id)) return true;
    const attempted = viaAction
        ? ((ctx.callbackQuery && ctx.callbackQuery.data) || 'unknown_action')
        : ((ctx.message && ctx.message.text) || 'unknown_command');
    await logUnauthorizedAccess(ctx, attempted);
    if (viaAction) {
        try { await ctx.answerCbQuery(); } catch (e) { /* ignore */ }
    }
    return false;
}

// In-memory "what is this admin currently typing for" state, keyed by admin
// user id. Used so button flows (add force-sub, set source, broadcast, custom
// values) can ask the admin to send one plain message instead of a slash
// command. Cleared on use, on /cancel, or lost on restart (admin just retaps).
const pendingAction = {};

// In-memory holder for an auto-post "test preview" awaiting the admin's
// ✅ Post / ❌ Skip tap (setup-time confirm only — scheduled runs never wait
// on this). Keyed by admin user id. Lost on restart, which is fine — the
// admin just re-runs the test.
const pendingAutopostPreview = {};

function chatTypeIcon(type) {
    if (type === 'channel') return '📢';
    if (type === 'group' || type === 'supergroup') return '👥';
    return '💬';
}

// Records any non-private chat the bot sees a message from, so it can later
// be offered as a tap-to-pick button for force-sub / source setup — no need
// for the admin to enter the chat and type a command.
function trackKnownChat(ctx) {
    if (!ctx.chat || ctx.chat.type === 'private') return;
    recordKnownChat(ctx.chat.id, ctx.chat.title, ctx.chat.type);
}

// Fires whenever the bot's own membership status changes in a chat (added,
// promoted to admin, kicked, etc). This is the ONLY reliable place Telegram
// tells us WHO performed the action — ctx.myChatMember.from — so it's what
// we use to attribute "which admin added this group/channel", regardless of
// who actually owns the chat. Every other known-chat picker filters on this.
bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    if (!update || !update.chat || update.chat.type === 'private') return;
    const newStatus = update.new_chat_member?.status;
    // Only (re)attribute on actual "added/promoted" transitions, not on every
    // status ping — being left/kicked shouldn't overwrite who originally added it.
    if (!['member', 'administrator'].includes(newStatus)) return;
    const actorId = update.from?.id;
    recordKnownChat(update.chat.id, update.chat.title, update.chat.type, actorId);
});

// ===== Broadcast tag helpers (encode a chat_id:message_id pair into a
// Telegram /start deep-link payload, which only allows [A-Za-z0-9_-]) =====
function encodeFileTag(chatId, messageId) {
    const sign = chatId < 0 ? 'm' : 'p';
    return `get-${sign}${Math.abs(chatId)}-${messageId}`;
}

function decodeFileTag(payload) {
    const match = /^get-([mp])(\d+)-(\d+)$/.exec(payload);
    if (!match) return null;
    const chatId = match[1] === 'm' ? -Number(match[2]) : Number(match[2]);
    return { chatId, messageId: Number(match[3]) };
}

// ===== Rate-limited broadcast core =====
// Sends to every user via sendFn(userId), staying under Telegram's ~30
// msgs/sec global cap by batching (config.broadcastBatchSize per second).
// Auto-flags users who've blocked the bot, and retries once for anyone
// who got rate-limited (429) mid-broadcast. Records the result to history.
async function broadcastToUsers(sendFn, meta) {
    const config = loadConfig();
    const batchSize = Math.max(1, config.broadcastBatchSize || 25);
    const userIds = getAllUserIds();
    let sent = 0, blocked = 0, failed = 0;
    const retryQueue = [];

    for (let i = 0; i < userIds.length; i += batchSize) {
        const batch = userIds.slice(i, i + batchSize);
        await Promise.all(batch.map(async (uid) => {
            try {
                await sendFn(uid);
                sent++;
            } catch (error) {
                const code = error?.response?.error_code;
                const desc = error?.response?.description || error.message || '';
                if (code === 403 || /blocked|deactivated|kicked/i.test(desc)) {
                    markUserBlocked(uid);
                    blocked++;
                } else if (code === 429) {
                    retryQueue.push(uid);
                } else {
                    failed++;
                }
            }
        }));
        if (i + batchSize < userIds.length) await new Promise(r => setTimeout(r, 1000));
    }

    // One retry pass for anyone who was rate-limited mid-broadcast
    if (retryQueue.length > 0) {
        await new Promise(r => setTimeout(r, 2000));
        for (const uid of retryQueue) {
            try {
                await sendFn(uid);
                sent++;
            } catch (error) {
                const code = error?.response?.error_code;
                if (code === 403) { markUserBlocked(uid); blocked++; }
                else failed++;
            }
        }
    }

    const result = { total: userIds.length, sent, failed, blocked };
    addBroadcastHistory({ ...meta, ...result });
    return result;
}

function cleanMegaLink(link) {
    if (!link) return null;
    let cleanedLink = link.trim()
        .replace(/\s+/g, '')
        .replace(/[\<\>]/g, '');
    if (cleanedLink.includes('mega.nz')) {
        // Ensure it starts with https://
        if (!cleanedLink.startsWith('http')) {
            cleanedLink = 'https://' + cleanedLink;
        }
        return cleanedLink;
    }
    return null;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function isVideoFile(filename) {
    const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv'];
    const ext = path.extname(filename).toLowerCase();
    return videoExtensions.includes(ext);
}

function isImageFile(filename) {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg', '.ico'];
    const ext = path.extname(filename).toLowerCase();
    return imageExtensions.includes(ext);
}

function isAudioFile(filename) {
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.opus'];
    const ext = path.extname(filename).toLowerCase();
    return audioExtensions.includes(ext);
}

async function sendTelegramFile(ctx, filePath, fileName, fileSize, progressCallback, destinationChatId) {
    const chatId = destinationChatId || ctx.chat.id;
    const sendingElsewhere = destinationChatId && destinationChatId !== ctx.chat.id;

    try {
        await startMtproto();
        const forceDocument = !isVideoFile(fileName) && !isImageFile(fileName) && !isAudioFile(fileName);

        return await client.sendFile(chatId, {
            file: filePath,
            caption: '', // never leak the filename/mega link/info into the destination — clean file only
            forceDocument: forceDocument,
            // Don't reply-thread into a message that lives in a different chat
            replyTo: (!sendingElsewhere && ctx.message) ? ctx.message.message_id : undefined,
            progressCallback: progressCallback
        });
    } catch (error) {
        console.error(`Failed to send via MTProto: ${error.message}`);
        throw error;
    }
}

function cleanupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

function cleanupFolder(folderPath) {
    try {
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
        }
    } catch (error) {
        console.error('Folder cleanup error:', error);
    }
}

async function getAllFilesFromFolder(folder) {
    const files = [];

    try {
        if (folder.children && Array.isArray(folder.children)) {
            for (const child of folder.children) {
                if (child.directory) {
                    const subfolderFiles = await getAllFilesFromFolder(child);
                    files.push(...subfolderFiles);
                } else {
                    files.push(child);
                }
            }
        } else {
            await new Promise((resolve, reject) => {
                if (typeof folder.loadChildren === 'function') {
                    folder.loadChildren((err, children) => {
                        if (err) reject(err);
                        else {
                            folder.children = children;
                            resolve();
                        }
                    });
                } else if (typeof folder.getChildren === 'function') {
                    folder.getChildren((err, children) => {
                        if (err) reject(err);
                        else {
                            folder.children = children;
                            resolve();
                        }
                    });
                } else {
                    reject(new Error('Cannot load folder contents'));
                }
            });

            for (const child of folder.children) {
                if (child.directory) {
                    const subfolderFiles = await getAllFilesFromFolder(child);
                    files.push(...subfolderFiles);
                } else {
                    files.push(child);
                }
            }
        }
    } catch (error) {
        console.error('Error getting folder contents:', error);
        throw error;
    }

    return files;
}
async function downloadMegaFolder(folder, tempDir, onProgress) {
    console.log(`📁 Folder detected: ${folder.name}`);

    try {
        const allFiles = await getAllFilesFromFolder(folder);

        if (allFiles.length === 0) {
            throw new Error('Folder is empty');
        }

        console.log(`📊 Found ${allFiles.length} files in folder`);

        const folderDir = path.join(tempDir, folder.name);
        if (!fs.existsSync(folderDir)) {
            fs.mkdirSync(folderDir, { recursive: true });
        }

        const downloadedFiles = [];
        const downloadErrors = [];

        for (let i = 0; i < allFiles.length; i++) {
            const file = allFiles[i];

            try {
                console.log(`⬇️  Downloading [${i + 1}/${allFiles.length}]: ${file.name}`);

                const filePath = path.join(folderDir, file.name);
                const fileDir = path.dirname(filePath);
                if (!fs.existsSync(fileDir)) {
                    fs.mkdirSync(fileDir, { recursive: true });
                }

                await new Promise((resolve, reject) => {
                    const writeStream = fs.createWriteStream(filePath);
                    let downloadedBytes = 0;
                    const stream = file.download();

                    stream.on('data', chunk => {
                        downloadedBytes += chunk.length;
                        if (onProgress) {
                            onProgress(downloadedBytes / file.size, file.name, file.size, i + 1, allFiles.length);
                        }
                    });

                    stream.on('error', (err) => {
                        writeStream.end();
                        cleanupFile(filePath);
                        reject(err);
                    });

                    stream.pipe(writeStream);

                    writeStream.on('finish', () => {
                        downloadedFiles.push({
                            path: filePath,
                            name: file.name,
                            size: file.size
                        });
                        resolve();
                    });

                    writeStream.on('error', (err) => {
                        cleanupFile(filePath);
                        reject(err);
                    });
                });

            } catch (error) {
                console.error(`❌ Failed to download ${file.name}:`, error.message);
                downloadErrors.push(`${file.name}: ${error.message}`);
            }
        }

        if (downloadedFiles.length === 0) {
            throw new Error('All downloads failed');
        }

        const totalSize = downloadedFiles.reduce((sum, file) => sum + file.size, 0);

        return {
            type: 'folder',
            folderPath: folderDir,
            files: downloadedFiles,
            fileCount: downloadedFiles.length,
            totalSize: totalSize,
            errors: downloadErrors
        };

    } catch (error) {
        throw new Error(`Folder download failed: ${error.message}`);
    }
}

async function downloadMegaFile(megaUrl, userId, onProgress) {
    console.log(`🔗 Processing URL: ${megaUrl}`);

    const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
        try {
            const file = mega.File.fromURL(megaUrl);

            if (!file) {
                throw new Error('Could not parse MEGA URL');
            }

            file.loadAttributes((err) => {
                if (err) {
                    console.error('❌ Error loading attributes:', err.message);

                    let errorMsg = `Failed to load: ${err.message}`;

                    if (err.message.includes('ENOENT') || err.message.includes('not found')) {
                        errorMsg = 'File/Folder not found. Link may be expired or invalid.';
                    } else if (err.message.includes('decryption')) {
                        errorMsg = 'Decryption failed. Check if your link has the correct key';
                    }

                    reject(new Error(errorMsg));
                    return;
                }

                console.log(`✅ File loaded: ${file.name} (${formatBytes(file.size)})`);

                if (file.directory) {
                    console.log('📁 This is a folder');

                    downloadMegaFolder(file, tempDir, onProgress)
                        .then(resolve)
                        .catch(reject);

                } else {
                    console.log('📄 This is a file');

                    const tempPath = path.join(tempDir, file.name);

                    console.log(`⬇️  Starting download to: ${tempPath}`);

                    const writeStream = fs.createWriteStream(tempPath);
                    let downloadedBytes = 0;
                    const stream = file.download();

                    stream.on('data', chunk => {
                        downloadedBytes += chunk.length;
                        if (onProgress) {
                            onProgress(downloadedBytes / file.size, file.name, file.size, 1, 1);
                        }
                    });

                    stream.on('error', (err) => {
                        console.error('❌ Download error:', err.message);
                        writeStream.end();
                        cleanupFile(tempPath);
                        reject(new Error(`Download failed: ${err.message}`));
                    });

                    stream.pipe(writeStream);

                    writeStream.on('finish', () => {
                        console.log('💾 File saved successfully');
                        resolve({
                            type: 'file',
                            path: tempPath,
                            name: file.name,
                            size: file.size
                        });
                    });

                    writeStream.on('error', (err) => {
                        console.error('❌ Write error:', err.message);
                        cleanupFile(tempPath);
                        reject(new Error(`Failed to save file: ${err.message}`));
                    });
                }
            });

        } catch (error) {
            console.error('❌ Error creating MEGA object:', error.message);
            reject(new Error(`Invalid MEGA link: ${error.message}`));
        }
    });
}

function createProgressUpdater(editStatusFunc, actionPrefix, totalFiles = 1) {
    let lastUpdate = 0;
    let lastProgressText = '';

    return async (progress, fileName, fileSize, fileIndex = 1) => {
        const now = Date.now();
        if (progress < 1 && now - lastUpdate < 2000) return;

        const filledLength = Math.round(10 * progress);
        const emptyLength = 10 - filledLength;
        const bar = '▓'.repeat(filledLength) + '░'.repeat(emptyLength);
        const percentage = (progress * 100).toFixed(1);
        const currentBytes = progress * fileSize;

        let fileStatus = '';
        if (totalFiles > 1) {
            fileStatus = `\n*File:* \`${fileName}\` [${fileIndex}/${totalFiles}]`;
        } else {
            fileStatus = `\n*Name:* \`${fileName}\``;
        }

        const prefix = typeof actionPrefix === 'function' ? actionPrefix() : actionPrefix;
        const progressText = `${prefix}${fileStatus}\n*Progress:* ${percentage}%\n*Size:* ${formatBytes(currentBytes)} / ${formatBytes(fileSize)}\n[${bar}]`;

        if (lastProgressText !== progressText) {
            lastUpdate = now;
            lastProgressText = progressText;
            try {
                await editStatusFunc(progressText);
            } catch (e) { }
        }
    };
}

async function processMegaLink(ctx, megaLink) {
    const userId = ctx.from ? ctx.from.id : ctx.chat.id;
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;

    // Admin-only: if a MEGA upload channel is configured and mode is 'channel',
    // the actual files go there instead of the chat the link was sent in.
    // Progress/status messages always stay in the original chat regardless.
    const config = loadConfig();
    const uploadDestination = (ctx.from && isAdmin(ctx.from.id) && config.megaUploadMode === 'channel' && config.megaUploadChannelId)
        ? config.megaUploadChannelId
        : chatId;
    const sendingToChannel = uploadDestination !== chatId;

    console.log(`📩 Processing MEGA link in ${chatType} ${chatId} from user ${userId}`);

    try {
        let statusMsg;
        try {
            statusMsg = await ctx.reply(`🔍 *Processing MEGA Link*\n\nChecking link...`, {
                parse_mode: 'Markdown'
            });
        } catch (statusError) {
            console.error('Cannot send status message:', statusError.message);

            try {
                statusMsg = await ctx.reply(`🔍 Processing MEGA Link\n\nChecking link...`);
            } catch (e) {
                console.error('Cannot send simple status either:', e.message);
            }
        }

        const editStatus = async (text) => {
            if (statusMsg) {
                try {
                    await ctx.telegram.editMessageText(
                        chatId,
                        statusMsg.message_id,
                        null,
                        text,
                        { parse_mode: 'Markdown' }
                    );
                } catch (editError) {
                    try {
                        await ctx.telegram.editMessageText(
                            chatId,
                            statusMsg.message_id,
                            null,
                            text.replace(/\*/g, '').replace(/_/g, '').replace(/`/g, '')
                        );
                    } catch (e) {
                        console.error('Cannot edit status:', e.message);
                    }
                }
            }
        };

        const downloadUpdater = createProgressUpdater(editStatus, '⬇️ *Downloading from MEGA*');
        const result = await downloadMegaFile(megaLink, userId, downloadUpdater);

        const deleteStatus = async () => {
            if (statusMsg) {
                try {
                    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id);
                } catch (deleteError) {
                    console.error('Cannot delete status:', deleteError.message);
                }
            }
        };

        if (result.type === 'file') {
            const uploadUpdater = createProgressUpdater(editStatus, '📤 *Uploading to Telegram*');
            await editStatus(`✅ *File Loaded*\n\n*Name:* \`${result.name}\`\n*Size:* ${formatBytes(result.size)}\n\n📤 Sending to Telegram...`);

            const maxFileSize = 2000 * 1024 * 1024;
            if (result.size > maxFileSize) {
                await editStatus(`❌ *File Too Large*\n\n*Name:* \`${result.name}\`\n*Size:* ${formatBytes(result.size)}\n\n⚠️ Telegram limit is 2GB per file.`);
                cleanupFile(result.path);
                return;
            }

            try {
                await sendTelegramFile(ctx, result.path, result.name, result.size, (progress) => {
                    uploadUpdater(progress, result.name, result.size, 1, 1);
                }, uploadDestination);
                await deleteStatus();

                if (chatType !== 'private') {
                    try {
                        await ctx.reply(`✅ *File sent successfully!*${sendingToChannel ? ' (to your configured channel)' : ''}`);
                    } catch (e) {
                        console.error('Cannot send success message:', e.message);
                    }
                } else if (sendingToChannel) {
                    try {
                        await ctx.reply(`✅ *File sent to your configured channel!*`, { parse_mode: 'Markdown' });
                    } catch (e) {
                        console.error('Cannot send success message:', e.message);
                    }
                }
            } catch (sendError) {
                await editStatus(`❌ *Failed to Send*\n\n*File:* \`${result.name}\`\n*Error:* ${sendError.message}`);
            }

            cleanupFile(result.path);

        } else if (result.type === 'folder') {
            await editStatus(`📦 *Folder Ready*\n\n*Name:* \`${path.basename(result.folderPath)}\`\n*Files:* ${result.fileCount}\n*Total Size:* ${formatBytes(result.totalSize)}\n\n📤 Starting to send files...`);

            await deleteStatus();

            try {
                await ctx.reply(`📁 *Folder Download Complete*\n\n*Name:* \`${path.basename(result.folderPath)}\`\n*Files:* ${result.fileCount}\n*Total Size:* ${formatBytes(result.totalSize)}`, {
                    parse_mode: 'Markdown'
                });
            } catch (e) {
                console.error('Cannot send folder info:', e.message);
            }

            let sentCount = 0;
            let failedCount = 0;
            const maxFileSize = 2000 * 1024 * 1024;

            let progressMsg;
            try {
                progressMsg = await ctx.reply(`📤 *Sending Files*\n\n✅ Sent: 0/${result.fileCount}\n❌ Failed: 0`, {
                    parse_mode: 'Markdown'
                });
            } catch (e) {
                console.error('Cannot send progress message:', e.message);
            }

            const folderUploadUpdater = createProgressUpdater((text) => {
                if (progressMsg) {
                    return ctx.telegram.editMessageText(
                        chatId,
                        progressMsg.message_id,
                        null,
                        text,
                        { parse_mode: 'Markdown' }
                    ).catch(e => { /* Ignore edit errors */ });
                }
            }, () => `📤 *Uploading Folder to Telegram*\n\n✅ Sent: ${sentCount}/${result.fileCount}\n❌ Failed: ${failedCount}`, result.files.length);

            for (let i = 0; i < result.files.length; i++) {
                const file = result.files[i];
                try {
                    if (file.size > maxFileSize) {
                        failedCount++;
                        if (progressMsg) folderUploadUpdater(1, file.name, file.size, i + 1);
                        continue;
                    }

                    await sendTelegramFile(ctx, file.path, file.name, file.size, (progress) => {
                        folderUploadUpdater(progress, file.name, file.size, i + 1);
                    }, uploadDestination);

                    sentCount++;

                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (fileError) {
                    console.error(`Failed to send ${file.name}:`, fileError.message);
                    failedCount++;
                }
            }

            if (progressMsg) {
                try {
                    await ctx.telegram.deleteMessage(chatId, progressMsg.message_id);
                } catch (e) {
                    console.error('Cannot delete progress message:', e.message);
                }
            }

            cleanupFolder(result.folderPath);

            let summary = `✅ *Folder Transfer Complete!*\n\n`;
            summary += `📁 *Folder:* \`${path.basename(result.folderPath)}\`\n`;
            summary += `📊 *Total Files:* ${result.fileCount}\n`;
            summary += `✅ *Sent Successfully:* ${sentCount}\n`;

            if (failedCount > 0) {
                summary += `❌ *Failed/Skipped:* ${failedCount} (files >2GB)\n`;
            }

            summary += `💾 *Total Size:* ${formatBytes(result.totalSize)}`;
            if (sendingToChannel) summary += `\n📤 *Sent to your configured channel*`;

            try {
                await ctx.reply(summary, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error('Cannot send summary:', e.message);
            }

            // Cleanup temp directory
            const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
            cleanupFolder(tempDir);
        }

    } catch (error) {
        console.error('❌ Main error:', error.message);
        logError('MEGA download', error);

        let errorMessage = `❌ *Download Failed*\n\n`;
        errorMessage += `*Error:* ${error.message}\n\n`;
        errorMessage += `*Please check:*\n`;
        errorMessage += `1. Link is correct and not expired\n`;
        errorMessage += `2. Includes #key at the end\n`;
        errorMessage += `3. File/folder exists`;

        try {
            await ctx.reply(errorMessage, { parse_mode: 'Markdown' });
        } catch (sendError) {
            console.error('Cannot send error message:', sendError.message);
        }

        const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
        cleanupFolder(tempDir);
    }
}

bot.start(async (ctx) => {
    const chatType = ctx.chat.type;

    // Deep-link from an auto-post's "🎬 Get Full Video" button: deliver that
    // one specific video, gated exactly like /random (force-sub, cooldown,
    // daily limit, VIP, auto-delete) via sendSingleSharedFile.
    if (chatType === 'private' && ctx.startPayload && ctx.startPayload.startsWith('get-')) {
        const decoded = decodeFileTag(ctx.startPayload);
        if (decoded) {
            await sendSingleSharedFile(ctx, decoded.chatId, decoded.messageId);
            return;
        }
    }

    if (chatType !== 'private') {
        const chatName = `in this ${chatType}`;
        await ctx.reply(`🤖 *MEGA Downloader Bot*

*I can download MEGA files and folders ${chatName}!*

Just send me any MEGA link and I'll download it.

*Features:*
• Works in private chats, groups, and channels
• Downloads files and folders
• Auto-detects file types
• Shows progress
• Automatic cleanup

*Supported Formats:*
• \`https://mega.nz/file/ID#KEY\`
• \`https://mega.nz/folder/ID#KEY\`

*For Groups/Channels:*
1. Add me as admin
2. Give me permission to read messages
3. Send MEGA link in chat
4. I'll download and send files directly

Send me a MEGA link to get started!`, {
            parse_mode: 'Markdown'
        });
        return;
    }

    // Private chat — admins get a management menu, everyone else gets the force-sub gate
    if (isAdmin(ctx.from.id)) {
        await ctx.reply(ADMIN_START_TEXT, { reply_markup: ADMIN_START_KEYBOARD });
        return;
    }

    // Referral: /start ref_<referrerId> deep link. Must check isNewUser BEFORE
    // any call below creates this user's record, so only genuine first-time
    // signups count toward the referrer's bonus.
    const wasNewUser = isNewUser(ctx.from.id);
    const payload = ctx.startPayload;
    if (wasNewUser && payload && payload.startsWith('ref_')) {
        const referrerId = payload.slice(4);
        const result = registerReferral(ctx.from.id, referrerId);
        if (result.success) {
            try {
                await ctx.telegram.sendMessage(
                    result.referrerId,
                    `🎉 Someone joined using your referral link!\n\n💎 +${result.bonus} bonus file credit(s)\n👥 Total referrals: ${result.referralCount}`
                );
            } catch (e) { /* referrer may have blocked the bot — ignore */ }
        }
    }

    const config = loadConfig();
    if (config.forceSubGroupIds.length === 0) {
        await ctx.reply('👋 Welcome! Send /random to get files.', { reply_markup: MY_STATS_KEYBOARD });
        return;
    }

    const unjoined = await getUnjoinedGroups(ctx, config.forceSubGroupIds, ctx.from.id);
    if (unjoined.length > 0) {
        await sendJoinPrompt(ctx, unjoined);
        return;
    }

    await ctx.reply('✅ You\'re already a member! Send /random to get files.', { reply_markup: MY_STATS_KEYBOARD });
});

bot.help((ctx) => {
    const chatType = ctx.chat.type;

    if (chatType === 'private') {
        ctx.reply(`📖 *Help - Private Chat*

Just send me any MEGA link and I'll download it for you!

*Valid link formats:*
✅ \`https://mega.nz/file/ABC123#XYZ456\`
✅ \`https://mega.nz/folder/DEF789#UVW012\`

*Requirements:*
• Link must include #key at the end
• File size must be under 2GB for Telegram`, {
            parse_mode: 'Markdown'
        });
    } else {
        ctx.reply(`📖 *Help - ${chatType === 'group' ? 'Group' : 'Channel'}*

I can download MEGA files here too!

*IMPORTANT: For me to work in this ${chatType}:*
1. I must be added as admin
2. I need permission to read messages
3. I need permission to send messages/media

*How to use:*
Just send any MEGA link in chat, I'll process it automatically.

*Link formats:*
• \`https://mega.nz/file/ID#KEY\`
• \`https://mega.nz/folder/ID#KEY\``, {
            parse_mode: 'Markdown'
        });
    }
});

// ===== Force-Sub File Sharing Feature =====
// Files are tracked by (chat_id, message_id) from the source group and
// shared to users via copyMessage — no file_id stored, no "Forwarded from" tag.

async function checkMembership(ctx, groupId, userId) {
    const settings = getForceSubSettings(groupId);
    if (settings.mode === 'pending') {
        // "Pending" groups never actually let the user in (or only after a
        // delay) — sending the join request itself is treated as proof,
        // UNLESS Telegram has since actually approved them into the group
        // (delayHours elapsed, or an admin approved manually). Once that
        // happens, a stale "requested once" record shouldn't grant access
        // forever — re-verify live so a quick join-then-leave doesn't keep
        // unlocking files after they've left.
        if (!hasJoinRequest(groupId, userId)) return false;
        if (isJoinRequestApproved(groupId, userId)) {
            try {
                const member = await ctx.telegram.getChatMember(groupId, userId);
                return ['member', 'administrator', 'creator'].includes(member.status);
            } catch (error) {
                console.error('Membership recheck failed:', error.message);
                return false; // fail closed — don't trust a stale request over a failed live check
            }
        }
        return true;
    }
    try {
        const member = await ctx.telegram.getChatMember(groupId, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error('Membership check failed:', error.message);
        return false;
    }
}

async function getUnjoinedGroups(ctx, groupIds, userId) {
    const unjoined = [];
    for (const groupId of groupIds) {
        const isMember = await checkMembership(ctx, groupId, userId);
        if (!isMember) unjoined.push(groupId);
    }
    return unjoined;
}

// Returns a cached "request to join" invite link for this force-sub group,
// creating (and persisting) one the first time it's needed. Using
// creates_join_request:true means tapping the link never drops the user
// straight into the channel — it queues a join request that we auto-approve
// in the chat_join_request handler below.
async function getOrCreateJoinRequestLink(ctx, groupId) {
    const config = loadConfig();
    if (!config.forceSubInviteLinks) config.forceSubInviteLinks = {};
    const cached = config.forceSubInviteLinks[groupId];
    if (cached) return cached;

    const link = await ctx.telegram.createChatInviteLink(groupId, {
        creates_join_request: true,
        name: 'Bot force-sub link'
    });
    config.forceSubInviteLinks[groupId] = link.invite_link;
    saveConfig(config);
    return link.invite_link;
}

async function sendJoinPrompt(ctx, groupIds) {
    const buttons = [];
    for (const groupId of groupIds) {
        try {
            const chat = await ctx.telegram.getChat(groupId);
            let inviteLink;
            try {
                inviteLink = await getOrCreateJoinRequestLink(ctx, groupId);
            } catch (linkError) {
                console.error(`Join-request link failed for ${groupId}, falling back to instant-join link:`, linkError.message);
                inviteLink = chat.invite_link || await ctx.telegram.exportChatInviteLink(groupId);
            }
            buttons.push([{ text: `➡️ Request to Join ${chat.title || 'Group'}`, url: inviteLink }]);
        } catch (error) {
            console.error(`Could not generate invite link for ${groupId}:`, error.message);
        }
    }

    if (buttons.length === 0) {
        await ctx.reply('⚠️ You need to join the required group(s), but I could not generate an invite link. Please contact the admin.');
        return;
    }

    const config = loadConfig();
    if (config.vipChannelLink) {
        buttons.push([{ text: '💎 Skip — Get VIP Instead', callback_data: 'vip_info' }]);
    }
    buttons.push([{ text: '✅ I\'ve Joined — Verify', callback_data: 'recheck_sub' }]);

    await ctx.reply('🔒 *Tap below to request access — then tap Verify*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    });
}

// Per-user mutex for the file-share send flow (force-sub check → cooldown/
// daily-limit check → pick unseen file(s) → send → mark seen). Without this,
// a rapid double-tap on "🎬 Free Video" / the channel "Get Full Video" button
// fires two overlapping requests: both read the same "unseen" list and the
// same cooldown state before either has finished writing back to disk, so
// the same video can be picked and sent twice, or the cooldown/daily-limit
// check can be bypassed on the second tap. Acquired by the caller
// (handleRandomRequest, recheck_sub, sendSingleSharedFile) around the whole
// flow — not inside sendRandomFiles itself — so the lock also covers the
// checkRandomAllowed() call, not just the send.
const fileShareLocks = new Set();

function acquireFileShareLock(userId) {
    if (fileShareLocks.has(userId)) return false;
    fileShareLocks.add(userId);
    return true;
}

function releaseFileShareLock(userId) {
    fileShareLocks.delete(userId);
}

// Schedules a sent file for auto-deletion after `minutes`. Uses an in-memory
// setTimeout for prompt deletion while the process stays alive, but also
// persists the schedule to disk (schedulePendingDeletion) so a pm2 restart,
// crash, or redeploy that happens before the timer fires doesn't lose it —
// the periodic sweep in the startup block below finishes the job instead.
function scheduleAutoDelete(chatId, messageId, minutes) {
    if (!minutes || minutes <= 0) return;
    const deleteAt = Date.now() + minutes * 60 * 1000;
    schedulePendingDeletion(chatId, messageId, deleteAt);
    setTimeout(async () => {
        try {
            await bot.telegram.deleteMessage(chatId, messageId);
        } catch (e) { /* already deleted / inaccessible — fine */ }
        removePendingDeletion(chatId, messageId);
    }, minutes * 60 * 1000);
}

// Picks up to `count` files this user hasn't seen yet, sends them via
// copyMessage (no forward tag), marks them seen, and self-heals dead entries.
// Caller must hold this user's fileShareLock (see acquireFileShareLock).
async function sendRandomFiles(ctx) {
    const config = loadConfig();
    const unseen = getUnseenFiles(ctx.from.id);

    if (unseen.length === 0) {
        await ctx.reply('🎉 You\'ve received all the files currently available! Check back later for new ones.', { reply_markup: MY_STATS_KEYBOARD });
        return;
    }

    const shuffled = [...unseen].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(config.shareCount, shuffled.length));
    const successfullySent = [];

    for (const file of picked) {
        try {
            const sent = await ctx.telegram.copyMessage(ctx.chat.id, file.chat_id, file.message_id,
                config.protectContent ? { protect_content: true } : {});
            successfullySent.push(file);

            scheduleAutoDelete(ctx.chat.id, sent.message_id, config.autoDeleteMinutes);
        } catch (error) {
            console.error('Failed to copy shared file:', error.message);
            // Original message is gone (deleted) — remove it so it's not picked again
            if (error.message && error.message.includes('message to copy not found')) {
                removeSharedFile(file.chat_id, file.message_id);
            }
        }
    }

    if (successfullySent.length > 0) {
        markSeen(ctx.from.id, successfullySent);
        if (config.autoDeleteMinutes > 0) {
            await ctx.reply(`⏳ These file(s) will auto-delete in ${config.autoDeleteMinutes} minute(s).`, { reply_markup: MY_STATS_KEYBOARD });
        } else {
            await ctx.reply('📊 Tap below to check your stats.', { reply_markup: MY_STATS_KEYBOARD });
        }
    } else {
        await ctx.reply('❌ Could not send the file(s), please try again.', { reply_markup: MY_STATS_KEYBOARD });
    }
}

// Delivers exactly one specific shared file, gated the same way /random is:
// force-sub check, then cooldown/daily-limit/VIP check, then send with
// auto-delete scheduling. Used by the "get-<tag>" deep link (the channel
// autopost's "🎬 Get Full Video" button), which previously bypassed all of
// this — free users coming from that button had no daily limit, no cooldown,
// and no auto-delete at all.
async function sendSingleSharedFile(ctx, sourceChatId, sourceMessageId) {
    const userId = ctx.from.id;
    if (!acquireFileShareLock(userId)) return; // duplicate tap while a request is already in flight — ignore
    try {
        const config = loadConfig();
        const isAdminUser = isAdmin(userId);

        if (!isAdminUser && config.forceSubGroupIds.length > 0) {
            const unjoined = await getUnjoinedGroups(ctx, config.forceSubGroupIds, userId);
            if (unjoined.length > 0) {
                await sendJoinPrompt(ctx, unjoined);
                return;
            }
        }

        // Admins can tap their own "Get Full Video" links (e.g. to preview an
        // autopost) without being subject to the same cooldown/daily-limit
        // meant for regular free users.
        if (!isAdminUser) {
            const check = checkRandomAllowed(userId, config);
            if (!check.allowed) {
                if (check.reason === 'cooldown') {
                    await ctx.reply(`⏳ Please wait ${check.retryAfter} second(s) and try again.`);
                } else {
                    await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow, or use /myreferral to earn bonus credits.`,
                        config.vipChannelLink ? { reply_markup: { inline_keyboard: [[{ text: '💎 Buy VIP — No Limits', callback_data: 'vip_info' }]] } } : undefined);
                }
                return;
            }
            if (check.usedBonus) {
                await ctx.reply('💎 Used 1 bonus credit (daily limit reached).');
            }
        }

        try {
            const sent = await ctx.telegram.copyMessage(ctx.chat.id, sourceChatId, sourceMessageId,
                config.protectContent ? { protect_content: true } : {});
            scheduleAutoDelete(ctx.chat.id, sent.message_id, config.autoDeleteMinutes);
            if (config.autoDeleteMinutes > 0) {
                await ctx.reply(`⏳ This file will auto-delete in ${config.autoDeleteMinutes} minute(s).`, { reply_markup: MY_STATS_KEYBOARD });
            }
        } catch (error) {
            console.error('Failed to copy single shared file:', error.message);
            if (error.message && error.message.includes('message to copy not found')) {
                removeSharedFile(sourceChatId, sourceMessageId);
            }
            await ctx.reply('❌ Sorry, this file is no longer available.');
        }
    } finally {
        releaseFileShareLock(userId);
    }
}

// --- User-facing: My Stats & Referrals ---
const MY_STATS_KEYBOARD = {
    inline_keyboard: [
        [{ text: '💎 Buy VIP', callback_data: 'vip_info' }, { text: '🎬 Free Video', callback_data: 'user_random' }],
        [{ text: '📂 VIP Categories', callback_data: 'user_categories' }, { text: '📊 My Stats', callback_data: 'user_mystats' }],
        [{ text: '🎁 Invite & Earn', callback_data: 'user_referral' }, { text: '🎟 Redeem Code', callback_data: 'user_redeem' }],
        [{ text: 'ℹ️ About', callback_data: 'user_about' }]
    ]
};

// Minimal HTML-escaping for admin-supplied text/URLs dropped into an
// HTML-parse-mode message (About panel link text, join-group link, VIP
// promo text, etc).
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Minimal Markdown-escaping for admin-supplied text (category names, etc.)
// dropped into a parse_mode:'Markdown' message — without this, a name
// containing _ * ` [ ] can silently break formatting or swallow the rest
// of the message.
function escapeMd(str) {
    return String(str).replace(/([_*`\[\]])/g, '\\$1');
}

// "💎 Buy VIP" — the main promo entry point. Shown on /start, the About
// panel, and at the two moments a free user actually hits friction (daily
// limit reached, force-sub gate) rather than on every single file delivery,
// so it reads as a helpful upsell instead of spam.
bot.action('vip_info', async (ctx) => {
    await ctx.answerCbQuery();
    recordVipClick(ctx.from.id);
    const config = loadConfig();

    if (!config.vipChannelLink) {
        await ctx.reply('⚠️ VIP is not set up yet. Please check back soon.');
        return;
    }

    let text = '💎 <b>VIP Access</b>';
    if (config.vipPromoText) {
        text += `\n\n${escapeHtml(config.vipPromoText)}`;
    }

    await ctx.reply(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '🛒 BUY NOW', url: config.vipChannelLink }]] }
    });
});

// Public-facing "About" panel — shown to any regular user who taps ℹ️ About
// on /start. Creator credit + tech stack are fixed; the join-group button
// and the clickable hyperlink (text + url) are admin-configurable via the
// File Sharing → About/Start Message panel.
bot.action('user_about', async (ctx) => {
    await ctx.answerCbQuery();
    const config = loadConfig();

    let text = '🤖 <b>About This Bot</b>\n\n' +
        '👤 Creator: @mr_boomsir\n' +
        '⚙️ Built with: Node.js, Telegraf, GramJS (MTProto), MEGA API';

    if (config.aboutLinkUrl) {
        const linkText = escapeHtml(config.aboutLinkText || 'Click Here');
        text += `\n\n<a href="${escapeHtml(config.aboutLinkUrl)}">${linkText}</a>`;
    }

    const keyboard = { inline_keyboard: [] };
    if (config.vipChannelLink) {
        keyboard.inline_keyboard.push([{ text: '💎 Buy VIP', callback_data: 'vip_info' }]);
    }
    if (config.aboutJoinGroupLink) {
        keyboard.inline_keyboard.push([{ text: '👥 Join Group', url: config.aboutJoinGroupLink }]);
    }

    await ctx.reply(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {})
    });
});

// --- User-facing: VIP Categories (browse-only; management is admin-only) ---
// A category is only ever reachable here if it currently has ≥1 video (see
// listNonEmptyCategories) and the requester passes BOTH gates below — the
// same force-sub check every other file feature uses, then active VIP
// status. The VIP/force-sub checks are repeated again inside catv_open
// itself (not just here) since callback_data on an old message could in
// principle be re-tapped after VIP lapses or before force-sub is verified —
// hiding the button is a UX nicety, not the actual security boundary.
const CAT_BROWSE_BATCH_SIZE = 5;

async function sendCategoryList(ctx) {
    const categories = listNonEmptyCategories();
    if (categories.length === 0) {
        await ctx.reply('📂 No VIP categories are available yet — check back soon!');
        return;
    }
    const rows = categories.slice(0, 30).map(c => [{ text: `📁 ${c.name} (${c.videos.length})`, callback_data: `catv_open:${c.id}:0` }]);
    await ctx.reply('📂 *VIP Categories* — tap one to browse:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

bot.action('user_categories', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const isAdminUser = isAdmin(userId);
    const config = loadConfig();

    if (!isAdminUser && config.forceSubGroupIds.length > 0) {
        const unjoined = await getUnjoinedGroups(ctx, config.forceSubGroupIds, userId);
        if (unjoined.length > 0) {
            await sendJoinPrompt(ctx, unjoined);
            return;
        }
    }

    if (!isAdminUser && !isUserVip(userId)) {
        const keyboard = { inline_keyboard: [] };
        if (config.vipChannelLink) keyboard.inline_keyboard.push([{ text: '💎 Buy VIP', callback_data: 'vip_info' }]);
        await ctx.reply(
            '🔒 *VIP Categories* are exclusive to active VIP members.\n\n' +
            'Upgrade to VIP to unlock curated video categories not available through 🎬 Free Video.',
            { parse_mode: 'Markdown', ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}) }
        );
        return;
    }

    await sendCategoryList(ctx);
});

// Delivers up to CAT_BROWSE_BATCH_SIZE videos starting at `offset`, then a
// small control message with ▶️ Next (if more remain) and a way back.
bot.action(/^catv_open:(.+):(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const isAdminUser = isAdmin(userId);
    const config = loadConfig();

    if (!isAdminUser && config.forceSubGroupIds.length > 0) {
        const unjoined = await getUnjoinedGroups(ctx, config.forceSubGroupIds, userId);
        if (unjoined.length > 0) {
            await ctx.answerCbQuery();
            await sendJoinPrompt(ctx, unjoined);
            return;
        }
    }
    if (!isAdminUser && !isUserVip(userId)) {
        await ctx.answerCbQuery('🔒 VIP members only.', { show_alert: true });
        return;
    }

    const categoryId = ctx.match[1];
    const offset = parseInt(ctx.match[2], 10);
    const category = getCategory(categoryId);
    if (!category || category.videos.length === 0) {
        await ctx.answerCbQuery('⚠️ Category unavailable.', { show_alert: true });
        return;
    }
    await ctx.answerCbQuery();

    const videos = category.videos;
    const batch = videos.slice(offset, offset + CAT_BROWSE_BATCH_SIZE);
    if (batch.length === 0) {
        // Category shrank (videos removed) between page taps — nothing left
        // at this offset. Send them back to the start rather than a
        // confusing empty/blank result.
        await ctx.reply('📁 No more videos here — back to the start.', {
            reply_markup: { inline_keyboard: [[{ text: '🔄 Restart Category', callback_data: `catv_open:${category.id}:0` }, { text: '📂 All Categories', callback_data: 'user_categories' }]] }
        });
        return;
    }
    const sendOpts = config.protectContent ? { protect_content: true } : {};

    for (const v of batch) {
        try {
            if (v.chat_id && v.message_id) {
                // Normal path: copy the archived post from the storage
                // channel — no re-upload, no "Forwarded from" tag. Caption
                // is explicitly overridden with the ORIGINAL caption we
                // recorded (not the "🏷 Category" tag added on the storage
                // copy for the admin's own browsing) so VIP users never see
                // that internal tag; passing '' when there was none clears
                // it instead of inheriting the tagged one. Self-heals below
                // if the storage post was ever removed.
                await ctx.telegram.copyMessage(ctx.chat.id, v.chat_id, v.message_id, { ...sendOpts, caption: v.caption || '' });
            } else if (v.file_id) {
                // Legacy fallback for videos added before the storage
                // channel existed (raw file_id, no channel pointer).
                if (v.type === 'photo') {
                    await ctx.telegram.sendPhoto(ctx.chat.id, v.file_id, { ...sendOpts, caption: v.caption || undefined });
                } else if (v.type === 'animation') {
                    await ctx.telegram.sendAnimation(ctx.chat.id, v.file_id, { ...sendOpts, caption: v.caption || undefined });
                } else {
                    await ctx.telegram.sendVideo(ctx.chat.id, v.file_id, { ...sendOpts, caption: v.caption || undefined });
                }
            }
        } catch (error) {
            console.error(`Failed to deliver category video ${v.id} in "${category.name}":`, error.message);
            // Storage channel post is gone (deleted) — self-heal by
            // forgetting this entry so it's never picked again.
            if (v.chat_id && v.message_id && error.message && error.message.includes('message to copy not found')) {
                removeCategoryVideoByMessage(v.chat_id, v.message_id);
            }
        }
    }

    const nextOffset = offset + CAT_BROWSE_BATCH_SIZE;
    const nav = [];
    if (nextOffset < videos.length) {
        nav.push({ text: `▶️ Next ${Math.min(CAT_BROWSE_BATCH_SIZE, videos.length - nextOffset)}`, callback_data: `catv_open:${category.id}:${nextOffset}` });
    }
    nav.push({ text: '📂 All Categories', callback_data: 'user_categories' });

    await ctx.reply(`📁 *${escapeMd(category.name)}* — showing ${Math.min(offset + batch.length, videos.length)}/${videos.length}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [nav] }
    });
});

function formatMyStats(userId) {
    const config = loadConfig();
    const s = getUserStats(userId, config.cooldownSeconds, config.dailyLimit);
    const vip = getVipInfo(userId);

    let cooldownLine = '✅ Ready now';
    if (s.cooldownRemaining > 0) {
        cooldownLine = `⏳ ${s.cooldownRemaining}s remaining`;
    }

    let dailyLine = '♾️ Unlimited';
    if (s.dailyRemaining !== null) {
        dailyLine = `${s.dailyRemaining} left today`;
    }

    let vipLine = '❌ Not active';
    if (vip.active) {
        vipLine = vip.unlimited ? '✅ Active — Lifetime' : `✅ Active — ${vip.daysLeft} day(s) left`;
    }

    return `📊 *Your Stats*\n\n` +
        `Files received (all-time): ${s.totalFilesReceived}\n` +
        `/random requests today: ${s.requestsToday}\n` +
        `Cooldown: ${cooldownLine}\n` +
        `Daily limit: ${dailyLine}\n\n` +
        `💎 VIP: ${vipLine}\n` +
        `👥 Referrals: ${s.referralCount}\n` +
        `💎 Bonus credits: ${s.bonusCredits} (skip cooldown/daily-limit)`;
}

bot.command('mystats', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply(formatMyStats(ctx.from.id), { parse_mode: 'Markdown' });
});

bot.action('user_mystats', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(formatMyStats(ctx.from.id), { parse_mode: 'Markdown' });
});

async function formatMyReferral(ctx) {
    const username = ctx.botInfo?.username || botUsername;
    const link = `https://t.me/${username}?start=ref_${ctx.from.id}`;
    const stats = getReferralStats(ctx.from.id);
    const config = loadConfig();
    const text = `🎁 <b>Invite &amp; Earn</b>\n\n` +
        `Share your link — each friend who joins through it (for the first time) gives you <b>+${config.referralBonus} bonus file credit(s)</b>.\n` +
        `Bonus credits let you use /random even after your daily limit or cooldown.\n\n` +
        `🔗 <code>${link}</code>\n\n` +
        `👥 Referrals so far: ${stats.referralCount}\n` +
        `💎 Bonus credits available: ${stats.bonusCredits}`;

    const shareText = `🎁 Get free files! Join via my link:`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`;
    const replyMarkup = { inline_keyboard: [
        [{ text: '📤 Share with Friends', url: shareUrl }],
        [{ text: '🏆 Leaderboard', callback_data: 'user_leaderboard' }]
    ] };

    return { text, replyMarkup };
}

bot.command('myreferral', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const { text, replyMarkup } = await formatMyReferral(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: replyMarkup });
});

// --- User-facing: Redeem Promo Code ---
async function handleRedeemCode(ctx, code) {
    const result = redeemPromoCode(ctx.from.id, code);
    if (!result.success) {
        const messages = {
            not_found: '❌ That code doesn\'t exist. Check the spelling and try again.',
            already_used: '⚠️ You\'ve already redeemed this code.',
            limit_reached: '⚠️ This code has reached its maximum number of uses.'
        };
        await ctx.reply(messages[result.reason] || '❌ Could not redeem that code.');
        return;
    }
    const durationText = result.unlimited ? 'Lifetime (never expires)' : `${result.days} day(s)`;
    await ctx.reply(`🎉 Code redeemed! You now have 💎 VIP access.\n\nDuration: ${durationText}\nEnjoy unlimited /random requests with no cooldown!`);
}

bot.command('redeem', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
        pendingAction[ctx.from.id] = { type: 'redeem_code' };
        await ctx.reply('🎟 Send the promo code you want to redeem, or /cancel.');
        return;
    }
    await handleRedeemCode(ctx, parts[1]);
});

bot.action('user_redeem', async (ctx) => {
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'redeem_code' };
    await ctx.reply('🎟 Send the promo code you want to redeem, or /cancel.');
});

bot.action('user_referral', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, replyMarkup } = await formatMyReferral(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: replyMarkup });
});

// Anonymized all-time referral leaderboard — shows last 4 digits of each
// top referrer's Telegram ID (never username/name), plus the viewer's own
// rank so it stays motivating without exposing anyone's identity.
bot.action('user_leaderboard', async (ctx) => {
    await ctx.answerCbQuery();
    const top = getTopReferrers(10);
    const medal = ['🥇', '🥈', '🥉'];
    let text = '🏆 <b>Top Referrers</b>\n\n';

    if (top.length === 0) {
        text += '_No referrals yet — be the first!_';
    } else {
        text += top.map((r, i) => {
            const rank = medal[i] || `${i + 1}.`;
            const last4 = String(r.id).slice(-4);
            return `${rank} User ****${last4} — ${r.count} referral(s)`;
        }).join('\n');
    }

    const mine = getReferrerRank(ctx.from.id);
    text += '\n\n';
    text += mine.rank
        ? `👤 Your rank: #${mine.rank} (${mine.count} referral(s))`
        : `👤 You haven't referred anyone yet — share your link to get on the board!`;

    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🎁 Back to Invite & Earn', callback_data: 'user_referral' }]] }
    });
});

// --- Admin: force-sub group management ---
bot.command('setforcesub', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (ctx.chat.type === 'private') {
        await ctx.reply('⚠️ Run this command inside the group you want to use for force-sub.');
        return;
    }
    const config = loadConfig();
    if (!config.forceSubGroupIds.includes(ctx.chat.id)) {
        config.forceSubGroupIds.push(ctx.chat.id);
        saveConfig(config);
    }
    await ctx.reply(`✅ Added "${ctx.chat.title}" as a force-sub group.\n\nTotal force-sub groups: ${config.forceSubGroupIds.length}`);
});

bot.command('unsetforcesub', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (ctx.chat.type === 'private') {
        await ctx.reply('⚠️ Run this command inside the group you want to remove.');
        return;
    }
    const config = loadConfig();
    config.forceSubGroupIds = config.forceSubGroupIds.filter(id => id !== ctx.chat.id);
    if (config.forceSubInviteLinks) delete config.forceSubInviteLinks[ctx.chat.id];
    saveConfig(config);
    await ctx.reply(`✅ Removed "${ctx.chat.title}" from the force-sub list.`);
});

bot.command('listforcesub', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const config = loadConfig();
    if (config.forceSubGroupIds.length === 0) {
        await ctx.reply('No force-sub groups set yet.');
        return;
    }
    const lines = await Promise.all(config.forceSubGroupIds.map(async (id) => {
        try {
            const chat = await ctx.telegram.getChat(id);
            return `• ${chat.title} (${id})`;
        } catch (e) {
            return `• ${id} (unreachable)`;
        }
    }));
    await ctx.reply(`📋 Force-Sub Groups:\n\n${lines.join('\n')}`);
});

bot.command('setsource', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (ctx.chat.type === 'private') {
        await ctx.reply('⚠️ Run this command inside the source group.');
        return;
    }
    const config = loadConfig();
    config.sourceGroupId = ctx.chat.id;
    saveConfig(config);
    await ctx.reply(`✅ Set "${ctx.chat.title}" as the source group.\n\nPhoto/video files posted here by admins will now be tracked automatically.`);
});

bot.command('setlogchannel', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (ctx.chat.type === 'private') {
        await ctx.reply('⚠️ Run this command inside the group/channel you want errors sent to.\n\nAdd the bot there as admin first.');
        return;
    }
    const config = loadConfig();
    config.errorLogChatId = ctx.chat.id;
    saveConfig(config);
    await ctx.reply(`✅ "${ctx.chat.title}" set as the error log channel. Bot errors will be posted here from now on.`);
});

bot.command('unsetlogchannel', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const config = loadConfig();
    config.errorLogChatId = null;
    saveConfig(config);
    await ctx.reply('✅ Error log channel removed. Errors will only go to console now.');
});

// --- Admin: config backup ---
// Zips every persisted JSON data file. Shared by the /backupconfig command
// and the daily auto-backup scheduler below. Caller owns the returned zip
// file and must delete it once done (sent as a document, then cleaned up).
async function buildConfigBackupZip() {
    const files = getConfigBackupFiles();
    if (files.length === 0) return null;

    const backupDir = path.join(os.tmpdir(), 'mega-bot-backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = path.join(backupDir, `config-backup-${timestamp}.zip`);

    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        for (const file of files) {
            archive.file(file.path, { name: file.name });
        }
        archive.finalize();
    });

    return { zipPath, filename: `config-backup-${timestamp}.zip`, fileCount: files.length, fileNames: files.map(f => f.name) };
}

// Zips every persisted JSON data file and sends it to the admin, so a
// corrupted file / bad Termux kill / accidental delete can be restored
// from a known-good snapshot instead of starting over from defaults.
bot.command('backupconfig', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;

    const files = getConfigBackupFiles();
    if (files.length === 0) {
        await ctx.reply('⚠️ No config files found to back up yet.');
        return;
    }

    await ctx.reply(`📦 Backing up ${files.length} config file(s)...`);

    let backup;
    try {
        backup = await buildConfigBackupZip();
        await ctx.replyWithDocument(
            { source: backup.zipPath, filename: backup.filename },
            { caption: `✅ ${backup.fileCount} file(s): ${backup.fileNames.join(', ')}` }
        );
    } catch (error) {
        console.error('Backup failed:', error.message);
        await ctx.reply(`❌ Backup failed: ${error.message}`);
        await logError('backupconfig', error);
    } finally {
        if (backup) {
            try { if (fs.existsSync(backup.zipPath)) fs.unlinkSync(backup.zipPath); } catch (e) { /* ignore */ }
        }
    }
});

// Sends a config backup to the log channel automatically once per IST
// calendar day — so a corrupted/lost data file can be restored even if the
// admin forgets to run /backupconfig manually. Silently no-ops until a log
// channel is set (/setlogchannel) since there'd be nowhere to send it.
let lastAutoBackupDate = null;
async function checkAutoBackup() {
    const config = loadConfig();
    if (!config.errorLogChatId) return;

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // "YYYY-MM-DD" in IST
    if (lastAutoBackupDate === todayStr) return;
    lastAutoBackupDate = todayStr;

    let backup;
    try {
        backup = await buildConfigBackupZip();
        if (!backup) return; // nothing to back up yet
        await bot.telegram.sendDocument(
            config.errorLogChatId,
            { source: backup.zipPath, filename: backup.filename },
            { caption: `🗄 *Daily Auto-Backup* — ${backup.fileCount} file(s), ${todayStr} IST`, parse_mode: 'Markdown' }
        );
    } catch (error) {
        logError('Auto config backup', error);
    } finally {
        if (backup) {
            try { if (fs.existsSync(backup.zipPath)) fs.unlinkSync(backup.zipPath); } catch (e) { /* ignore */ }
        }
    }
}

// --- Admin: settings ---
bot.command('setcount', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const n = parseInt(ctx.message.text.split(' ')[1], 10);
    if (!n || n < 1) {
        await ctx.reply('Usage: `/setcount 3`', { parse_mode: 'Markdown' });
        return;
    }
    const config = loadConfig();
    config.shareCount = n;
    saveConfig(config);
    await ctx.reply(`✅ Each /random request will now send ${n} file(s).`);
});

bot.command('setcooldown', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const n = parseInt(ctx.message.text.split(' ')[1], 10);
    if (isNaN(n) || n < 0) {
        await ctx.reply('Usage: `/setcooldown 15` (seconds, 0 = no cooldown)', { parse_mode: 'Markdown' });
        return;
    }
    const config = loadConfig();
    config.cooldownSeconds = n;
    saveConfig(config);
    await ctx.reply(`✅ Cooldown set to ${n} second(s).`);
});

// Manually grant/revoke VIP by user ID — for when the admin wants to give
// VIP directly without going through a redeemable promo code.
bot.command('grantvip', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const parts = ctx.message.text.split(' ');
    const targetId = parts[1];
    const days = parseInt(parts[2], 10);
    if (!targetId || isNaN(days) || days < 0) {
        await ctx.reply('Usage: `/grantvip 123456789 30` (30 days) or `/grantvip 123456789 0` (lifetime)', { parse_mode: 'Markdown' });
        return;
    }
    grantVip(targetId, days, 'manual', null);
    await ctx.reply(`✅ Granted ${days > 0 ? `${days} day(s)` : 'lifetime'} VIP to user \`${targetId}\`.`, { parse_mode: 'Markdown' });
});

bot.command('revokevip', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const targetId = ctx.message.text.split(' ')[1];
    if (!targetId) {
        await ctx.reply('Usage: `/revokevip 123456789`', { parse_mode: 'Markdown' });
        return;
    }
    revokeVip(targetId);
    await ctx.reply(`✅ VIP revoked for user \`${targetId}\`.`, { parse_mode: 'Markdown' });
});

bot.command('setreferralbonus', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const n = parseInt(ctx.message.text.split(' ')[1], 10);
    if (isNaN(n) || n < 0) {
        await ctx.reply('Usage: `/setreferralbonus 3` (bonus credits per referral, 0 = disable)', { parse_mode: 'Markdown' });
        return;
    }
    const config = loadConfig();
    config.referralBonus = n;
    saveConfig(config);
    await ctx.reply(`✅ Each successful referral now earns ${n} bonus credit(s).`);
});

bot.command('setdailylimit', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const n = parseInt(ctx.message.text.split(' ')[1], 10);
    if (isNaN(n) || n < 0) {
        await ctx.reply('Usage: `/setdailylimit 10` (0 = unlimited)', { parse_mode: 'Markdown' });
        return;
    }
    const config = loadConfig();
    config.dailyLimit = n;
    saveConfig(config);
    await ctx.reply(`✅ Daily limit set to ${n === 0 ? 'unlimited' : n + ' request(s)/day'}.`);
});

bot.command('setautodelete', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const n = parseInt(ctx.message.text.split(' ')[1], 10);
    if (isNaN(n) || n < 0) {
        await ctx.reply('Usage: `/setautodelete 30` (minutes, 0 = disabled)', { parse_mode: 'Markdown' });
        return;
    }
    const config = loadConfig();
    config.autoDeleteMinutes = n;
    saveConfig(config);
    await ctx.reply(`✅ Auto-delete ${n === 0 ? 'disabled' : 'set to ' + n + ' minute(s)'}.`);
});

// --- Admin: file pool management ---
bot.command('listfiles', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const files = loadSharedFiles();
    if (files.length === 0) {
        await ctx.reply('No files in the pool yet.');
        return;
    }
    const lines = files.slice(0, 50).map((f, i) => `${i}. ${f.type} — msg #${f.message_id} — ${f.added_at.slice(0, 10)}`);
    let msg = `📁 Files (${files.length} total, showing first 50):\n\n${lines.join('\n')}\n\n`;
    msg += 'To remove a file: `/delfile <index>`';
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('delfile', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const idx = parseInt(ctx.message.text.split(' ')[1], 10);
    if (isNaN(idx)) {
        await ctx.reply('Usage: `/delfile 3` (index from /listfiles)', { parse_mode: 'Markdown' });
        return;
    }
    const removed = deleteFileByIndex(idx);
    if (!removed) {
        await ctx.reply('❌ No file found at that index.');
        return;
    }
    await ctx.reply(`✅ Removed ${removed.type} (msg #${removed.message_id}).`);
});

// --- Admin: stats & broadcast ---
bot.command('stats', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const s = getStats();
    await ctx.reply(
        `📊 *Stats*\n\n` +
        `Total files: ${s.totalFiles}\n` +
        `Total users: ${s.totalUsers}\n` +
        `Requests today: ${s.requestsToday}`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('broadcast', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (ctx.chat.type !== 'private') return;
    const msg = ctx.message.text.split(' ').slice(1).join(' ');
    if (!msg) {
        await ctx.reply('Usage: `/broadcast your message`\n\nTip: you can also send a photo/video/GIF with a caption starting `/broadcast` to broadcast media, or use the 📢 Broadcast button in the admin panel.', { parse_mode: 'Markdown' });
        return;
    }
    if (getAllUserIds().length === 0) {
        await ctx.reply('No users have used /random yet.');
        return;
    }
    await runTextBroadcast(ctx, msg);
});

// Shared executor for a plain-text broadcast, used by /broadcast, the
// button flow, and scheduled broadcasts.
async function runTextBroadcast(ctx, text, meta = {}) {
    const userIds = getAllUserIds();
    const status = ctx ? await ctx.telegram.sendMessage(ctx.chat.id, `📢 Broadcasting to ${userIds.length} user(s)...`) : null;
    const result = await broadcastToUsers(
        (uid) => bot.telegram.sendMessage(uid, text),
        { kind: 'text', preview: text.slice(0, 80), by: meta.by || (ctx ? ctx.from.id : 'scheduler') }
    );
    const summary = `✅ Broadcast complete.\nSent: ${result.sent} | Blocked: ${result.blocked} | Failed: ${result.failed} (of ${result.total})`;
    if (status) await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, summary);
    return result;
}

// Shared executor for a media broadcast (photo/video/animation + caption).
async function runMediaBroadcast(ctx, kind, fileId, caption) {
    const userIds = getAllUserIds();
    const status = await ctx.reply(`📢 Broadcasting ${kind} to ${userIds.length} user(s)...`);
    const sendFn = (uid) => {
        const opts = caption ? { caption } : {};
        if (kind === 'photo') return bot.telegram.sendPhoto(uid, fileId, opts);
        if (kind === 'video') return bot.telegram.sendVideo(uid, fileId, opts);
        return bot.telegram.sendAnimation(uid, fileId, opts);
    };
    const result = await broadcastToUsers(sendFn, { kind, preview: (caption || '').slice(0, 80), by: ctx.from.id });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null,
        `✅ Broadcast complete.\nSent: ${result.sent} | Blocked: ${result.blocked} | Failed: ${result.failed} (of ${result.total})`);
    return result;
}

bot.command('broadcasthistory', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const history = getBroadcastHistory(10);
    if (history.length === 0) {
        await ctx.reply('No broadcasts sent yet.');
        return;
    }
    const lines = history.map(h => {
        const when = new Date(h.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        return `• ${when} — ${h.kind}${h.preview ? ` "${h.preview}"` : ''}\n  ✅${h.sent} ❌${h.failed} 🚫${h.blocked} / ${h.total}`;
    });
    await ctx.reply(`📜 *Last ${history.length} broadcasts*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
});

// /schedulebroadcast 2026-08-07 09:00 Your message here
bot.command('schedulebroadcast', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (ctx.chat.type !== 'private') return;
    const parts = ctx.message.text.split(' ');
    const dateStr = parts[1];
    const timeStr = parts[2];
    const text = parts.slice(3).join(' ');
    if (!dateStr || !timeStr || !text) {
        await ctx.reply('Usage: `/schedulebroadcast 2026-08-07 09:00 Your message`\n\nTime is IST (Asia/Kolkata).', { parse_mode: 'Markdown' });
        return;
    }
    // Interpret the given date/time as IST (UTC+5:30)
    const isoIst = `${dateStr}T${timeStr}:00+05:30`;
    const sendAt = new Date(isoIst);
    if (isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
        await ctx.reply('⚠️ Could not parse that date/time, or it\'s already in the past.');
        return;
    }
    const record = addScheduledBroadcast({ sendAt: sendAt.toISOString(), kind: 'text', text, createdBy: ctx.from.id });
    await ctx.reply(`⏰ Scheduled for ${sendAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.\nID: \`${record.id}\`\n\nCancel with \`/cancelbroadcast ${record.id}\``, { parse_mode: 'Markdown' });
});

bot.command('listscheduled', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const pending = getPendingScheduledBroadcasts();
    if (pending.length === 0) {
        await ctx.reply('No scheduled broadcasts pending.');
        return;
    }
    const lines = pending.map(s => `• \`${s.id}\` — ${new Date(s.sendAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST — "${(s.text || s.caption || '').slice(0, 50)}"`);
    await ctx.reply(`⏰ *Pending Scheduled Broadcasts*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

bot.command('cancelbroadcast', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const id = ctx.message.text.split(' ')[1];
    if (!id) {
        await ctx.reply('Usage: `/cancelbroadcast <id>` (see `/listscheduled`)', { parse_mode: 'Markdown' });
        return;
    }
    const ok = removeScheduledBroadcast(id);
    await ctx.reply(ok ? '✅ Cancelled.' : '❌ No scheduled broadcast found with that ID.');
});

// Checked every minute — fires any scheduled broadcast whose time has come.
async function processDueScheduledBroadcasts() {
    const due = getDueScheduledBroadcasts();
    for (const s of due) {
        try {
            if (s.kind === 'text') {
                await runTextBroadcast(null, s.text, { by: s.createdBy });
            } else {
                const userIds = getAllUserIds();
                const sendFn = (uid) => {
                    const opts = s.caption ? { caption: s.caption } : {};
                    if (s.kind === 'photo') return bot.telegram.sendPhoto(uid, s.fileId, opts);
                    if (s.kind === 'video') return bot.telegram.sendVideo(uid, s.fileId, opts);
                    return bot.telegram.sendAnimation(uid, s.fileId, opts);
                };
                await broadcastToUsers(sendFn, { kind: s.kind, preview: (s.caption || '').slice(0, 80), by: s.createdBy, scheduled: true });
            }
            markScheduledBroadcastSent(s.id);
        } catch (error) {
            logError('Scheduled broadcast', error);
            markScheduledBroadcastSent(s.id); // don't retry-loop a broken entry forever
        }
    }
}

// --- User-facing ---
// Wraps recordRequest(): if the daily limit is hit but the user has earned
// referral bonus credits, spend one of those instead of blocking them.
function checkRandomAllowed(userId, config) {
    // VIP (via promo code or manual grant) skips cooldown + daily limit
    // entirely, but requests are still tallied (0, 0 = no cooldown/no cap).
    if (isUserVip(userId)) {
        recordRequest(userId, 0, 0);
        return { allowed: true, isVip: true };
    }
    const check = recordRequest(userId, config.cooldownSeconds, config.dailyLimit);
    if (!check.allowed && check.reason === 'daily_limit' && consumeBonusCredit(userId)) {
        return { allowed: true, usedBonus: true };
    }
    return check;
}

// Core logic behind /random — also reused by the "🎬 ഫ്രീ വീഡിയോ" button so
// both entry points behave identically (force-sub check, cooldown/daily
// limit, then send).
async function handleRandomRequest(ctx) {
    const userId = ctx.from.id;
    if (!acquireFileShareLock(userId)) return; // duplicate tap while a request is already in flight — ignore
    try {
        const config = loadConfig();
        if (config.forceSubGroupIds.length === 0) {
            await ctx.reply('⚠️ Force-sub group is not configured yet. Please ask the admin.');
            return;
        }

        const unjoined = await getUnjoinedGroups(ctx, config.forceSubGroupIds, userId);
        if (unjoined.length > 0) {
            await sendJoinPrompt(ctx, unjoined);
            return;
        }

        const check = checkRandomAllowed(userId, config);
        if (!check.allowed) {
            if (check.reason === 'cooldown') {
                await ctx.reply(`⏳ Please wait ${check.retryAfter} second(s) and try again.`);
            } else {
                await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow, or use /myreferral to earn bonus credits.`,
                    config.vipChannelLink ? { reply_markup: { inline_keyboard: [[{ text: '💎 Buy VIP — No Limits', callback_data: 'vip_info' }]] } } : undefined);
            }
            return;
        }
        if (check.usedBonus) {
            await ctx.reply('💎 Used 1 bonus credit (daily limit reached).');
        }

        await sendRandomFiles(ctx);
    } finally {
        releaseFileShareLock(userId);
    }
}

bot.command('random', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await handleRandomRequest(ctx);
});

// "🎬 ഫ്രീ വീഡിയോ" button on MY_STATS_KEYBOARD — does exactly what /random does.
bot.action('user_random', async (ctx) => {
    await ctx.answerCbQuery();
    await handleRandomRequest(ctx);
});

bot.action('recheck_sub', async (ctx) => {
    const config = loadConfig();
    if (config.forceSubGroupIds.length === 0) {
        await ctx.answerCbQuery('⚠️ Force-sub group is not configured.');
        return;
    }

    const unjoined = await getUnjoinedGroups(ctx, config.forceSubGroupIds, ctx.from.id);
    if (unjoined.length > 0) {
        await ctx.answerCbQuery('❌ You haven\'t joined all the required group(s) yet.', { show_alert: true });
        return;
    }

    await ctx.answerCbQuery('✅ Verified!');
    try {
        await ctx.deleteMessage();
    } catch (e) { /* ignore */ }

    const userId = ctx.from.id;
    if (!acquireFileShareLock(userId)) return; // duplicate tap while a request is already in flight — ignore
    try {
        const check = checkRandomAllowed(userId, config);
        if (!check.allowed) {
            if (check.reason === 'cooldown') {
                await ctx.reply(`⏳ Please wait ${check.retryAfter} second(s) and try again.`);
            } else {
                await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow, or use /myreferral to earn bonus credits.`,
                    config.vipChannelLink ? { reply_markup: { inline_keyboard: [[{ text: '💎 Buy VIP — No Limits', callback_data: 'vip_info' }]] } } : undefined);
            }
            return;
        }
        if (check.usedBonus) {
            await ctx.reply('💎 Used 1 bonus credit (daily limit reached).');
        }

        await sendRandomFiles(ctx);
    } finally {
        releaseFileShareLock(userId);
    }
});

// --- Admin-only /start menu ---
const ADMIN_START_TEXT = 'Welcome, Admin!\n\nChoose a section to manage:';
const ADMIN_START_KEYBOARD = {
    inline_keyboard: [
        [{ text: '📦 Mega Management', callback_data: 'menu_mega' }, { text: '🎬 File Sharing', callback_data: 'menu_fileshare' }]
    ]
};

// Regular users only ever see /start and /random in the "/" command menu.
// Admins (chat-scoped override) see the full admin command set as well.
// Note: Telegram requires the target chat to have messaged the bot at least
// once before a chat-scoped command list can be set for it.
async function setupCommandMenus() {
    try {
        await bot.telegram.setMyCommands([
            { command: 'start', description: 'Start the bot' },
            { command: 'random', description: 'Get a random file' }
        ]);
    } catch (error) {
        console.error('Could not set default commands:', error.message);
    }

    const adminCommands = [
        { command: 'start', description: 'Admin menu' },
        { command: 'random', description: 'Get a random file' },
        { command: 'setsource', description: 'Set file source group (run in group)' },
        { command: 'setforcesub', description: 'Add force-sub group (run in group)' },
        { command: 'unsetforcesub', description: 'Remove force-sub group (run in group)' },
        { command: 'listforcesub', description: 'List force-sub groups' },
        { command: 'setcount', description: 'Files sent per request' },
        { command: 'setcooldown', description: 'Cooldown between requests (sec)' },
        { command: 'setdailylimit', description: 'Max requests/day per user' },
        { command: 'setautodelete', description: 'Auto-delete sent files (min)' },
        { command: 'listfiles', description: 'View the file pool' },
        { command: 'delfile', description: 'Remove a file by index' },
        { command: 'stats', description: 'Pool & usage stats' },
        { command: 'broadcast', description: 'Message all /random users' },
        { command: 'broadcasthistory', description: 'Last 10 broadcasts' },
        { command: 'schedulebroadcast', description: 'Schedule a text broadcast' },
        { command: 'listscheduled', description: 'List pending scheduled broadcasts' },
        { command: 'cancelbroadcast', description: 'Cancel a scheduled broadcast' },
        { command: 'backupconfig', description: 'Download a zip of all config files' }
    ];

    const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
    for (const adminId of adminIds) {
        try {
            await bot.telegram.setMyCommands(adminCommands, {
                scope: { type: 'chat', chat_id: Number(adminId) }
            });
        } catch (error) {
            console.error(`Could not set admin commands for ${adminId} (they may need to /start the bot first):`, error.message);
        }
    }
}

bot.action('menu_mega', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '📦 *Mega Management*\n\n' +
        'Send any MEGA link (file or folder) here, or in a group/channel where I\'m admin, and I\'ll download and deliver it.\n\n' +
        'Supported formats:\n' +
        '• `https://mega.nz/file/ID#KEY`\n' +
        '• `https://mega.nz/folder/ID#KEY`\n\n' +
        '_This feature is available to admins only._',
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_back' }]] }
        }
    );
});

async function renderFileSharePanel(ctx) {
    const config = loadConfig();
    const sourceLabel = config.sourceGroupId
        ? (getKnownChats().find(c => String(c.id) === String(config.sourceGroupId))?.title || config.sourceGroupId)
        : 'Not set';
    const text = '🎬 *File Sharing*\n\n' +
        `Force-sub groups/channels: ${config.forceSubGroupIds.length}\n` +
        `Source: ${escapeMd(sourceLabel)}\n\n` +
        '_Everything below is button-driven — no need to enter the target chat._';

    const keyboard = {
        inline_keyboard: [
            [{ text: '➕ Add Force-Sub', callback_data: 'fs_addfs_menu' }, { text: '📋 Force-Sub List', callback_data: 'fs_listforcesub' }],
            [{ text: '🎯 Set Source', callback_data: 'fs_setsrc_menu' }, { text: '📁 List Files', callback_data: 'fs_listfiles' }],
            [{ text: '📊 Stats', callback_data: 'fs_stats' }, { text: `🔢 Per Request: ${config.shareCount}`, callback_data: 'fs_count_menu' }],
            [{ text: `⏱ Cooldown: ${config.cooldownSeconds}s`, callback_data: 'fs_cooldown_menu' }, { text: `📆 Daily Limit: ${config.dailyLimit === 0 ? 'Unlimited' : config.dailyLimit}`, callback_data: 'fs_dailylimit_menu' }],
            [{ text: `🗑 Auto-Delete: ${config.autoDeleteMinutes === 0 ? 'Off' : config.autoDeleteMinutes + 'm'}`, callback_data: 'fs_autodelete_menu' }, { text: `🔐 Forward Protection: ${config.protectContent ? 'ON' : 'OFF'}`, callback_data: 'fs_toggle_protect' }],
            [{ text: '📢 Broadcast', callback_data: 'fs_broadcast_menu' }, { text: '🖼 Auto-Post', callback_data: 'ap_menu' }],
            [{ text: '🛠 Maintenance Mode', callback_data: 'mm_menu' }, { text: '📦 MEGA Upload Destination', callback_data: 'mud_menu' }],
            [{ text: '👤 About/Start Message', callback_data: 'about_menu' }, { text: '📂 VIP Categories', callback_data: 'cat_menu' }],
            [{ text: '💎 VIP Promotion', callback_data: 'vip_menu' }, { text: '🎟 Promo Codes', callback_data: 'promo_menu' }],
            [{ text: '🔙 Back', callback_data: 'menu_back' }]
        ]
    };

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('fs_toggle_protect', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const config = loadConfig();
    config.protectContent = !config.protectContent;
    saveConfig(config);
    await ctx.answerCbQuery(`Forward protection ${config.protectContent ? 'ON' : 'OFF'}`);
    await renderFileSharePanel(ctx);
});

// --- About/Start Message (admin config for the non-admin ℹ️ About panel) ---
async function renderAboutPanel(ctx) {
    const config = loadConfig();
    const text = '👤 *About / Start Message*\n\n' +
        `Join Group Link: ${config.aboutJoinGroupLink ? escapeMd(config.aboutJoinGroupLink) : '_Not set_'}\n` +
        `Link Text: ${config.aboutLinkText ? escapeMd(config.aboutLinkText) : '_Not set_'}\n` +
        `Link URL: ${config.aboutLinkUrl ? escapeMd(config.aboutLinkUrl) : '_Not set_'}\n\n` +
        '_Shown to regular users when they tap ℹ️ About on /start. Creator credit and tech stack are fixed._';

    const keyboard = {
        inline_keyboard: [
            [{ text: '👥 Set Join Group Link', callback_data: 'about_setjoin' }, { text: '✏️ Set Link Text', callback_data: 'about_settext' }],
            [{ text: '🔗 Set Link URL', callback_data: 'about_seturl' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('about_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderAboutPanel(ctx);
});

bot.action('about_setjoin', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'about_join_link' };
    await ctx.editMessageText('👥 Send the Join Group link (e.g. `https://t.me/yourgroup`), or /cancel.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'about_menu' }]] }
    });
});

bot.action('about_settext', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'about_link_text' };
    await ctx.editMessageText('✏️ Send the clickable text (e.g. `Hello`), or /cancel.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'about_menu' }]] }
    });
});

bot.action('about_seturl', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'about_link_url' };
    await ctx.editMessageText('🔗 Send the URL the text should link to, or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'about_menu' }]] }
    });
});

// --- VIP Promotion (admin config for the "💎 Buy VIP" button) ---
// The button appears on /start, the About panel, the daily-limit-reached
// message, and the force-sub join prompt — the moments a free user actually
// hits friction, rather than on every file delivery.
async function renderVipPanel(ctx) {
    const config = loadConfig();
    const stats = getVipStats();
    const text = '💎 *VIP Promotion*\n\n' +
        `Channel Link: ${config.vipChannelLink ? escapeMd(config.vipChannelLink) : '_Not set_'}\n` +
        `Promo Text: ${config.vipPromoText ? escapeMd(config.vipPromoText) : '_Not set_'}\n\n` +
        `📊 Button taps: ${stats.totalClicks} total, ${stats.uniqueUsers} unique user(s)\n\n` +
        '_"💎 Buy VIP" shows on /start, About, when a user hits the daily limit, and on the force-sub join prompt._' +
        (config.vipChannelLink ? '' : '\n\n⚠️ Set a channel link below to activate the button — it stays hidden until then.');

    const keyboard = {
        inline_keyboard: [
            [{ text: '🔗 Set Channel Link', callback_data: 'vip_setlink' }, { text: '✏️ Set Promo Text', callback_data: 'vip_settext' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('vip_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderVipPanel(ctx);
});

bot.action('vip_setlink', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'vip_channel_link' };
    await ctx.editMessageText('🔗 Send the VIP channel link (e.g. `https://t.me/yourvipchannel`), or /cancel.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'vip_menu' }]] }
    });
});

bot.action('vip_settext', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'vip_promo_text' };
    await ctx.editMessageText('✏️ Send the promo text shown above the Join button (benefits, price, etc.), or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'vip_menu' }]] }
    });
});

// --- Promo Codes (admin creates codes that grant VIP access on redemption) ---
async function renderPromoPanel(ctx) {
    const codes = listPromoCodes();
    let text = '🎟 *Promo Codes*\n\n';

    if (codes.length === 0) {
        text += '_No codes created yet._';
    } else {
        text += codes.slice(0, 15).map(c => {
            const duration = c.days > 0 ? `${c.days}d` : 'Lifetime';
            const uses = c.maxUses > 0 ? `${c.usedBy.length}/${c.maxUses}` : `${c.usedBy.length}/∞`;
            return `\`${c.code}\` — ${duration} — used ${uses}`;
        }).join('\n');
        if (codes.length > 15) text += `\n_...and ${codes.length - 15} more_`;
    }

    const keyboard = {
        inline_keyboard: [
            [{ text: '➕ Create Code', callback_data: 'promo_create_menu' }, { text: '🗑 Delete Code', callback_data: 'promo_delete_menu' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('promo_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderPromoPanel(ctx);
});

bot.action('promo_create_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'promo_create' };
    await ctx.editMessageText(
        '➕ *Create Promo Code*\n\n' +
        'Send: `CODE DAYS [MAXUSES]`\n\n' +
        '• `DAYS` — how many days of VIP access. Use `0` for lifetime/unlimited.\n' +
        '• `MAXUSES` — optional, how many different users can redeem this code. Leave blank or `0` for unlimited people.\n\n' +
        'Examples:\n' +
        '`SUMMER30 30` → 30 days VIP, any number of people can use it\n' +
        '`VIPFRIEND 0 1` → lifetime VIP, redeemable by only 1 person\n' +
        '`WEEKPASS 7 50` → 7 days VIP, up to 50 people\n\n' +
        'Or /cancel.',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'promo_menu' }]] } }
    );
});

bot.action('promo_delete_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'promo_delete' };
    await ctx.editMessageText('🗑 Send the code to delete, or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'promo_menu' }]] }
    });
});

// --- VIP Categories (admin-curated, VIP-only video categories) ---
// Fully separate storage from the free /random pool (see fileShare.js) —
// nothing added here ever reaches a free user through /random, deep links,
// or auto-post. The only delivery path is the VIP-gated browser above.
//
// Every video added to a category is first archived into a dedicated
// Category Storage Channel (config.categoryStorageChannelId) — one channel
// shared by all categories, each post tagged with its category name in the
// caption so it's readable at a glance if an admin opens the channel
// directly. Delivery to VIP users then uses copyMessage from that channel,
// same proven pattern as the free pool, instead of relying on a raw file_id
// or an admin's own DM history staying intact.
async function renderCategoriesPanel(ctx) {
    const categories = listCategories();
    const stats = getCategoryStats();
    const config = loadConfig();
    const channelLabel = config.categoryStorageChannelId
        ? (getKnownChats().find(c => String(c.id) === String(config.categoryStorageChannelId))?.title || config.categoryStorageChannelId)
        : null;

    let text = '📂 *VIP Categories*\n\n' +
        `Storage channel: ${channelLabel ? `✅ ${escapeMd(channelLabel)}` : '⚠️ Not set'}\n` +
        `${stats.totalCategories} categor${stats.totalCategories === 1 ? 'y' : 'ies'}, ${stats.totalVideos} video(s) total.\n\n` +
        '_Videos placed in a category are completely hidden from free users and never enter the /random pool — only active VIP members can open them (💎 Buy VIP → 📂 VIP Categories)._';

    if (!channelLabel) {
        text += '\n\n⚠️ *Set a storage channel below before adding videos* — every category video is archived there first, so delivery stays reliable even if the original source disappears.';
    }

    const shown = categories.slice(0, 25);
    const rows = shown.map(c => [{ text: `📁 ${c.name} (${c.videos.length})`, callback_data: `cat_admin:${c.id}` }]);
    if (categories.length > shown.length) {
        text += `\n\n_...and ${categories.length - shown.length} more (showing first ${shown.length}, A–Z)._`;
    }
    rows.push([{ text: '➕ Create Category', callback_data: 'cat_create' }]);
    rows.push([{ text: `🎯 ${channelLabel ? 'Change' : 'Set'} Storage Channel`, callback_data: 'cat_setchannel_menu' }]);
    rows.push([{ text: '🔙 Back', callback_data: 'menu_fileshare' }]);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

// --- Category Storage Channel setup (tap-to-pick or manual ID/@username) ---
bot.action('cat_setchannel_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const { rows, truncated, total } = knownChatPickerKeyboard([], 'cat_setchannel', 'cat_menu', ctx.from.id);
    const note = total === 0
        ? '_I haven\'t seen any channels yet — add me to your storage channel as admin (with "Post Messages" permission) first, or type an ID/@username._'
        : truncated ? `_Showing 20 of ${total} known chats._` : '';
    await ctx.editMessageText(
        `🎯 *Set Category Storage Channel*\n\nAll VIP category videos get archived here. I must be admin there with permission to post messages.\n\n${note}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
    );
});

bot.action(/^cat_setchannel:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    try {
        await ctx.telegram.getChatMember(chatId, ctx.botInfo.id);
    } catch (error) {
        await ctx.answerCbQuery('⚠️ Could not verify — try again.');
        return;
    }
    const config = loadConfig();
    config.categoryStorageChannelId = chatId;
    saveConfig(config);
    const chat = getKnownChats().find(c => String(c.id) === String(chatId));
    await ctx.answerCbQuery('✅ Storage channel set');
    await ctx.editMessageText(`✅ VIP category videos will now be archived in "${chat ? chat.title : chatId}".`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'cat_menu' }]] }
    });
});

bot.action('cat_setchannel_manual', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'cat_setchannel_manual' };
    await ctx.editMessageText('⌨️ Send the channel ID (e.g. `-1001234567890`) or `@username`.\n\nI must already be admin there with permission to post. Send /cancel to abort.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cat_menu' }]] }
    });
});

bot.action('cat_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderCategoriesPanel(ctx);
});

bot.action('cat_create', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'cat_create_name' };
    await ctx.editMessageText(
        '➕ *Create Category*\n\nSend a name for the new category (max 64 characters), or /cancel.',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cat_menu' }]] } }
    );
});

async function renderCategoryAdminPanel(ctx, categoryId) {
    const category = getCategory(categoryId);
    if (!category) {
        await ctx.editMessageText('⚠️ That category no longer exists.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'cat_menu' }]] }
        });
        return;
    }
    const created = new Date(category.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const text = `📁 *${escapeMd(category.name)}*\n\n` +
        `Videos: ${category.videos.length}\n` +
        `Created: ${created}\n\n` +
        '_VIP-only — free users never see this category or its content, in the list or through /random._';

    const keyboard = {
        inline_keyboard: [
            [{ text: '➕ Add Video(s)', callback_data: `cat_addvideo:${category.id}` }, { text: '📋 List / Remove Videos', callback_data: `cat_listvideos:${category.id}:0` }],
            [{ text: '✏️ Rename', callback_data: `cat_rename:${category.id}` }, { text: '🗑 Delete Category', callback_data: `cat_delconfirm:${category.id}` }],
            [{ text: '🔙 Back', callback_data: 'cat_menu' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action(/^cat_admin:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderCategoryAdminPanel(ctx, ctx.match[1]);
});

bot.action(/^cat_addvideo:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const category = getCategory(ctx.match[1]);
    if (!category) {
        await ctx.answerCbQuery('⚠️ Category not found.');
        await renderCategoriesPanel(ctx);
        return;
    }
    const config = loadConfig();
    if (!config.categoryStorageChannelId) {
        await ctx.answerCbQuery('⚠️ Set a storage channel first.');
        await ctx.editMessageText(
            '⚠️ *No storage channel set yet*\n\nEvery category video is archived into a dedicated channel first, so delivery stays reliable. Set one before adding videos.',
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🎯 Set Storage Channel', callback_data: 'cat_setchannel_menu' }], [{ text: '🔙 Back', callback_data: `cat_admin:${category.id}` }]] }
            }
        );
        return;
    }
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'cat_add_video', categoryId: category.id };
    await ctx.editMessageText(
        `➕ *Adding videos to "${escapeMd(category.name)}"*\n\n` +
        'Send or forward video(s) now — one at a time or several in a row, each gets archived into the storage channel and added immediately. ' +
        'Duplicates (the same clip twice) are auto-skipped. Tap ✅ Done when finished, or /cancel to stop.',
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '✅ Done', callback_data: `cat_adddone:${category.id}` }]] }
        }
    );
});

bot.action(/^cat_adddone:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    delete pendingAction[ctx.from.id];
    await ctx.answerCbQuery('✅ Done adding videos');
    await renderCategoryAdminPanel(ctx, ctx.match[1]);
});

const CAT_VIDEOS_PER_PAGE = 8;

async function renderCategoryVideoList(ctx, categoryId, offset) {
    const category = getCategory(categoryId);
    if (!category) {
        await ctx.editMessageText('⚠️ That category no longer exists.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'cat_menu' }]] }
        });
        return;
    }
    const videos = category.videos;
    if (videos.length === 0) {
        await ctx.editMessageText(`📋 *${escapeMd(category.name)}* has no videos yet.`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '➕ Add Video(s)', callback_data: `cat_addvideo:${category.id}` }], [{ text: '🔙 Back', callback_data: `cat_admin:${category.id}` }]] }
        });
        return;
    }
    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, videos.length - 1)));
    const page = videos.slice(safeOffset, safeOffset + CAT_VIDEOS_PER_PAGE);

    const rows = page.map((v, i) => {
        const num = safeOffset + i + 1;
        const date = new Date(v.added_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        return [{ text: `❌ #${num} — ${v.type} — ${date}`, callback_data: `cat_delvideo:${category.id}:${v.id}:${safeOffset}` }];
    });

    const navRow = [];
    if (safeOffset > 0) navRow.push({ text: '◀️ Prev', callback_data: `cat_listvideos:${category.id}:${Math.max(0, safeOffset - CAT_VIDEOS_PER_PAGE)}` });
    if (safeOffset + CAT_VIDEOS_PER_PAGE < videos.length) navRow.push({ text: 'Next ▶️', callback_data: `cat_listvideos:${category.id}:${safeOffset + CAT_VIDEOS_PER_PAGE}` });
    if (navRow.length) rows.push(navRow);
    rows.push([{ text: '🔙 Back', callback_data: `cat_admin:${category.id}` }]);

    const text = `📋 *${escapeMd(category.name)}* — ${videos.length} video(s)\n\n` +
        `Showing #${safeOffset + 1}–#${safeOffset + page.length}. Tap ❌ to remove one.`;
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

bot.action(/^cat_listvideos:(.+):(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderCategoryVideoList(ctx, ctx.match[1], parseInt(ctx.match[2], 10));
});

bot.action(/^cat_delvideo:(.+):(.+):(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const [, categoryId, videoId, offsetStr] = ctx.match;
    const category = getCategory(categoryId);
    const video = category ? category.videos.find(v => v.id === videoId) : null;
    const removed = removeVideoFromCategory(categoryId, videoId);
    if (removed && video && video.chat_id && video.message_id) {
        // Best-effort — the video reference is already gone either way,
        // this just keeps the storage channel from accumulating orphans.
        try { await ctx.telegram.deleteMessage(video.chat_id, video.message_id); } catch (e) { /* already gone / inaccessible */ }
    }
    await ctx.answerCbQuery(removed ? '✅ Removed' : '⚠️ Already gone');
    await renderCategoryVideoList(ctx, categoryId, parseInt(offsetStr, 10));
});

bot.action(/^cat_rename:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const category = getCategory(ctx.match[1]);
    if (!category) {
        await ctx.answerCbQuery('⚠️ Category not found.');
        await renderCategoriesPanel(ctx);
        return;
    }
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'cat_rename', categoryId: category.id };
    await ctx.editMessageText(`✏️ Send a new name for "${escapeMd(category.name)}", or /cancel.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `cat_admin:${category.id}` }]] }
    });
});

bot.action(/^cat_delconfirm:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const category = getCategory(ctx.match[1]);
    if (!category) {
        await ctx.answerCbQuery('⚠️ Category not found.');
        await renderCategoriesPanel(ctx);
        return;
    }
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `⚠️ *Delete "${escapeMd(category.name)}"?*\n\n` +
        `This removes the category and deletes its ${category.videos.length} archived video(s) from the storage channel too. This can't be undone.`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Yes, Delete', callback_data: `cat_delete:${category.id}` },
                    { text: '❌ Cancel', callback_data: `cat_admin:${category.id}` }
                ]]
            }
        }
    );
});

bot.action(/^cat_delete:(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const category = getCategory(ctx.match[1]);
    const videos = category ? category.videos : [];
    const deleted = deleteCategory(ctx.match[1]);
    if (deleted) {
        // Best-effort cleanup of the storage channel — the category record
        // is already gone either way, so a failure here just leaves an
        // orphaned post rather than blocking the deletion.
        for (const v of videos) {
            if (v.chat_id && v.message_id) {
                try { await ctx.telegram.deleteMessage(v.chat_id, v.message_id); } catch (e) { /* already gone / inaccessible */ }
            }
        }
    }
    await ctx.answerCbQuery(deleted ? '🗑 Deleted' : '⚠️ Already gone');
    await renderCategoriesPanel(ctx);
});

// --- Maintenance mode ---
async function renderMaintenancePanel(ctx) {
    const config = loadConfig();
    const whitelist = getMaintenanceWhitelist();
    const text = '🛠 *Maintenance Mode*\n\n' +
        `Status: ${config.maintenanceMode ? '🔴 ON — bot paused for everyone else' : '🟢 OFF — normal'}\n\n` +
        'When ON: MEGA downloads and all normal features stop for everyone ' +
        'except admins and users added below. They see "Bot under maintenance."\n\n' +
        `*Whitelisted users* (${whitelist.length}):\n` +
        (whitelist.length ? whitelist.map(id => `• \`${id}\``).join('\n') : '_None yet._');

    const keyboard = {
        inline_keyboard: [
            [{ text: config.maintenanceMode ? '🟢 Turn OFF' : '🔴 Turn ON', callback_data: 'mm_toggle' }],
            [{ text: '➕ Add User', callback_data: 'mm_add_user' }, { text: '➖ Remove User', callback_data: 'mm_remove_menu' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('mm_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderMaintenancePanel(ctx);
});

bot.action('mm_toggle', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const config = loadConfig();
    config.maintenanceMode = !config.maintenanceMode;
    saveConfig(config);
    await ctx.answerCbQuery(config.maintenanceMode ? '🔴 Maintenance ON' : '🟢 Maintenance OFF');
    await renderMaintenancePanel(ctx);
});

bot.action('mm_add_user', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'mm_add_user' };
    await ctx.editMessageText('⌨️ Send the Telegram user ID to allow during maintenance, or /cancel.\n\n_Tip: ask them to send /start to any bot that shows their ID, e.g. @userinfobot._', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'mm_menu' }]] }
    });
});

bot.action('mm_remove_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const whitelist = getMaintenanceWhitelist();
    if (whitelist.length === 0) {
        await ctx.editMessageText('No whitelisted users to remove.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'mm_menu' }]] }
        });
        return;
    }
    const rows = whitelist.map(id => [{ text: `➖ ${id}`, callback_data: `mm_remove:${id}` }]);
    rows.push([{ text: '🔙 Back', callback_data: 'mm_menu' }]);
    await ctx.editMessageText('➖ *Tap a user to remove from the maintenance whitelist:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^mm_remove:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    removeMaintenanceWhitelist(ctx.match[1]);
    await ctx.answerCbQuery('✅ Removed');
    await renderMaintenancePanel(ctx);
});

// --- MEGA Upload Destination (admin-only, isolated from other channel pickers) ---
async function renderMegaUploadPanel(ctx) {
    const config = loadConfig();
    const channelLabel = config.megaUploadChannelId
        ? (getKnownChats().find(c => String(c.id) === String(config.megaUploadChannelId))?.title || config.megaUploadChannelId)
        : 'Not set';
    const text = '📦 *MEGA Upload Destination* (admin-only)\n\n' +
        `Mode: ${config.megaUploadMode === 'channel' ? '📤 Channel' : '👤 Personal (chat)'}\n` +
        (config.megaUploadMode === 'channel' ? `Channel: ${escapeMd(channelLabel)}\n` : '') +
        '\nApplies only when *you* (admin) send a MEGA link — regular users always get files in their own chat. ' +
        'Once set, it goes straight there, no asking each time. The progress bar always stays in this chat; ' +
        'only the clean file (no link, no caption) reaches the channel.';
    const keyboard = {
        inline_keyboard: [
            [
                { text: `${config.megaUploadMode === 'personal' ? '✅ ' : ''}👤 Personal`, callback_data: 'mud_mode:personal' },
                { text: `${config.megaUploadMode === 'channel' ? '✅ ' : ''}📤 Channel`, callback_data: 'mud_mode:channel' }
            ],
            [{ text: '🎯 Set Channel', callback_data: 'mud_setchannel_menu' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('mud_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderMegaUploadPanel(ctx);
});

bot.action(/^mud_mode:(personal|channel)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const mode = ctx.match[1];
    const config = loadConfig();
    if (mode === 'channel' && !config.megaUploadChannelId) {
        await ctx.answerCbQuery('⚠️ Set a channel first.');
        await renderMegaUploadPanel(ctx);
        return;
    }
    config.megaUploadMode = mode;
    saveConfig(config);
    await ctx.answerCbQuery(mode === 'channel' ? '📤 Channel mode' : '👤 Personal mode');
    await renderMegaUploadPanel(ctx);
});

bot.action('mud_setchannel_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const { rows, truncated, total } = knownChatPickerKeyboard([], 'mud_setchannel', 'mud_menu', ctx.from.id);
    const note = total === 0
        ? '_I haven\'t seen any channels yet — add me to yours as admin first, or type an ID/@username._'
        : truncated ? `_Showing 20 of ${total} known chats._` : '';
    await ctx.editMessageText(`🎯 *Set MEGA Upload Channel*\n\n${note}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^mud_setchannel:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    const config = loadConfig();
    config.megaUploadChannelId = chatId;
    config.megaUploadMode = 'channel';
    saveConfig(config);
    const chat = getKnownChats().find(c => String(c.id) === String(chatId));
    await ctx.answerCbQuery('✅ Channel set');
    await ctx.editMessageText(`✅ MEGA uploads (yours) will now go to "${chat ? chat.title : chatId}".`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'mud_menu' }]] }
    });
});

bot.action('mud_setchannel_manual', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'mud_setchannel_manual' };
    await ctx.editMessageText('⌨️ Send the channel ID (e.g. `-1001234567890`) or `@username`.\n\nI must already be admin there. Send /cancel to abort.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'mud_menu' }]] }
    });
});

// Renders a list of known groups/channels (auto-tracked from any update the
// bot has seen from them) as tappable buttons, excluding already-picked ones.
// adminId scopes the list to chats that admin personally added the bot to
// (plus any not-yet-attributed legacy chats) — other admins' chats stay hidden.
function knownChatPickerKeyboard(excludeIds, prefix, backCallback, adminId) {
    const exclude = new Set(excludeIds.map(String));
    const chats = getKnownChats(adminId).filter(c => !exclude.has(String(c.id)));
    const shown = chats.slice(0, 20);
    // If two or more shown chats share the same title, append a short ID
    // suffix to every one of them so they're distinguishable in the list —
    // otherwise picking between e.g. two channels both named "My Channel"
    // is a guess, and the wrong one silently gets configured.
    const titleCounts = {};
    shown.forEach(c => { titleCounts[c.title] = (titleCounts[c.title] || 0) + 1; });
    const rows = shown.map(c => {
        const label = titleCounts[c.title] > 1 ? `${chatTypeIcon(c.type)} ${c.title} (…${String(c.id).slice(-6)})` : `${chatTypeIcon(c.type)} ${c.title}`;
        return [{ text: label, callback_data: `${prefix}:${c.id}` }];
    });
    rows.push([{ text: '⌨️ Type ID / @username instead', callback_data: `${prefix}_manual` }]);
    rows.push([{ text: '🔙 Back', callback_data: backCallback }]);
    return { rows, truncated: chats.length > 20, total: chats.length };
}

bot.action('menu_fileshare', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderFileSharePanel(ctx);
});

// --- Read-only panels ---
bot.action('fs_listfiles', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const files = loadSharedFiles();
    if (files.length === 0) {
        await ctx.editMessageText('No files in the pool yet.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
        });
        return;
    }
    const shown = files.slice(0, 15);
    const text = `📁 Files (${files.length} total, tap ❌ to remove — showing first ${shown.length}):\n\n` +
        shown.map((f, i) => `${i}. ${f.type} — msg #${f.message_id} — ${f.added_at.slice(0, 10)}`).join('\n');
    const rows = shown.map((f, i) => [{ text: `❌ Remove #${i} (${f.type})`, callback_data: `fs_delfile:${i}` }]);
    rows.push([{ text: '🔙 Back', callback_data: 'menu_fileshare' }]);
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } });
});

bot.action(/^fs_delfile:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const idx = parseInt(ctx.match[1], 10);
    const removed = deleteFileByIndex(idx);
    await ctx.answerCbQuery(removed ? `✅ Removed ${removed.type}` : '❌ Not found (list may have shifted)');
    const files = loadSharedFiles();
    if (files.length === 0) {
        await ctx.editMessageText('No files in the pool yet.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
        });
        return;
    }
    const shown = files.slice(0, 15);
    const text = `📁 Files (${files.length} total, tap ❌ to remove — showing first ${shown.length}):\n\n` +
        shown.map((f, i) => `${i}. ${f.type} — msg #${f.message_id} — ${f.added_at.slice(0, 10)}`).join('\n');
    const rows = shown.map((f, i) => [{ text: `❌ Remove #${i} (${f.type})`, callback_data: `fs_delfile:${i}` }]);
    rows.push([{ text: '🔙 Back', callback_data: 'menu_fileshare' }]);
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } });
});

bot.action('fs_stats', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const s = getStats();
    const text = `📊 *Stats*\n\nTotal files: ${s.totalFiles}\nTotal users: ${s.totalUsers}\nRequests today: ${s.requestsToday}`;
    await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

async function renderForceSubList(ctx) {
    const config = loadConfig();
    if (config.forceSubGroupIds.length === 0) {
        await ctx.editMessageText('No force-sub groups/channels set yet.', {
            reply_markup: { inline_keyboard: [
                [{ text: '➕ Add Force-Sub', callback_data: 'fs_addfs_menu' }],
                [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
            ] }
        });
        return;
    }
    const entries = await Promise.all(config.forceSubGroupIds.map(async (id) => {
        try {
            const chat = await ctx.telegram.getChat(id);
            recordKnownChat(chat.id, chat.title, chat.type);
            return { id, label: `${chatTypeIcon(chat.type)} ${chat.title}` };
        } catch (e) {
            return { id, label: `⚠️ ${id} (unreachable)` };
        }
    }));
    const text = `📋 *Force-Sub Groups/Channels* (${entries.length})\n\n` +
        `🔓 Auto = requests approved instantly\n` +
        `⏳ Pending = request alone unlocks files; real approval is delayed/manual`;
    const rows = [];
    for (const e of entries) {
        const settings = getForceSubSettings(e.id);
        rows.push([{ text: e.label, callback_data: 'noop' }, { text: '❌', callback_data: `fs_rmfs:${e.id}` }]);
        const modeLabel = settings.mode === 'pending'
            ? `⏳ Pending${settings.delayHours > 0 ? ` (${settings.delayHours}h)` : ' (manual)'}`
            : '🔓 Auto-Approve';
        const modeRow = [{ text: modeLabel, callback_data: `fs_fsmode:${e.id}` }];
        if (settings.mode === 'pending') modeRow.push({ text: '⏱ Delay', callback_data: `fs_fsdelay_menu:${e.id}` });
        rows.push(modeRow);
    }
    rows.push([{ text: '➕ Add More', callback_data: 'fs_addfs_menu' }]);
    rows.push([{ text: '🔙 Back', callback_data: 'menu_fileshare' }]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

bot.action(/^fs_fsmode:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    const settings = getForceSubSettings(chatId);
    const next = settings.mode === 'pending' ? 'auto' : 'pending';
    setForceSubSettings(chatId, { mode: next });
    await ctx.answerCbQuery(next === 'pending' ? '⏳ Pending mode ON' : '🔓 Auto-approve ON');
    await renderForceSubList(ctx);
});

bot.action(/^fs_fsdelay_menu:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    const settings = getForceSubSettings(chatId);
    const presets = [0, 1, 6, 24, 72];
    const rows = [presets.map(h => ({
        text: `${h === 0 ? 'Never' : h + 'h'}${settings.delayHours === h ? ' ✓' : ''}`,
        callback_data: `fs_fsdelay:${chatId}:${h}`
    }))];
    rows.push([{ text: '🔙 Back', callback_data: 'fs_listforcesub' }]);
    await ctx.editMessageText('⏱ *Auto-approve delay*\n\n"Never" = request stays pending until you approve it manually in Telegram.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^fs_fsdelay:(-?\d+):(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    const hours = Number(ctx.match[2]);
    setForceSubSettings(chatId, { delayHours: hours });
    await ctx.answerCbQuery(hours === 0 ? 'Set to manual-only' : `✅ Auto-approve in ${hours}h`);
    await renderForceSubList(ctx);
});

bot.action('fs_listforcesub', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderForceSubList(ctx);
});

bot.action('noop', async (ctx) => ctx.answerCbQuery());

bot.action(/^fs_rmfs:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    const config = loadConfig();
    config.forceSubGroupIds = config.forceSubGroupIds.filter(id => id !== chatId);
    saveConfig(config);
    await ctx.answerCbQuery('✅ Removed');
    await renderForceSubList(ctx);
});

// --- Add Force-Sub (button-driven, no need to enter the target chat) ---
bot.action('fs_addfs_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const config = loadConfig();
    const { rows, truncated, total } = knownChatPickerKeyboard(config.forceSubGroupIds, 'fs_addfs', 'menu_fileshare', ctx.from.id);
    // Bulk import goes just above the "Back" row (which knownChatPickerKeyboard always puts last).
    rows.splice(rows.length - 1, 0, [{ text: '📥 Bulk Import (multiple at once)', callback_data: 'fs_addfs_bulk' }]);
    const note = total === 0
        ? '_I haven\'t seen any groups/channels yet — add me to one first, or type an ID/@username._'
        : truncated ? `_Showing 20 of ${total} known chats._` : '';
    await ctx.editMessageText(`➕ *Add Force-Sub*\n\nTap a group/channel I already know, or enter one manually.\n\n${note}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^fs_addfs:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    const config = loadConfig();
    if (!config.forceSubGroupIds.includes(chatId)) {
        config.forceSubGroupIds.push(chatId);
        saveConfig(config);
    }
    await ctx.answerCbQuery('✅ Added');
    await renderForceSubList(ctx);
});

bot.action('fs_addfs_manual', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'add_forcesub_manual' };
    await ctx.editMessageText('⌨️ Send the group/channel ID (e.g. `-1001234567890`) or `@username`.\n\nI must already be a member/admin there. Send /cancel to abort.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'fs_listforcesub' }]] }
    });
});

bot.action('fs_addfs_bulk', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'add_forcesub_bulk' };
    await ctx.editMessageText(
        '📥 Send multiple group/channel IDs or @usernames — one per line, or comma-separated.\n\n' +
        'Example:\n`-1001234567890`\n`@somechannel`\n`-1009876543210`\n\n' +
        'I must already be a member/admin in each one. Send /cancel to abort.',
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'fs_listforcesub' }]] }
        }
    );
});

// --- Set Source (button-driven) ---
bot.action('fs_setsrc_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const { rows, truncated, total } = knownChatPickerKeyboard([], 'fs_setsrc', 'menu_fileshare', ctx.from.id);
    const note = total === 0
        ? '_I haven\'t seen any groups/channels yet — add me to one first, or type an ID/@username._'
        : truncated ? `_Showing 20 of ${total} known chats._` : '';
    await ctx.editMessageText(`🎯 *Set Source*\n\nPhoto/video files posted there by admins get tracked automatically.\n\n${note}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^fs_setsrc:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    const config = loadConfig();
    config.sourceGroupId = chatId;
    saveConfig(config);
    const chat = getKnownChats().find(c => String(c.id) === String(chatId));
    await ctx.answerCbQuery('✅ Source set');
    await ctx.editMessageText(`✅ Source set to "${chat ? chat.title : chatId}".`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_setsrc_manual', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'set_source_manual' };
    await ctx.editMessageText('⌨️ Send the source group/channel ID (e.g. `-1001234567890`) or `@username`.\n\nI must already be a member/admin there. Send /cancel to abort.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu_fileshare' }]] }
    });
});

// --- Broadcast (button-driven) ---
async function renderBroadcastMenu(ctx) {
    const config = loadConfig();
    const pendingCount = getPendingScheduledBroadcasts().length;
    const text = '📢 *Broadcast*\n\n' +
        `Forward mode: ${config.broadcastForwardMode ? 'ON (shows "Forwarded from")' : 'OFF (looks native)'}\n` +
        `Pending scheduled: ${pendingCount}\n\n` +
        'Tap *Send Now* then send text, photo, video, or GIF (with caption). ' +
        'Use `/schedulebroadcast YYYY-MM-DD HH:MM text` for scheduled text broadcasts, and `/broadcasthistory` to review past sends.';
    const keyboard = {
        inline_keyboard: [
            [{ text: '📤 Send Now', callback_data: 'fs_broadcast_send' }, { text: `🔁 Forward: ${config.broadcastForwardMode ? 'ON' : 'OFF'}`, callback_data: 'fs_toggle_forward' }],
            [{ text: '📜 History', callback_data: 'fs_broadcast_history' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('fs_broadcast_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderBroadcastMenu(ctx);
});

bot.action('fs_toggle_forward', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const config = loadConfig();
    config.broadcastForwardMode = !config.broadcastForwardMode;
    saveConfig(config);
    await ctx.answerCbQuery(`Forward mode ${config.broadcastForwardMode ? 'ON' : 'OFF'}`);
    await renderBroadcastMenu(ctx);
});

bot.action('fs_broadcast_history', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const history = getBroadcastHistory(10);
    const text = history.length === 0
        ? 'No broadcasts sent yet.'
        : '📜 *Last broadcasts*\n\n' + history.map(h => {
            const when = new Date(h.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            return `• ${when} — ${h.kind}\n  ✅${h.sent} ❌${h.failed} 🚫${h.blocked} / ${h.total}`;
        }).join('\n');
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'fs_broadcast_menu' }]] } });
});

bot.action('fs_broadcast_send', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'broadcast' };
    await ctx.editMessageText('📢 Send the text message to broadcast now — or send a photo/video/GIF with a caption — or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'fs_broadcast_menu' }]] }
    });
});

// --- Auto-Post system (per-admin, isolated) ---

// Forwards the video silently to the admin's own DM just to read its
// Telegram-generated thumbnail file_id, then deletes the forwarded copy.
async function getVideoThumbnailFileId(adminId, chatId, messageId) {
    try {
        const fwd = await bot.telegram.forwardMessage(adminId, chatId, messageId, { disable_notification: true });
        const thumb = (fwd.video && (fwd.video.thumb || fwd.video.thumbnail)) || null;
        const thumbFileId = thumb ? thumb.file_id : null;
        bot.telegram.deleteMessage(adminId, fwd.message_id).catch(() => {});
        return thumbFileId;
    } catch (error) {
        console.error('getVideoThumbnailFileId failed:', error.message);
        return null;
    }
}

async function blurBuffer(buffer) {
    if (!sharp) return null;
    try {
        return await sharp(buffer).blur(5).toBuffer();
    } catch (error) {
        console.error('blurBuffer failed:', error.message);
        return null;
    }
}

// Downloads a Telegram file (by file_id) into a Buffer. Needed because a
// video's own thumbnail file_id is tagged internally as "Thumbnail" type by
// Telegram and gets rejected with "can't use file of type Thumbnail as
// Photo" if passed straight to sendPhoto — it has to be fetched and
// re-uploaded as raw bytes instead.
async function downloadTelegramFile(fileId) {
    try {
        const link = await bot.telegram.getFileLink(fileId);
        const res = await fetch(link.href || link.toString());
        return Buffer.from(await res.arrayBuffer());
    } catch (error) {
        console.error('downloadTelegramFile failed:', error.message);
        return null;
    }
}

// The destination channel itself is unreachable (bot removed as admin,
// channel deleted, wrong/stale ID). This is a config problem, not a video
// problem — reported distinctly from per-video retry/skip so admins get a
// clear "go fix your channel setting" pointer instead of a confusing video
// error. Deduped per admin+channel so a broken channel doesn't spam every
// tick.
async function logDestinationUnreachable(adminId, channelId, err) {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    await logAutopostEvent(
        `🚫 *Auto-Post: Destination Channel Unreachable*\n\n` +
        `*When:* ${timestamp} IST\n` +
        `*Admin:* \`${adminId}\`\n` +
        `*Channel ID:* \`${channelId}\`\n` +
        `*Error:* ${err.description || err.message}\n\n` +
        `This isn't a video problem — the destination channel can't be reached ` +
        `(I may have been removed as admin, the channel may have been deleted, ` +
        `or the ID is wrong). Re-set it via 🖼 Auto-Post → 📤 Set Destination Channel.`,
        `ap-nodest:${adminId}:${channelId}`
    );
}

// A single video is retried at most this many times (across ticks) before
// it's permanently given up on and marked skipped.
const MAX_AUTOPOST_RETRIES = 2;

// Records one failed attempt at posting `tag`. Below the cap, the tag is
// left as "unposted" so the next tick tries it again, and a short retry
// notice goes to the log channel. At the cap, the tag is permanently marked
// skipped (won't be tried again) and a detailed give-up notice is logged.
// Returns 'retry' or 'skipped'.
async function handleAutopostFailure(adminId, tag, reason) {
    const attempts = incrementAutopostRetry(adminId, tag);
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    if (attempts >= MAX_AUTOPOST_RETRIES) {
        clearAutopostRetry(adminId, tag);
        markAutopostTagSkipped(adminId, tag);
        await logAutopostEvent(
            `⛔ *Auto-Post: Video Permanently Skipped*\n\n` +
            `*When:* ${timestamp} IST\n` +
            `*Admin:* \`${adminId}\`\n` +
            `*Video tag:* \`${tag}\`\n` +
            `*Reason:* ${reason}\n` +
            `*Attempts:* ${attempts}/${MAX_AUTOPOST_RETRIES} — giving up, will not be retried again.`,
            `ap-giveup:${adminId}:${tag}`
        );
        return 'skipped';
    }
    await logAutopostEvent(
        `⚠️ *Auto-Post: Attempt Failed*\n\n` +
        `*When:* ${timestamp} IST\n` +
        `*Admin:* \`${adminId}\`\n` +
        `*Video tag:* \`${tag}\`\n` +
        `*Reason:* ${reason}\n` +
        `*Attempt:* ${attempts}/${MAX_AUTOPOST_RETRIES} — will retry next tick.`,
        `ap-retry:${adminId}:${tag}:${reason}`
    );
    return 'retry';
}

// Core auto-post engine, shared by the "🧪 Test Preview" setup flow and the
// automatic interval-based scheduler. preview=true sends the candidate post
// to the admin's own DM with Confirm/Skip instead of posting to the channel
// — setup-time only. Scheduled runs (preview=false) post directly, no confirm.
//
// Videos are pulled from the admin's own configured **Source Channel**
// (cfg.sourceChannelIds) — isolated per admin, distinct from the destination
// Channel that receives the post itself.
// Queue is considered "low" once fewer than this many unposted videos
// remain — triggers one warning (not a repeat every tick) until restocked.
const LOW_QUEUE_THRESHOLD = 3;

async function runAutopostForAdmin(adminId, { preview = false } = {}) {
    const cfg = getAutopostConfig(adminId);
    if (!cfg.channelId) return { error: 'no_channel' };
    if (!cfg.sourceChannelIds || cfg.sourceChannelIds.length === 0) {
        await logAutopostEvent(
            `⚠️ *Auto-Post: No Source Channel*\n\n*Admin:* \`${adminId}\`\nSet a Source Channel in the Auto-Post menu first.`,
            `ap-nosource:${adminId}`
        );
        return { error: 'no_source' };
    }

    const sourceIds = cfg.sourceChannelIds.map(String);
    const files = loadSharedFiles().filter(f => f.type === 'video' && sourceIds.includes(String(f.chat_id)));
    const unposted = files.filter(f => !cfg.postedTags.includes(`${f.chat_id}:${f.message_id}`));

    // Low-queue warning: fires once when the queue drops below the
    // threshold, and resets (so it can fire again later) once restocked —
    // avoids both silence and every-tick spam.
    if (unposted.length < LOW_QUEUE_THRESHOLD && !cfg.lowQueueWarned) {
        setAutopostConfig(adminId, { lowQueueWarned: true });
        await logAutopostEvent(
            `⚠️ *Auto-Post: Queue Running Low*\n\n*Admin:* \`${adminId}\`\n*Remaining:* ${unposted.length} unposted video(s)\n\nAdd more videos to your source channel(s) soon.`,
            `ap-lowqueue:${adminId}`
        );
    } else if (unposted.length >= LOW_QUEUE_THRESHOLD && cfg.lowQueueWarned) {
        setAutopostConfig(adminId, { lowQueueWarned: false });
    }

    if (unposted.length === 0) {
        await logAutopostEvent(
            `ℹ️ *Auto-Post: Nothing To Post*\n\n*Admin:* \`${adminId}\`\nNo new (unposted) videos in the source channel(s) yet.`,
            `ap-empty:${adminId}`
        );
        return { error: 'no_files' };
    }
    const file = unposted[0];
    const tag = `${file.chat_id}:${file.message_id}`;

    let thumbSource;
    if (cfg.thumbnailMode === 'custom' && cfg.customThumbnailFileId) {
        // A photo the admin uploaded themselves — this file_id is already a
        // real Photo, safe to pass to sendPhoto directly.
        thumbSource = cfg.customThumbnailFileId;
    } else {
        // A video's own thumbnail is tagged as "Thumbnail" type by Telegram,
        // not "Photo" — sendPhoto rejects it directly, so download it and
        // re-upload the raw bytes instead.
        const thumbFileId = await getVideoThumbnailFileId(adminId, file.chat_id, file.message_id);
        if (!thumbFileId) {
            const outcome = await handleAutopostFailure(adminId, tag, 'Could not read a thumbnail file_id from the video.');
            return { error: outcome === 'skipped' ? 'no_thumbnail_skipped' : 'no_thumbnail_retry' };
        }
        const buffer = await downloadTelegramFile(thumbFileId);
        if (!buffer) {
            const outcome = await handleAutopostFailure(adminId, tag, 'Thumbnail file_id found but download failed.');
            return { error: outcome === 'skipped' ? 'no_thumbnail_skipped' : 'no_thumbnail_retry' };
        }
        thumbSource = { source: buffer };
    }

    if (cfg.blurEnabled) {
        const buf = typeof thumbSource === 'string' ? await downloadTelegramFile(thumbSource) : thumbSource.source;
        if (buf) {
            const blurred = await blurBuffer(buf);
            if (blurred) thumbSource = { source: blurred };
        }
    }

    const deepLink = `https://t.me/${botUsername}?start=${encodeFileTag(file.chat_id, file.message_id)}`;
    const keyboard = { inline_keyboard: [[{ text: '🎬 Get Full Video', url: deepLink }]] };
    // The button alone isn't copy/forward-friendly on every client, so the
    // same link is also included as plain text in the caption.
    const captionWithLink = `${cfg.caption}\n\n🔗 ${deepLink}`;

    if (preview) {
        const msg = await bot.telegram.sendPhoto(adminId, thumbSource, {
            caption: `🧪 Preview\n\n${captionWithLink}`,
            reply_markup: { inline_keyboard: [
                [{ text: '✅ Post to Channel', callback_data: 'ap_confirm' }, { text: '❌ Skip', callback_data: 'ap_cancel' }]
            ] }
        });
        pendingAutopostPreview[adminId] = { tag, caption: captionWithLink, thumbSource, keyboard };
        return { previewed: true };
    }

    try {
        await bot.telegram.sendPhoto(cfg.channelId, thumbSource, { caption: captionWithLink, reply_markup: keyboard });
        markAutopostTagPosted(adminId, tag);
        return { posted: true, tag };
    } catch (err) {
        if (err.description && (err.description.includes('file') || err.description.includes('photo'))) {
            const outcome = await handleAutopostFailure(adminId, tag, `Telegram rejected the post: ${err.description}`);
            return { error: outcome === 'skipped' ? 'bad_thumbnail_skipped' : 'bad_thumbnail_retry' };
        }
        if (err.description && err.description.toLowerCase().includes('chat not found')) {
            // Not a video problem — the destination channel itself can't be
            // reached (bot removed as admin, channel deleted, wrong ID,
            // etc). Don't count this against the video's retry budget —
            // it'll be the very next video posted once the channel is fixed.
            await logDestinationUnreachable(adminId, cfg.channelId, err);
            return { error: 'destination_unreachable' };
        }
        await logError(`Auto-post send (admin ${adminId}, tag ${tag})`, err);
        throw err;
    }
}

// e.g. 90 -> "1h 30m", 60 -> "1h", 45 -> "45m", 0 -> "Not set"
function formatIntervalMinutes(min) {
    if (!min) return 'Not set';
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
}

// Accepts "45m", "2h", "1h30m", "1h 30m", or a plain number (treated as minutes).
// Returns whole minutes, or null if the input couldn't be parsed.
function parseIntervalToMinutes(input) {
    const text = String(input).trim().toLowerCase().replace(/\s+/g, '');
    if (/^\d+$/.test(text)) return parseInt(text, 10);
    const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
    if (match && (match[1] || match[2])) {
        const h = parseInt(match[1] || '0', 10);
        const m = parseInt(match[2] || '0', 10);
        return h * 60 + m;
    }
    return null;
}

// Checked every minute — fires any admin's auto-post whose interval has elapsed.
async function processAutopostTicks() {
    for (const cfg of getAllAutopostConfigs()) {
        if (!cfg.enabled || !cfg.channelId || !cfg.sourceChannelIds || cfg.sourceChannelIds.length === 0 || !cfg.intervalMinutes) continue;
        const dueAt = (cfg.lastPostAt || 0) + cfg.intervalMinutes * 60 * 1000;
        if (Date.now() < dueAt) continue;
        try {
            const result = await runAutopostForAdmin(cfg.adminId, { preview: false });
            if (result.error) console.log(`Auto-post skipped for admin ${cfg.adminId}: ${result.error}`);
        } catch (error) {
            logError(`Auto-post tick (admin ${cfg.adminId})`, error);
        }
    }
}

// Sends one summary to the log channel per calendar day (IST), covering
// every admin who has any auto-post config at all — running or paused —
// so "no news" doesn't get mistaken for "nothing is happening". Silence
// elsewhere (retries, skips, chat-not-found, etc.) is otherwise the only
// signal something's wrong; this gives a positive "still alive" signal too.
let lastHealthReportDate = null;
async function checkDailyHealthReport() {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // "YYYY-MM-DD" in IST
    if (lastHealthReportDate === todayStr) return; // already sent today
    lastHealthReportDate = todayStr;

    const configs = getAllAutopostConfigs().filter(c => c.channelId || (c.sourceChannelIds && c.sourceChannelIds.length > 0));
    const uptimeHrs = ((Date.now() - botStartedAt) / (1000 * 60 * 60)).toFixed(1);

    const lines = [`🩺 *Daily Health Check* — ${todayStr}`, '', `Uptime: ${uptimeHrs}h`, `Auto-Post admins configured: ${configs.length}`];
    for (const cfg of configs) {
        const stats = getAutopostStats(cfg.adminId);
        const sourceIds = (cfg.sourceChannelIds || []).map(String);
        const queueCount = sourceIds.length > 0
            ? loadSharedFiles().filter(f => f.type === 'video' && sourceIds.includes(String(f.chat_id)) && !cfg.postedTags.includes(`${f.chat_id}:${f.message_id}`)).length
            : 0;
        lines.push(`• Admin \`${cfg.adminId}\`: ${cfg.enabled ? '✅ Running' : '⏸ Paused'} | Queue: ${queueCount}${queueCount < LOW_QUEUE_THRESHOLD ? ' ⚠️' : ''} | Posted today: ${stats.today}`);
    }
    if (configs.length === 0) lines.push('_No admin has configured Auto-Post yet._');

    await sendToLogChannel(lines.join('\n'));
}

// ISO 8601 week number (Mon-based). Used to key the weekly summary so it
// fires once per calendar week rather than drifting based on process
// uptime / restart timing.
function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Sends one growth-focused summary to the log channel per ISO week (IST),
// alongside the daily health check. Covers new users/files this week, a
// referral leaderboard, and VIP button engagement — a weekly "how's it
// going" pulse rather than an operational alert.
let lastWeeklySummaryKey = null;
async function checkWeeklySummary() {
    const config = loadConfig();
    if (!config.errorLogChatId) return;

    const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const weekKey = `${nowIst.getFullYear()}-W${getISOWeek(nowIst)}`;
    if (lastWeeklySummaryKey === weekKey) return; // already sent this week
    lastWeeklySummaryKey = weekKey;

    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stats = getStats();
    const newUsers = getUsersJoinedSince(weekAgoMs);
    const newFiles = getFilesAddedSince(weekAgoMs);
    const topReferrers = getTopReferrers(3);
    const vipStats = getVipStats();

    const lines = [
        `📊 *Weekly Summary* — ${weekKey}`,
        '',
        `👥 Users: ${stats.totalUsers} total (+${newUsers} this week)`,
        `📁 Files: ${stats.totalFiles} total (+${newFiles} this week)`,
        `📨 Requests today: ${stats.requestsToday}`,
        `💎 VIP button taps: ${vipStats.totalClicks} total, ${vipStats.uniqueUsers} unique user(s)`,
        ''
    ];
    if (topReferrers.length > 0) {
        lines.push('🎁 *Top Referrers (all-time):*');
        topReferrers.forEach((r, i) => lines.push(`${i + 1}. \`${r.id}\` — ${r.count} referral(s)`));
    } else {
        lines.push('_No referrals yet._');
    }

    await sendToLogChannel(lines.join('\n'));
}

async function renderAutopostPanel(ctx) {
    const adminId = ctx.from.id;
    const cfg = getAutopostConfig(adminId);
    const channelLabel = cfg.channelId
        ? `${escapeMd(getKnownChats().find(c => String(c.id) === String(cfg.channelId))?.title || '?')} (\`${cfg.channelId}\`)`
        : 'Not set';
    const sourceIds = cfg.sourceChannelIds || [];
    const sourceLabel = sourceIds.length > 0
        ? sourceIds.map(id => escapeMd(getKnownChats().find(c => String(c.id) === String(id))?.title || id)).join(', ')
        : 'Not set';
    const queueCount = sourceIds.length > 0
        ? loadSharedFiles().filter(f => f.type === 'video' && sourceIds.map(String).includes(String(f.chat_id)) && !cfg.postedTags.includes(`${f.chat_id}:${f.message_id}`)).length
        : 0;
    const stats = getAutopostStats(adminId);
    const text = '🖼 *Auto-Post* (only visible/controllable by you)\n\n' +
        `Source Channels (${sourceIds.length}): ${sourceLabel} (videos are pulled from here)\n` +
        `Destination Channel: ${channelLabel} (posts go here)\n` +
        `Queue: ${queueCount} unposted video(s) waiting${queueCount < LOW_QUEUE_THRESHOLD ? ' ⚠️ low' : ''}\n` +
        `Interval: ${cfg.intervalMinutes === 0 ? 'Not set' : 'Every ' + formatIntervalMinutes(cfg.intervalMinutes)}\n` +
        `Caption: "${escapeMd(cfg.caption)}"\n` +
        `Thumbnail: ${cfg.thumbnailMode === 'custom' ? (cfg.customThumbnailFileId ? 'Custom (uploaded)' : 'Custom (not uploaded yet!)') : "Video's own"}\n` +
        `Blur: ${cfg.blurEnabled ? 'ON' : 'OFF'}${sharp ? '' : ' (⚠️ sharp not installed — run npm install)'}\n` +
        `Status: ${cfg.enabled ? '✅ Running' : '⏸ Paused'}\n` +
        `Posted: ${stats.today} today, ${stats.week} this week, ${stats.allTime} all-time`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '➕ Add Source Channel', callback_data: 'ap_setsource_menu' }, { text: '➖ Remove Source Channel', callback_data: 'ap_removesource_menu' }],
            [{ text: '📤 Set Destination Channel', callback_data: 'ap_setchannel_menu' }, { text: '🔍 Verify Destination', callback_data: 'ap_verify_dest' }],
            [{ text: `⏱ Interval: ${formatIntervalMinutes(cfg.intervalMinutes)}`, callback_data: 'ap_interval_menu' }, { text: '✏️ Set Caption', callback_data: 'ap_caption' }],
            [{ text: `🖼 Thumbnail: ${cfg.thumbnailMode === 'custom' ? 'Custom' : 'Video'}`, callback_data: 'ap_thumb_toggle' }, { text: '📤 Upload Thumbnail', callback_data: 'ap_thumb_upload' }],
            [{ text: `🔵 Blur: ${cfg.blurEnabled ? 'ON' : 'OFF'}`, callback_data: 'ap_blur_toggle' }, { text: cfg.enabled ? '⏸ Pause' : '▶️ Enable', callback_data: 'ap_toggle_enabled' }],
            [{ text: '🧪 Test Preview', callback_data: 'ap_test' }, { text: '📊 Stats', callback_data: 'ap_stats' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    } catch (error) {
        if (!isMessageNotModifiedError(error)) throw error;
    }
}

bot.action('ap_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await renderAutopostPanel(ctx);
});

bot.action('ap_setchannel_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const { rows, truncated, total } = knownChatPickerKeyboard([], 'ap_setchannel', 'ap_menu', ctx.from.id);
    const note = total === 0
        ? '_I haven\'t seen any channels yet — add me to yours as admin first, or type an ID/@username._'
        : truncated ? `_Showing 20 of ${total} known chats._` : '';
    await ctx.editMessageText(`📤 *Set Your Auto-Post Destination Channel*\n\nOnly you post here — this is where the posts go.\n\n${note}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^ap_setchannel:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    setAutopostConfig(ctx.from.id, { channelId: chatId });
    const chat = getKnownChats().find(c => String(c.id) === String(chatId));
    await ctx.answerCbQuery('✅ Destination channel set');
    await ctx.editMessageText(`✅ Auto-post destination channel set to "${chat ? chat.title : chatId}".`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_setchannel_manual', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'ap_setchannel_manual' };
    await ctx.editMessageText('⌨️ Send the destination channel ID (e.g. `-1001234567890`) or `@username`.\n\nI must already be admin there. Send /cancel to abort.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_menu' }]] }
    });
});

// Proves — rather than just claims — where auto-posts are actually landing.
// Sends a real, visible test message to cfg.channelId right now: if it
// doesn't show up in the channel the admin is watching, the configured ID
// simply isn't that channel (wrong pick, stale entry, duplicate title, etc).
bot.action('ap_verify_dest', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const cfg = getAutopostConfig(ctx.from.id);
    if (!cfg.channelId) { await ctx.answerCbQuery('⚠️ Set a destination channel first.'); return; }
    await ctx.answerCbQuery('🔍 Sending test message...');
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    try {
        const chat = await ctx.telegram.getChat(cfg.channelId);
        await ctx.telegram.sendMessage(cfg.channelId, `🔍 Auto-Post verification — ${timestamp} IST\n\nIf you can see this message in your channel, the destination is correct.`);
        await ctx.reply(
            `✅ Message sent successfully.\n\n` +
            `*Chat reached:* ${chat.title || chat.username || chat.id}\n` +
            `*ID:* \`${chat.id}\`\n` +
            `*Type:* ${chat.type}\n\n` +
            `Now go check that exact channel — if the test message with the timestamp above isn't there, this ID does *not* point to the channel you're watching. Common cause: an older/duplicate entry with the same name was picked from the list. Re-run 📤 Set Destination Channel and pick carefully, or type the @username/ID manually to be sure.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        await logDestinationUnreachable(ctx.from.id, cfg.channelId, error);
        await ctx.reply(`❌ Could not reach \`${cfg.channelId}\`: ${error.description || error.message}\n\nRe-set it via 📤 Set Destination Channel.`, { parse_mode: 'Markdown' });
    }
});

// --- Source channel (where videos are pulled FROM, distinct from the
// destination channel above). Picking it also enables silent tracking of
// that channel's future video posts into the shared file pool — see the
// `isAutopostSourceChannel()` check used by the message/channel_post
// handlers further down.
bot.action('ap_setsource_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const cfg = getAutopostConfig(ctx.from.id);
    const exclude = [...(cfg.sourceChannelIds || []), ...(cfg.channelId ? [cfg.channelId] : [])];
    const { rows, truncated, total } = knownChatPickerKeyboard(exclude, 'ap_setsource', 'ap_menu', ctx.from.id);
    const note = total === 0
        ? '_No more known channels to add — add me to a new one as admin first, or type an ID/@username._'
        : truncated ? `_Showing 20 of ${total} known chats._` : '';
    await ctx.editMessageText(`➕ *Add Auto-Post Source Channel*\n\nI'll pull videos from here (new posts only). You can add more than one — currently ${(cfg.sourceChannelIds || []).length} source channel(s) set. Must be different from your destination channel.\n\n${note}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^ap_setsource:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    const cfg = getAutopostConfig(ctx.from.id);
    if (cfg.channelId && String(chatId) === String(cfg.channelId)) {
        await ctx.answerCbQuery('⚠️ That\'s your destination channel — pick a different one.');
        return;
    }
    const ids = new Set((cfg.sourceChannelIds || []).map(String));
    ids.add(String(chatId));
    setAutopostConfig(ctx.from.id, { sourceChannelIds: Array.from(ids).map(Number) });
    const chat = getKnownChats().find(c => String(c.id) === String(chatId));
    await ctx.answerCbQuery('✅ Source channel added');
    await ctx.editMessageText(`✅ Added "${chat ? chat.title : chatId}" as a source channel.\n\nNew videos posted there from now on will be picked up automatically.`, {
        reply_markup: { inline_keyboard: [[{ text: '➕ Add Another', callback_data: 'ap_setsource_menu' }], [{ text: '🔙 Back', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_setsource_manual', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'ap_setsource_manual' };
    await ctx.editMessageText('⌨️ Send the source channel ID (e.g. `-1001234567890`) or `@username` to add.\n\nI must already be admin there. Send /cancel to abort.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_menu' }]] }
    });
});

// --- Remove a source channel ---
bot.action('ap_removesource_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const cfg = getAutopostConfig(ctx.from.id);
    if (!cfg.sourceChannelIds || cfg.sourceChannelIds.length === 0) {
        await ctx.editMessageText('No source channels set yet.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ap_menu' }]] } });
        return;
    }
    const rows = cfg.sourceChannelIds.map(id => {
        const chat = getKnownChats().find(c => String(c.id) === String(id));
        return [{ text: `❌ ${chat ? chat.title : id}`, callback_data: `ap_removesource:${id}` }];
    });
    rows.push([{ text: '🔙 Back', callback_data: 'ap_menu' }]);
    await ctx.editMessageText('➖ *Remove a Source Channel*\n\nTap one to remove it (videos already tracked from it stay in the queue).', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^ap_removesource:(-?\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const chatId = Number(ctx.match[1]);
    const cfg = getAutopostConfig(ctx.from.id);
    const remaining = (cfg.sourceChannelIds || []).filter(id => String(id) !== String(chatId));
    setAutopostConfig(ctx.from.id, { sourceChannelIds: remaining });
    await ctx.answerCbQuery('✅ Removed');
    await ctx.editMessageText(`✅ Removed. ${remaining.length} source channel(s) remaining.`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_interval_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const cfg = getAutopostConfig(ctx.from.id);
    const minuteRow = [1, 15, 30, 45].map(m => ({ text: `${m}m`, callback_data: `ap_interval:${m}` }));
    const hourRow = [1, 3, 6, 12, 24].map(h => ({ text: `${h}h`, callback_data: `ap_interval:${h * 60}` }));
    await ctx.editMessageText(`⏱ *Auto-Post Interval*\n\nCurrent: ${formatIntervalMinutes(cfg.intervalMinutes)}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [minuteRow, hourRow, [{ text: '✏️ Custom', callback_data: 'ap_interval_custom' }], [{ text: '🔙 Back', callback_data: 'ap_menu' }]] }
    });
});

bot.action(/^ap_interval:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const n = parseInt(ctx.match[1], 10);
    setAutopostConfig(ctx.from.id, { intervalMinutes: n });
    await ctx.answerCbQuery(`✅ Every ${formatIntervalMinutes(n)}`);
    await renderAutopostPanel(ctx);
});

bot.action('ap_interval_custom', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'autopost_interval_custom' };
    await ctx.editMessageText('✏️ Send the interval — e.g. `45m`, `2h`, `1h30m`, or just a number for minutes, or /cancel.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_interval_menu' }]] }
    });
});

bot.action('ap_caption', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'autopost_caption' };
    await ctx.editMessageText('✏️ Send the caption to use for every auto-post, or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_thumb_toggle', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const cfg = getAutopostConfig(ctx.from.id);
    const next = cfg.thumbnailMode === 'custom' ? 'video' : 'custom';
    setAutopostConfig(ctx.from.id, { thumbnailMode: next });
    await ctx.answerCbQuery(`Thumbnail source: ${next}`);
    await renderAutopostPanel(ctx);
});

bot.action('ap_thumb_upload', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'autopost_thumbnail' };
    await ctx.editMessageText('📤 Send the photo to use as the thumbnail for every auto-post, or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_blur_toggle', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    if (!sharp) {
        await ctx.answerCbQuery('⚠️ Install the "sharp" package on the server first (npm install sharp).');
        return;
    }
    const cfg = getAutopostConfig(ctx.from.id);
    setAutopostConfig(ctx.from.id, { blurEnabled: !cfg.blurEnabled });
    await ctx.answerCbQuery(`Blur ${!cfg.blurEnabled ? 'ON' : 'OFF'}`);
    await renderAutopostPanel(ctx);
});

bot.action('ap_toggle_enabled', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const cfg = getAutopostConfig(ctx.from.id);
    if (!cfg.enabled) {
        if (!cfg.sourceChannelIds || cfg.sourceChannelIds.length === 0) { await ctx.answerCbQuery('⚠️ Set a source channel first.'); return; }
        if (!cfg.channelId) { await ctx.answerCbQuery('⚠️ Set a destination channel first.'); return; }
        if (!cfg.intervalMinutes) { await ctx.answerCbQuery('⚠️ Set an interval first.'); return; }
    }
    setAutopostConfig(ctx.from.id, { enabled: !cfg.enabled });
    await ctx.answerCbQuery(!cfg.enabled ? '▶️ Enabled' : '⏸ Paused');
    await renderAutopostPanel(ctx);
});

bot.action('ap_stats', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const stats = getAutopostStats(ctx.from.id);
    await ctx.reply(
        `📊 *Auto-Post Stats*\n\n` +
        `Today: ${stats.today}\n` +
        `This week: ${stats.week}\n` +
        `All-time: ${stats.allTime}`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('ap_test', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const cfg = getAutopostConfig(ctx.from.id);
    if (!cfg.sourceChannelIds || cfg.sourceChannelIds.length === 0) { await ctx.answerCbQuery('⚠️ Set a source channel first.'); return; }
    if (!cfg.channelId) { await ctx.answerCbQuery('⚠️ Set a destination channel first.'); return; }
    await ctx.answerCbQuery('🧪 Generating preview...');
    const result = await runAutopostForAdmin(ctx.from.id, { preview: true });
    if (result.error === 'no_files') await ctx.reply('⚠️ No unposted videos in the source channel(s) yet.');
    else if (result.error === 'no_source') await ctx.reply('⚠️ Set a source channel first (🖼 Auto-Post → ➕ Add Source Channel).');
    else if (result.error === 'no_thumbnail_retry') await ctx.reply('⚠️ Could not read a thumbnail from that video — will retry automatically. Try again, or upload a custom thumbnail instead (🖼 Thumbnail Source → Custom).');
    else if (result.error === 'no_thumbnail_skipped') await ctx.reply('⚠️ Could not read a thumbnail after 2 attempts — that video was permanently skipped (see log channel). Try uploading a custom thumbnail instead (🖼 Thumbnail Source → Custom).');
});

bot.action('ap_confirm', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const pending = pendingAutopostPreview[ctx.from.id];
    if (!pending) { await ctx.answerCbQuery('⚠️ Preview expired — run Test Preview again.'); return; }
    const cfg = getAutopostConfig(ctx.from.id);
    if (!cfg.channelId) { await ctx.answerCbQuery('⚠️ No channel set.'); return; }
    try {
        await bot.telegram.sendPhoto(cfg.channelId, pending.thumbSource, { caption: pending.caption, reply_markup: pending.keyboard });
        markAutopostTagPosted(ctx.from.id, pending.tag);
        await ctx.answerCbQuery('✅ Posted!');
        await ctx.editMessageCaption('✅ Posted to channel.').catch(() => {});
    } catch (error) {
        if (error.description && error.description.toLowerCase().includes('chat not found')) {
            await logDestinationUnreachable(ctx.from.id, cfg.channelId, error);
            await ctx.answerCbQuery('❌ Destination channel unreachable.');
            await ctx.editMessageCaption('🚫 Failed — destination channel not found. I may have been removed as admin there, or the channel was deleted/ID is wrong. Re-set it via 📤 Set Destination Channel.').catch(() => {});
        } else {
            await ctx.answerCbQuery('❌ Failed to post.');
            logError('Auto-post confirm', error);
        }
    }
    delete pendingAutopostPreview[ctx.from.id];
});

bot.action('ap_cancel', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    delete pendingAutopostPreview[ctx.from.id];
    await ctx.answerCbQuery('Skipped');
    await ctx.editMessageCaption('❌ Skipped — not posted.').catch(() => {});
});

// --- Quick-preset setting panels ---
function presetRow(values, prefix, suffix = '') {
    return values.map(v => ({ text: `${v}${suffix}`, callback_data: `${prefix}:${v}` }));
}

bot.action('fs_count_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`🔢 *Files per Request*\n\nCurrent: ${config.shareCount}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([1, 2, 3, 5], 'fs_count'), [{ text: '✏️ Custom', callback_data: 'fs_custom_count' }], [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_cooldown_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`⏱ *Cooldown*\n\nCurrent: ${config.cooldownSeconds}s`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([0, 10, 15, 30, 60], 'fs_cooldown', 's'), [{ text: '✏️ Custom', callback_data: 'fs_custom_cooldown' }], [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_dailylimit_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`📆 *Daily Limit*\n\nCurrent: ${config.dailyLimit === 0 ? 'Unlimited' : config.dailyLimit}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([0, 5, 10, 20], 'fs_dailylimit'), [{ text: '✏️ Custom', callback_data: 'fs_custom_dailylimit' }], [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_autodelete_menu', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`🗑 *Auto-Delete*\n\nCurrent: ${config.autoDeleteMinutes === 0 ? 'Off' : config.autoDeleteMinutes + ' min'}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([0, 10, 30, 60], 'fs_autodelete', 'm'), [{ text: '✏️ Custom', callback_data: 'fs_custom_autodelete' }], [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

const CUSTOM_FIELD_MAP = {
    custom_count: { key: 'shareCount', label: 'Files per request', min: 1, menu: 'fs_count_menu' },
    custom_cooldown: { key: 'cooldownSeconds', label: 'Cooldown (seconds)', min: 0, menu: 'fs_cooldown_menu' },
    custom_dailylimit: { key: 'dailyLimit', label: 'Daily limit', min: 0, menu: 'fs_dailylimit_menu' },
    custom_autodelete: { key: 'autoDeleteMinutes', label: 'Auto-delete (minutes)', min: 0, menu: 'fs_autodelete_menu' }
};

bot.action(/^fs_custom_(count|cooldown|dailylimit|autodelete)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    const type = `custom_${ctx.match[1]}`;
    const field = CUSTOM_FIELD_MAP[type];
    pendingAction[ctx.from.id] = { type };
    await ctx.editMessageText(`✏️ Send a whole number for *${field.label}* (${field.min}+), or /cancel.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: field.menu }]] }
    });
});

bot.action(/^fs_count:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const n = parseInt(ctx.match[1], 10);
    const config = loadConfig();
    config.shareCount = n;
    saveConfig(config);
    await ctx.answerCbQuery(`✅ Set to ${n}`);
    await renderFileSharePanel(ctx);
});

bot.action(/^fs_cooldown:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const n = parseInt(ctx.match[1], 10);
    const config = loadConfig();
    config.cooldownSeconds = n;
    saveConfig(config);
    await ctx.answerCbQuery(`✅ Set to ${n}s`);
    await renderFileSharePanel(ctx);
});

bot.action(/^fs_dailylimit:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const n = parseInt(ctx.match[1], 10);
    const config = loadConfig();
    config.dailyLimit = n;
    saveConfig(config);
    await ctx.answerCbQuery(`✅ Set to ${n === 0 ? 'unlimited' : n}`);
    await renderFileSharePanel(ctx);
});

bot.action(/^fs_autodelete:(\d+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    const n = parseInt(ctx.match[1], 10);
    const config = loadConfig();
    config.autoDeleteMinutes = n;
    saveConfig(config);
    await ctx.answerCbQuery(`✅ Set to ${n === 0 ? 'off' : n + 'm'}`);
    await renderFileSharePanel(ctx);
});

bot.action('menu_back', async (ctx) => {
    if (!(await requireAdmin(ctx, true))) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText(ADMIN_START_TEXT, { reply_markup: ADMIN_START_KEYBOARD });
});

// Single combined handler for photo/video/animation messages — kept as one
// handler (rather than several bot.on() calls) so Telegraf's middleware chain
// doesn't short-circuit: a handler that returns without calling next() stops
// any later-registered handler for the same event from ever running.
//
// Private chat + admin: (a) 📢 Broadcast button flow — admin sends media+caption,
// (b) caption-prefixed `/broadcast ...` on any media, (c) uploading a custom
// thumbnail for the auto-post feature.
// True if `chatId` should have its photo/video posts tracked into the
// shared file pool — either the bot-wide legacy Source Group/Channel
// (config.sourceGroupId, feeds /random etc.), or any admin's per-admin
// Auto-Post Source Channels (cfg.sourceChannelIds). Storage stays a single
// shared pool either way; each admin's auto-post just filters it down to
// their own sourceChannelId later (see runAutopostForAdmin).
function isTrackedSourceChat(chatId, config) {
    if (config.sourceGroupId && String(chatId) === String(config.sourceGroupId)) return true;
    return getAllAutopostConfigs().some(c => (c.sourceChannelIds || []).some(id => String(id) === String(chatId)));
}

// Group/channel chat: tracks photo/video files posted in the configured
// source group into the share pool (unchanged from before).
bot.on(['photo', 'video', 'animation'], async (ctx) => {
    if (ctx.chat.type === 'private') {
        if (!(await requireAdmin(ctx))) return;

        const kind = ctx.message.animation ? 'animation' : (ctx.message.video ? 'video' : 'photo');
        const fileId = ctx.message.animation ? ctx.message.animation.file_id
            : ctx.message.video ? ctx.message.video.file_id
            : ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const fileUniqueId = ctx.message.animation ? ctx.message.animation.file_unique_id
            : ctx.message.video ? ctx.message.video.file_unique_id
            : ctx.message.photo[ctx.message.photo.length - 1].file_unique_id;
        const caption = ctx.message.caption || '';

        // (d) VIP Category "Add Video" mode — every media message while this
        // is active gets archived into the Category Storage Channel first,
        // then recorded by pointing at that channel post (chat_id +
        // message_id) — the same durable pattern the free pool uses,
        // instead of trusting a raw file_id or this DM's own message
        // history to stay intact. The mode STAYS active (pendingAction
        // isn't cleared) so several videos can be added back-to-back
        // without re-tapping "➕ Add Video(s)" each time. Only ✅ Done or
        // /cancel exits it.
        if (pendingAction[ctx.from.id]?.type === 'cat_add_video') {
            const categoryId = pendingAction[ctx.from.id].categoryId;
            const category = getCategory(categoryId);
            if (!category) {
                delete pendingAction[ctx.from.id];
                await ctx.reply('⚠️ That category no longer exists — stopped adding.', {
                    reply_markup: { inline_keyboard: [[{ text: '📂 Categories', callback_data: 'cat_menu' }]] }
                });
                return;
            }
            const config = loadConfig();
            const storageChannelId = config.categoryStorageChannelId;
            if (!storageChannelId) {
                delete pendingAction[ctx.from.id];
                await ctx.reply('⚠️ No storage channel is set anymore — stopped adding. Set one from the Categories menu and try again.', {
                    reply_markup: { inline_keyboard: [[{ text: '🎯 Set Storage Channel', callback_data: 'cat_setchannel_menu' }]] }
                });
                return;
            }

            const doneButton = { inline_keyboard: [[{ text: '✅ Done', callback_data: `cat_adddone:${categoryId}` }]] };

            // Tag the archived copy with the category name in its caption
            // (not the original) so browsing the storage channel directly
            // in Telegram is self-explanatory at a glance.
            const taggedCaption = caption ? `${caption}\n\n🏷 ${category.name}` : `🏷 ${category.name}`;
            let archived;
            try {
                archived = await ctx.telegram.copyMessage(storageChannelId, ctx.chat.id, ctx.message.message_id, { caption: taggedCaption });
            } catch (error) {
                console.error('Failed to archive category video to storage channel:', error.message);
                await ctx.reply(
                    `❌ Couldn't save that to the storage channel (${error.message}). ` +
                    'Make sure I\'m still admin there with permission to post, then send it again, or /cancel.',
                    { reply_markup: doneButton }
                );
                return;
            }

            const result = addVideoToCategory(categoryId, {
                chatId: storageChannelId,
                messageId: archived.message_id,
                fileUniqueId,
                type: kind,
                addedBy: ctx.from.id,
                caption
            });
            if (!result.success) {
                // Duplicate of a video already in this category — clean up the
                // copy we just archived so the storage channel doesn't fill up
                // with unreferenced duplicates.
                try { await ctx.telegram.deleteMessage(storageChannelId, archived.message_id); } catch (e) { /* best-effort */ }
                await ctx.reply(`⚠️ Already in "${category.name}" — skipped (duplicate). Send another, or tap ✅ Done.`, { reply_markup: doneButton });
                return;
            }
            await ctx.reply(`✅ Added to "${category.name}" — ${result.count} video(s) now. Send more, or tap ✅ Done.`, { reply_markup: doneButton });
            return;
        }

        // (c) Auto-post custom thumbnail upload — only photos accepted
        if (pendingAction[ctx.from.id]?.type === 'autopost_thumbnail') {
            delete pendingAction[ctx.from.id];
            if (kind !== 'photo') {
                await ctx.reply('⚠️ Please send a photo for the custom thumbnail. Try again from the Auto-Post menu.');
                return;
            }
            setAutopostConfig(ctx.from.id, { thumbnailMode: 'custom', customThumbnailFileId: fileId });
            await ctx.reply('✅ Custom thumbnail saved. It will be used for every auto-post.');
            return;
        }

        // (a) Broadcast button flow — admin tapped "Send Now" then sent media
        if (pendingAction[ctx.from.id]?.type === 'broadcast') {
            delete pendingAction[ctx.from.id];
            await runMediaBroadcast(ctx, kind, fileId, caption.replace(/^\/broadcast\s*/i, ''));
            return;
        }

        // (b) Caption-prefixed /broadcast on media, sent without using the button
        if (/^\/broadcast\b/i.test(caption)) {
            await runMediaBroadcast(ctx, kind, fileId, caption.replace(/^\/broadcast\s*/i, ''));
        }
        return;
    }

    // --- Group/channel: track photo/video files posted in the source group ---
    trackKnownChat(ctx);

    const config = loadConfig();
    if (!isTrackedSourceChat(ctx.chat.id, config)) return;
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    if (!ctx.message.photo && !ctx.message.video) return; // ignore animations for the source pool

    const type = Array.isArray(ctx.message.photo) ? 'photo' : 'video';
    const fileUniqueId = type === 'video' ? ctx.message.video.file_unique_id : ctx.message.photo[ctx.message.photo.length - 1].file_unique_id;
    const added = addSharedFile(ctx.chat.id, ctx.message.message_id, type, fileUniqueId);
    if (added) {
        console.log(`Tracked ${type} msg #${ctx.message.message_id} in share pool`);
    } else {
        console.log(`Duplicate ${type} msg #${ctx.message.message_id} — already in share pool, skipped`);
    }
});

// --- Channel support ---
// Telegram delivers posts made directly in a Channel as a `channel_post`
// update, not a `message` update — so bot.command() and bot.on(['photo','video'])
// above never fire for them. This handles the same setup commands and file
// tracking when the source/force-sub is a Channel instead of a Group.
//
// Channel posts are also anonymous at the Bot API level (no ctx.from), since
// Telegram never reveals which specific admin posted. Since only channel
// admins can post at all, authorization here checks that at least one of our
// trusted ADMIN_IDS currently administers the channel — the channel-level
// equivalent of the isAdmin(ctx.from.id) check used for groups.
async function isTrustedChannelAdmin(ctx) {
    try {
        const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
        const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
        const foundIds = admins.map(a => String(a.user.id));
        const authorized = foundIds.some(id => adminIds.includes(id));
        console.log(`🔐 Channel admin check for ${ctx.chat.id}: channel admins=[${foundIds.join(',')}] our ADMIN_IDS=[${adminIds.join(',')}] authorized=${authorized}`);
        return authorized;
    } catch (error) {
        console.error('❌ Could not verify channel admins:', error.message);
        return false;
    }
}

// Auto-approves join requests for any chat currently set as a force-sub
// group/channel — this is what makes the "request to join" invite links
// (see getOrCreateJoinRequestLink) actually unlock instantly instead of
// waiting on a human admin to approve each request.
bot.on('chat_join_request', async (ctx) => {
    try {
        const req = ctx.chatJoinRequest;
        const chatId = req.chat.id;
        const userId = req.from.id;

        const config = loadConfig();
        if (!config.forceSubGroupIds.includes(chatId)) return; // not one of ours — leave it alone

        const settings = getForceSubSettings(chatId);

        if (settings.mode === 'pending') {
            // Record it as proof-of-request (unlocks files immediately) but
            // don't approve — either it auto-approves later (delayHours) or
            // stays pending forever for the admin to handle manually.
            recordJoinRequest(chatId, userId);
            console.log(`⏳ Join request recorded (pending mode): user ${userId} -> chat "${req.chat.title}" (${chatId})`);
            try {
                const delayNote = settings.delayHours > 0
                    ? ` (it'll be approved automatically in ~${settings.delayHours}h)`
                    : '';
                await ctx.telegram.sendMessage(userId, `✅ Request received for "${req.chat.title}"${delayNote}. Send /random to get files now!`);
            } catch (e) { /* user hasn't opened a DM with the bot yet — ignore */ }
            return;
        }

        await ctx.telegram.approveChatJoinRequest(chatId, userId);
        console.log(`✅ Auto-approved join request: user ${userId} -> chat "${req.chat.title}" (${chatId})`);

        try {
            await ctx.telegram.sendMessage(userId, `✅ You're approved for "${req.chat.title}"! Send /random to get files.`);
        } catch (e) { /* user hasn't opened a DM with the bot yet — ignore */ }
    } catch (error) {
        logError('chat_join_request handling', error);
    }
});

// Checked every few minutes — approves any "pending" mode join request whose
// configured delay has elapsed.
// Safety-net sweep for auto-delete. The setTimeout in scheduleAutoDelete()
// handles deletion promptly while the process stays up, but that timer is
// lost on a pm2 restart / crash / redeploy that happens before it fires —
// this catches anything still pending in that case (including entries left
// over from before the last restart) and deletes them on the next tick.
async function processDuePendingDeletions() {
    const due = getDuePendingDeletions();
    for (const entry of due) {
        try {
            await bot.telegram.deleteMessage(entry.chat_id, entry.message_id);
        } catch (e) {
            // already deleted, chat inaccessible, or too old to delete — nothing more to do
        }
        removePendingDeletion(entry.chat_id, entry.message_id);
    }
}

async function processDelayedJoinApprovals() {
    const due = getDueJoinRequestsForApproval();
    for (const req of due) {
        try {
            await bot.telegram.approveChatJoinRequest(req.chatId, req.userId);
            markJoinRequestApproved(req.chatId, req.userId);
            console.log(`✅ Delayed-approved join request: user ${req.userId} -> chat ${req.chatId}`);
        } catch (error) {
            // Already approved/left/etc — mark done either way so it's not retried forever
            markJoinRequestApproved(req.chatId, req.userId);
            logError('Delayed join approval', error);
        }
    }
}

bot.on('channel_post', async (ctx) => {
    const post = ctx.channelPost;
    console.log(`📨 channel_post received in ${ctx.chat.id}: "${(post.text || '[non-text]').slice(0, 50)}"`);
    trackKnownChat(ctx);

    // File tracking: legacy source group, or any admin's auto-post source channel
    if (post.photo || post.video) {
        const config = loadConfig();
        if (isTrackedSourceChat(ctx.chat.id, config)) {
            const type = post.photo ? 'photo' : 'video';
            const fileUniqueId = type === 'video' ? post.video.file_unique_id : post.photo[post.photo.length - 1].file_unique_id;
            const added = addSharedFile(ctx.chat.id, post.message_id, type, fileUniqueId);
            if (added) {
                console.log(`Tracked ${type} msg #${post.message_id} in share pool (channel)`);
            } else {
                console.log(`Duplicate ${type} msg #${post.message_id} — already in share pool, skipped (channel)`);
            }
        }
        return;
    }

    // Setup commands
    const text = post.text;
    if (!text || !text.startsWith('/')) {
        // Not a setup command — check if it's a MEGA link instead
        if (text) {
            const megaLink = cleanMegaLink(text);
            if (megaLink) {
                if (!(await isTrustedChannelAdmin(ctx))) return;
                console.log(`🔍 Detected MEGA link in channel ${ctx.chat.id}`);
                await queue.add(() => processMegaLink(ctx, megaLink));
            }
        }
        return;
    }
    const command = text.split(' ')[0].split('@')[0];
    if (!['/setforcesub', '/setsource', '/unsetforcesub', '/setlogchannel', '/unsetlogchannel'].includes(command)) return;

    if (!(await isTrustedChannelAdmin(ctx))) return;

    const config = loadConfig();

    if (command === '/setforcesub') {
        if (!config.forceSubGroupIds.includes(ctx.chat.id)) {
            config.forceSubGroupIds.push(ctx.chat.id);
            saveConfig(config);
        }
        await ctx.reply(`✅ Added "${ctx.chat.title}" as a force-sub group.\n\nTotal force-sub groups: ${config.forceSubGroupIds.length}`);
    } else if (command === '/setsource') {
        config.sourceGroupId = ctx.chat.id;
        saveConfig(config);
        await ctx.reply(`✅ Set "${ctx.chat.title}" as the source group.\n\nPhoto/video files posted here will now be tracked automatically.`);
    } else if (command === '/unsetforcesub') {
        config.forceSubGroupIds = config.forceSubGroupIds.filter(id => id !== ctx.chat.id);
        if (config.forceSubInviteLinks) delete config.forceSubInviteLinks[ctx.chat.id];
        saveConfig(config);
        await ctx.reply(`✅ Removed "${ctx.chat.title}" from the force-sub list.`);
    } else if (command === '/setlogchannel') {
        config.errorLogChatId = ctx.chat.id;
        saveConfig(config);
        await ctx.reply(`✅ "${ctx.chat.title}" set as the error log channel. Bot errors will be posted here from now on.`);
    } else if (command === '/unsetlogchannel') {
        config.errorLogChatId = null;
        saveConfig(config);
        await ctx.reply('✅ Error log channel removed. Errors will only go to console now.');
    }
});

// ===== End Force-Sub File Sharing Feature =====

// Handles the "next plain message" step of a button flow (add force-sub
// manually, set source manually, broadcast, or a custom numeric value).
async function handlePendingAction(ctx, text) {
    const userId = ctx.from.id;
    const action = pendingAction[userId];
    if (!action) return;

    if (text.trim() === '/cancel') {
        delete pendingAction[userId];
        await ctx.reply('❌ Cancelled.');
        return;
    }

    if (action.type === 'add_forcesub_bulk') {
        delete pendingAction[userId];
        const identifiers = text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
        if (identifiers.length === 0) {
            await ctx.reply('⚠️ No IDs/usernames found in that message.');
            return;
        }

        const config = loadConfig();
        const added = [];
        const skipped = [];
        const failed = [];

        for (const identifier of identifiers) {
            let chat;
            try {
                const target = identifier.startsWith('@') || isNaN(identifier) ? identifier : Number(identifier);
                chat = await ctx.telegram.getChat(target);
            } catch (error) {
                failed.push(`${identifier} — not found`);
                continue;
            }
            try {
                await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
            } catch (error) {
                failed.push(`${chat.title || identifier} — bot not a member there`);
                continue;
            }
            recordKnownChat(chat.id, chat.title, chat.type);
            if (config.forceSubGroupIds.includes(chat.id)) {
                skipped.push(chat.title || identifier);
            } else {
                config.forceSubGroupIds.push(chat.id);
                added.push(chat.title || identifier);
            }
        }
        saveConfig(config);

        let summary = `📥 *Bulk Import Done* (${identifiers.length} entr${identifiers.length === 1 ? 'y' : 'ies'})\n\n`;
        summary += `✅ Added (${added.length}): ${added.length ? added.join(', ') : '—'}\n`;
        if (skipped.length) summary += `↔️ Already added (${skipped.length}): ${skipped.join(', ')}\n`;
        if (failed.length) summary += `❌ Failed (${failed.length}):\n${failed.map(f => `• ${f}`).join('\n')}\n`;
        try {
            await ctx.reply(summary, { parse_mode: 'Markdown' });
        } catch (e) {
            // Group/channel titles can contain unbalanced Markdown entities — fall back to plain text.
            await ctx.reply(summary.replace(/[*_`]/g, ''));
        }
        return;
    }

    if (action.type === 'add_forcesub_manual' || action.type === 'set_source_manual') {
        const identifier = text.trim();
        if (!identifier) {
            await ctx.reply('⚠️ Send a chat ID (e.g. -1001234567890) or @username, or /cancel.');
            return;
        }
        let chat;
        try {
            const target = identifier.startsWith('@') || isNaN(identifier) ? identifier : Number(identifier);
            chat = await ctx.telegram.getChat(target);
        } catch (error) {
            await ctx.reply(`❌ Couldn't find that chat (${error.message}). Make sure I'm added there, then try again, or /cancel.`);
            return;
        }
        try {
            await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
        } catch (error) {
            await ctx.reply(`⚠️ Found "${chat.title}" but I don't seem to be a member/admin there. Add me first, then try again, or /cancel.`);
            return;
        }
        recordKnownChat(chat.id, chat.title, chat.type);
        const config = loadConfig();
        if (action.type === 'add_forcesub_manual') {
            if (!config.forceSubGroupIds.includes(chat.id)) {
                config.forceSubGroupIds.push(chat.id);
                saveConfig(config);
            }
            await ctx.reply(`✅ Added "${chat.title}" as a force-sub ${chat.type === 'channel' ? 'channel' : 'group'}.`);
        } else {
            config.sourceGroupId = chat.id;
            saveConfig(config);
            await ctx.reply(`✅ Set "${chat.title}" as the source ${chat.type === 'channel' ? 'channel' : 'group'}.`);
        }
        delete pendingAction[userId];
        return;
    }

    if (action.type === 'mm_add_user') {
        delete pendingAction[userId];
        const idText = text.trim();
        if (!/^\d+$/.test(idText)) {
            await ctx.reply('⚠️ That doesn\'t look like a numeric Telegram user ID.');
            return;
        }
        addMaintenanceWhitelist(idText);
        await ctx.reply(`✅ User \`${idText}\` can now use the bot during maintenance.`, { parse_mode: 'Markdown' });
        return;
    }

    if (action.type === 'mud_setchannel_manual') {
        const identifier = text.trim();
        if (!identifier) {
            await ctx.reply('⚠️ Send a chat ID (e.g. -1001234567890) or @username, or /cancel.');
            return;
        }
        let chat;
        try {
            const target = identifier.startsWith('@') || isNaN(identifier) ? identifier : Number(identifier);
            chat = await ctx.telegram.getChat(target);
        } catch (error) {
            await ctx.reply(`❌ Couldn't find that chat (${error.message}). Make sure I'm added there, then try again, or /cancel.`);
            return;
        }
        try {
            await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
        } catch (error) {
            await ctx.reply(`⚠️ Found "${chat.title}" but I don't seem to be a member/admin there. Add me first, then try again, or /cancel.`);
            return;
        }
        recordKnownChat(chat.id, chat.title, chat.type);
        const config = loadConfig();
        config.megaUploadChannelId = chat.id;
        config.megaUploadMode = 'channel';
        saveConfig(config);
        delete pendingAction[userId];
        await ctx.reply(`✅ MEGA uploads (yours) will now go to "${chat.title}".`);
        return;
    }

    if (action.type === 'ap_setchannel_manual') {
        const identifier = text.trim();
        if (!identifier) {
            await ctx.reply('⚠️ Send a chat ID (e.g. -1001234567890) or @username, or /cancel.');
            return;
        }
        let chat;
        try {
            const target = identifier.startsWith('@') || isNaN(identifier) ? identifier : Number(identifier);
            chat = await ctx.telegram.getChat(target);
        } catch (error) {
            await ctx.reply(`❌ Couldn't find that chat (${error.message}). Make sure I'm added there, then try again, or /cancel.`);
            return;
        }
        try {
            await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
        } catch (error) {
            await ctx.reply(`⚠️ Found "${chat.title}" but I don't seem to be a member/admin there. Add me first, then try again, or /cancel.`);
            return;
        }
        recordKnownChat(chat.id, chat.title, chat.type);
        setAutopostConfig(userId, { channelId: chat.id });
        delete pendingAction[userId];
        await ctx.reply(`✅ Auto-post destination set to "${chat.title}". This channel is used only for your auto-posts.`);
        return;
    }

    if (action.type === 'ap_setsource_manual') {
        const identifier = text.trim();
        if (!identifier) {
            await ctx.reply('⚠️ Send a chat ID (e.g. -1001234567890) or @username, or /cancel.');
            return;
        }
        let chat;
        try {
            const target = identifier.startsWith('@') || isNaN(identifier) ? identifier : Number(identifier);
            chat = await ctx.telegram.getChat(target);
        } catch (error) {
            await ctx.reply(`❌ Couldn't find that chat (${error.message}). Make sure I'm added there, then try again, or /cancel.`);
            return;
        }
        try {
            await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
        } catch (error) {
            await ctx.reply(`⚠️ Found "${chat.title}" but I don't seem to be a member/admin there. Add me first, then try again, or /cancel.`);
            return;
        }
        recordKnownChat(chat.id, chat.title, chat.type);
        const cfg = getAutopostConfig(userId);
        if (cfg.channelId && String(cfg.channelId) === String(chat.id)) {
            await ctx.reply(`⚠️ "${chat.title}" is already your destination channel — pick a different one, or /cancel.`);
            return;
        }
        const ids = new Set((cfg.sourceChannelIds || []).map(String));
        ids.add(String(chat.id));
        setAutopostConfig(userId, { sourceChannelIds: Array.from(ids).map(Number) });
        delete pendingAction[userId];
        await ctx.reply(`✅ Added "${chat.title}" as a source channel. New videos posted there will be picked up automatically.`);
        return;
    }

    if (action.type === 'broadcast') {
        delete pendingAction[userId];
        if (getAllUserIds().length === 0) {
            await ctx.reply('No users have used /random yet.');
            return;
        }
        await runTextBroadcast(ctx, text);
        return;
    }

    if (action.type === 'autopost_caption') {
        delete pendingAction[userId];
        setAutopostConfig(userId, { caption: text });
        await ctx.reply('✅ Auto-post caption saved.');
        return;
    }

    if (action.type === 'autopost_interval_custom') {
        delete pendingAction[userId];
        const minutes = parseIntervalToMinutes(text);
        if (!minutes || minutes < 1) {
            await ctx.reply('⚠️ Couldn\'t read that. Send e.g. `45m`, `2h`, `1h30m`, or a plain number of minutes, or /cancel.', { parse_mode: 'Markdown' });
            return;
        }
        setAutopostConfig(userId, { intervalMinutes: minutes });
        await ctx.reply(`✅ Auto-post interval set to every ${formatIntervalMinutes(minutes)}.`);
        return;
    }

    if (action.type === 'about_join_link') {
        const url = text.trim();
        if (!/^https?:\/\//i.test(url)) {
            await ctx.reply('⚠️ Please send a valid URL starting with http:// or https://, or /cancel.');
            return;
        }
        const config = loadConfig();
        config.aboutJoinGroupLink = url;
        saveConfig(config);
        delete pendingAction[userId];
        await ctx.reply('✅ Join Group link saved.');
        return;
    }

    if (action.type === 'about_link_text') {
        const t = text.trim();
        if (!t) {
            await ctx.reply('⚠️ Send some text, or /cancel.');
            return;
        }
        const config = loadConfig();
        config.aboutLinkText = t;
        saveConfig(config);
        delete pendingAction[userId];
        await ctx.reply('✅ Link text saved.');
        return;
    }

    if (action.type === 'about_link_url') {
        const url = text.trim();
        if (!/^https?:\/\//i.test(url)) {
            await ctx.reply('⚠️ Please send a valid URL starting with http:// or https://, or /cancel.');
            return;
        }
        const config = loadConfig();
        config.aboutLinkUrl = url;
        saveConfig(config);
        delete pendingAction[userId];
        await ctx.reply('✅ Link URL saved.');
        return;
    }

    if (action.type === 'redeem_code') {
        delete pendingAction[userId];
        await handleRedeemCode(ctx, text.trim());
        return;
    }

    if (action.type === 'promo_create') {
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) {
            await ctx.reply('⚠️ Send: `CODE DAYS [MAXUSES]` (e.g. `SUMMER30 30`), or /cancel.', { parse_mode: 'Markdown' });
            return;
        }
        const [codeRaw, daysRaw, maxUsesRaw] = parts;
        const days = parseInt(daysRaw, 10);
        const maxUses = maxUsesRaw ? parseInt(maxUsesRaw, 10) : 0;
        if (isNaN(days) || days < 0) {
            await ctx.reply('⚠️ DAYS must be a whole number, 0 or more (0 = lifetime). Try again, or /cancel.');
            return;
        }
        if (maxUsesRaw && (isNaN(maxUses) || maxUses < 0)) {
            await ctx.reply('⚠️ MAXUSES must be a whole number, 0 or more (0 = unlimited people). Try again, or /cancel.');
            return;
        }
        const result = createPromoCode(codeRaw, days, maxUses, userId);
        delete pendingAction[userId];
        if (!result.success) {
            await ctx.reply(result.reason === 'exists' ? `⚠️ Code \`${codeRaw.toUpperCase()}\` already exists.` : '⚠️ Could not create that code.', { parse_mode: 'Markdown' });
            return;
        }
        const durationText = days > 0 ? `${days} day(s)` : 'Lifetime';
        const usesText = maxUses > 0 ? `${maxUses} user(s)` : 'Unlimited users';
        await ctx.reply(
            `✅ Promo code created!\n\n` +
            `Code: \`${result.code.code}\`\n` +
            `Grants: ${durationText} VIP\n` +
            `Redeemable by: ${usesText}\n\n` +
            `Share this with the user — they redeem it with /redeem or the 🎟 Redeem Code button.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    if (action.type === 'promo_delete') {
        const code = text.trim().toUpperCase();
        const deleted = deletePromoCode(code);
        delete pendingAction[userId];
        await ctx.reply(deleted ? `✅ Code \`${code}\` deleted.` : `⚠️ Code \`${code}\` not found.`, { parse_mode: 'Markdown' });
        return;
    }

    if (action.type === 'vip_channel_link') {
        const url = text.trim();
        if (!/^https?:\/\//i.test(url)) {
            await ctx.reply('⚠️ Please send a valid URL starting with http:// or https://, or /cancel.');
            return;
        }
        const config = loadConfig();
        config.vipChannelLink = url;
        saveConfig(config);
        delete pendingAction[userId];
        await ctx.reply('✅ VIP channel link saved. The "💎 Buy VIP" button is now active.');
        return;
    }

    if (action.type === 'vip_promo_text') {
        const t = text.trim();
        if (!t) {
            await ctx.reply('⚠️ Send some text, or /cancel.');
            return;
        }
        const config = loadConfig();
        config.vipPromoText = t;
        saveConfig(config);
        delete pendingAction[userId];
        await ctx.reply('✅ Promo text saved.');
        return;
    }

    if (action.type === 'cat_setchannel_manual') {
        const identifier = text.trim();
        if (!identifier) {
            await ctx.reply('⚠️ Send a chat ID (e.g. -1001234567890) or @username, or /cancel.');
            return;
        }
        let chat;
        try {
            const target = identifier.startsWith('@') || isNaN(identifier) ? identifier : Number(identifier);
            chat = await ctx.telegram.getChat(target);
        } catch (error) {
            await ctx.reply(`❌ Couldn't find that chat (${error.message}). Make sure I'm added there, then try again, or /cancel.`);
            return;
        }
        try {
            await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
        } catch (error) {
            await ctx.reply(`⚠️ Found "${chat.title}" but I don't seem to be a member/admin there. Add me first, then try again, or /cancel.`);
            return;
        }
        recordKnownChat(chat.id, chat.title, chat.type);
        const config = loadConfig();
        config.categoryStorageChannelId = chat.id;
        saveConfig(config);
        delete pendingAction[userId];
        await ctx.reply(`✅ VIP category videos will now be archived in "${chat.title}".`, {
            reply_markup: { inline_keyboard: [[{ text: '📂 Categories', callback_data: 'cat_menu' }]] }
        });
        return;
    }

    if (action.type === 'cat_create_name') {
        const result = createCategory(text, userId);
        delete pendingAction[userId];
        if (!result.success) {
            const reason = result.reason === 'exists' ? 'A category with that name already exists.'
                : result.reason === 'too_long' ? 'That name is too long (max 64 characters).'
                : 'Please send a non-empty name.';
            await ctx.reply(`⚠️ ${reason} Try again from the Categories menu.`, {
                reply_markup: { inline_keyboard: [[{ text: '📂 Categories', callback_data: 'cat_menu' }]] }
            });
            return;
        }
        await ctx.reply(`✅ Category "${result.category.name}" created.`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '➕ Add Videos Now', callback_data: `cat_addvideo:${result.category.id}` }],
                    [{ text: '📂 Categories', callback_data: 'cat_menu' }]
                ]
            }
        });
        return;
    }

    if (action.type === 'cat_rename') {
        const { categoryId } = action;
        const result = renameCategory(categoryId, text);
        delete pendingAction[userId];
        if (!result.success) {
            const reason = result.reason === 'exists' ? 'A category with that name already exists.'
                : result.reason === 'too_long' ? 'That name is too long (max 64 characters).'
                : result.reason === 'not_found' ? 'That category no longer exists.'
                : 'Please send a non-empty name.';
            await ctx.reply(`⚠️ ${reason}`, {
                reply_markup: { inline_keyboard: [[{ text: '📂 Categories', callback_data: 'cat_menu' }]] }
            });
            return;
        }
        await ctx.reply(`✅ Renamed to "${result.category.name}".`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Category', callback_data: `cat_admin:${categoryId}` }]] }
        });
        return;
    }

    if (CUSTOM_FIELD_MAP[action.type]) {
        const { key, label, min } = CUSTOM_FIELD_MAP[action.type];
        const n = parseInt(text.trim(), 10);
        if (isNaN(n) || n < min) {
            await ctx.reply(`⚠️ Send a whole number (${min}+) for ${label}, or /cancel.`);
            return;
        }
        const config = loadConfig();
        config[key] = n;
        saveConfig(config);
        delete pendingAction[userId];
        await ctx.reply(`✅ ${label} set to ${n}.`);
        return;
    }

    delete pendingAction[userId];
}

bot.on('message', async (ctx) => {
    const text = ctx.message.text;

    if (ctx.chat.type !== 'private') trackKnownChat(ctx);

    // --- Pending button-flow input (private chat, admin only) ---
    if (ctx.chat.type === 'private' && isAdmin(ctx.from.id) && pendingAction[ctx.from.id]) {
        await handlePendingAction(ctx, text || '');
        return;
    }

    if (!text) return;

    const megaLink = cleanMegaLink(text);

    if (!megaLink) {
        if (ctx.chat.type !== 'private') {
            const botUsername = ctx.botInfo?.username;
            if (botUsername && text.includes(`@${botUsername}`)) {
                await ctx.reply(`🤖 Hi! Send me a MEGA link to download files.\n\nExample: \`https://mega.nz/file/ABC123#XYZ456\``, {
                    parse_mode: 'Markdown'
                });
            }
        }
        return;
    }

    console.log(`🔍 Detected MEGA link in ${ctx.chat.type} ${ctx.chat.id}`);

    if (!isAdmin(ctx.from.id)) {
        if (ctx.chat.type === 'private') {
            await logUnauthorizedAccess(ctx, 'mega_link_download');
            await ctx.reply('❌ This feature is available to admins only.');
        }
        return;
    }

    if (ctx.chat.type !== 'private') {
        try {
            const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);

            if (ctx.chat.type === 'channel') {
                if (chatMember.status !== 'administrator') {
                    console.log(`❌ Bot is not admin in channel ${ctx.chat.id}`);

                    if (ctx.from) {
                        try {
                            await ctx.telegram.sendMessage(
                                ctx.from.id,
                                `❌ I cannot process MEGA links in this channel because I'm not an admin.\n\nPlease make me an admin with permission to read and post messages.`
                            );
                        } catch (e) {
                            console.error('Cannot send private message:', e.message);
                        }
                    }
                    return;
                }

                if (!chatMember.can_post_messages) {
                    console.log(`❌ Bot cannot post messages in channel ${ctx.chat.id}`);
                    return;
                }
            }

            if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
                if (chatMember.status === 'restricted') {
                    // Check if bot can send messages
                    if (!chatMember.can_send_messages) {
                        console.log(`❌ Bot cannot send messages in group ${ctx.chat.id}`);
                        return;
                    }
                } else if (chatMember.status !== 'administrator' && chatMember.status !== 'member') {
                    console.log(`❌ Bot doesn't have proper status in group ${ctx.chat.id}: ${chatMember.status}`);
                    return;
                }
            }

        } catch (error) {
            console.error(`❌ Error checking permissions in ${ctx.chat.type} ${ctx.chat.id}:`, error.message);
            return;
        }
    }

    await queue.add(() => processMegaLink(ctx, megaLink));
});

bot.on('document', (ctx) => {
    if (ctx.chat.type === 'private') {
        ctx.reply('📎 Send me a MEGA link to download files!\n\nExample:\n\`https://mega.nz/file/ABC123#XYZ456\`', {
            parse_mode: 'Markdown'
        });
    }
});

bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    try {
        if (ctx.chat.type === 'private') {
            ctx.reply('❌ An internal error occurred. Please try again.');
        }
    } catch (e) {
        console.error('Failed to send error:', e);
    }
});

// Catches any error thrown inside command/action handlers that wasn't
// already try/caught locally, so a single bad update can't crash the bot
// silently — it gets logged (and sent to the error log channel if set).
bot.catch((error, ctx) => {
    if (isMessageNotModifiedError(error)) return; // harmless no-op, nothing to fix or log
    logError(`Handler error (${ctx.updateType})`, error);
});

process.on('unhandledRejection', (error) => {
    logError('Unhandled promise rejection', error);
});

process.on('uncaughtException', (error) => {
    logError('Uncaught exception', error);
});

bot.telegram.getMe().then(async botInfo => {
    botUsername = botInfo.username;
    console.log(`🤖 Bot username: @${botUsername}`);

    console.log('🚀 Starting MEGA Downloader Bot...');
    console.log('👥 Working in: Private chats, Groups, Channels');
    console.log('📁 Temp directory:', os.tmpdir());
    console.log('🔗 Bot invite link: https://t.me/' + botUsername);

    // IMPORTANT: bot.launch() in long-polling mode returns a Promise that
    // only resolves once the bot is *stopped* — it never resolves during
    // normal operation. Anything placed in a `.then()` after it therefore
    // never runs while the bot is up. So all one-time startup work AND the
    // background schedulers (scheduled broadcasts, auto-post ticks, delayed
    // join approvals) are set up here, before launch() is called — not
    // chained after it.
    await setupCommandMenus();

    // Background schedulers: scheduled broadcasts + per-admin auto-posts +
    // delayed join approvals. Checked every 60s — cheap and frequent enough
    // for hour-scale intervals.
    setInterval(() => {
        processDueScheduledBroadcasts().catch(err => logError('Scheduled broadcast tick', err));
    }, 60 * 1000);
    setInterval(() => {
        processAutopostTicks().catch(err => logError('Auto-post tick', err));
    }, 60 * 1000);
    setInterval(() => {
        checkDailyHealthReport().catch(err => logError('Daily health check', err));
    }, 60 * 1000);
    setInterval(() => {
        checkWeeklySummary().catch(err => logError('Weekly summary', err));
    }, 60 * 1000);
    setInterval(() => {
        checkAutoBackup().catch(err => logError('Auto config backup', err));
    }, 60 * 1000);
    setInterval(() => {
        processDelayedJoinApprovals().catch(err => logError('Delayed join approval tick', err));
    }, 60 * 1000);
    setInterval(() => {
        processDuePendingDeletions().catch(err => logError('Pending deletion tick', err));
    }, 60 * 1000);
    // Also run once immediately at startup so any auto-delete that was due
    // *during* the downtime (bot was off) gets cleaned up right away instead
    // of waiting for the first 60s tick.
    processDuePendingDeletions().catch(err => logError('Pending deletion startup sweep', err));

    bot.launch()
        .catch(err => {
            console.error('❌ Failed to start bot:', err);
            logError('Bot launch', err);
            process.exit(1);
        });

    // launch() won't resolve while running (see note above), so log
    // "started" right after kicking it off rather than waiting on it.
    console.log('✅ Bot started successfully!');
    console.log('🔗 Ready to process MEGA links in all chat types...');
    console.log('\n=== IMPORTANT FOR GROUPS/CHANNELS ===');
    console.log('1. Add bot to group/channel as ADMIN');
    console.log('2. Enable these permissions:');
    console.log('   • Read messages (IMPORTANT!)');
    console.log('   • Send messages');
    console.log('   • Send media');
    console.log('   • Send documents');
    console.log('3. Users can then just send MEGA links');
    console.log('====================================');
}).catch(err => {
    console.error('❌ Failed to get bot info:', err);
    process.exit(1);
});

process.once('SIGINT', () => {
    console.log('🛑 Shutting down...');
    bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
    console.log('🛑 Shutting down...');
    bot.stop('SIGTERM');
});
