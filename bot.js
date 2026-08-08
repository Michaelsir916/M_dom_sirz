const { Telegraf } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mega = require('megajs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');
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
} = require('./fileShare');
const queue = require('./queue');

const bot = new Telegraf(process.env.BOT_TOKEN);

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

// --- Error log channel ---
// Sends bot errors to an admin-configured Telegram chat (set via /setlogchannel)
// so crashes/bugs can be spotted without SSH-ing into Termux to read logs.
async function logError(label, error) {
    const message = (error && error.message) ? error.message : String(error);
    const stack = (error && error.stack) ? error.stack.split('\n').slice(0, 4).join('\n') : '';
    console.error(`❌ ${label}:`, message);

    try {
        const config = loadConfig();
        if (!config.errorLogChatId) return;
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const text = `🚨 *Bot Error*\n\n*When:* ${timestamp} IST\n*Where:* ${label}\n*Error:* \`${message}\`` +
            (stack ? `\n\n\`\`\`\n${stack}\n\`\`\`` : '');
        try {
            await bot.telegram.sendMessage(config.errorLogChatId, text, { parse_mode: 'Markdown' });
        } catch (parseErr) {
            // Error text itself sometimes contains unbalanced Markdown
            // entities (backticks/underscores/asterisks) — fall back to
            // plain text so the log message still gets through.
            const plain = `🚨 Bot Error\n\nWhen: ${timestamp} IST\nWhere: ${label}\nError: ${message}` + (stack ? `\n\n${stack}` : '');
            await bot.telegram.sendMessage(config.errorLogChatId, plain);
        }
    } catch (logSendError) {
        console.error('Cannot send to error log channel:', logSendError.message);
    }
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
    // one specific video, same as /random (copyMessage, respects forward protection).
    if (chatType === 'private' && ctx.startPayload && ctx.startPayload.startsWith('get-')) {
        const decoded = decodeFileTag(ctx.startPayload);
        if (decoded) {
            const config = loadConfig();
            try {
                await ctx.telegram.copyMessage(ctx.chat.id, decoded.chatId, decoded.messageId,
                    config.protectContent ? { protect_content: true } : {});
            } catch (error) {
                await ctx.reply('❌ Sorry, this file is no longer available.');
            }
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
        // delay) — sending the join request itself is treated as proof.
        return hasJoinRequest(groupId, userId);
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

    buttons.push([{ text: '✅ I\'ve Joined — Verify', callback_data: 'recheck_sub' }]);

    await ctx.reply('🔒 *Tap below to request access — then tap Verify*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    });
}

// Picks up to `count` files this user hasn't seen yet, sends them via
// copyMessage (no forward tag), marks them seen, and self-heals dead entries.
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

            if (config.autoDeleteMinutes > 0) {
                const ms = config.autoDeleteMinutes * 60 * 1000;
                setTimeout(() => {
                    ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
                }, ms);
            }
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

// --- User-facing: My Stats & Referrals ---
const MY_STATS_KEYBOARD = {
    inline_keyboard: [
        [{ text: '🎬 Free Video', callback_data: 'user_random' }],
        [{ text: '📊 My Stats', callback_data: 'user_mystats' }],
        [{ text: '🎁 Invite & Earn', callback_data: 'user_referral' }]
    ]
};

function formatMyStats(userId) {
    const config = loadConfig();
    const s = getUserStats(userId, config.cooldownSeconds, config.dailyLimit);

    let cooldownLine = '✅ Ready now';
    if (s.cooldownRemaining > 0) {
        cooldownLine = `⏳ ${s.cooldownRemaining}s remaining`;
    }

    let dailyLine = '♾️ Unlimited';
    if (s.dailyRemaining !== null) {
        dailyLine = `${s.dailyRemaining} left today`;
    }

    return `📊 *Your Stats*\n\n` +
        `Files received (all-time): ${s.totalFilesReceived}\n` +
        `/random requests today: ${s.requestsToday}\n` +
        `Cooldown: ${cooldownLine}\n` +
        `Daily limit: ${dailyLine}\n\n` +
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
    const replyMarkup = { inline_keyboard: [[{ text: '📤 Share with Friends', url: shareUrl }]] };

    return { text, replyMarkup };
}

bot.command('myreferral', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const { text, replyMarkup } = await formatMyReferral(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: replyMarkup });
});

bot.action('user_referral', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, replyMarkup } = await formatMyReferral(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: replyMarkup });
});

// --- Admin: force-sub group management ---
bot.command('setforcesub', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
    const config = loadConfig();
    config.errorLogChatId = null;
    saveConfig(config);
    await ctx.reply('✅ Error log channel removed. Errors will only go to console now.');
});

// --- Admin: settings ---
bot.command('setcount', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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

bot.command('setreferralbonus', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
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
    if (!isAdmin(ctx.from.id)) return;
    const pending = getPendingScheduledBroadcasts();
    if (pending.length === 0) {
        await ctx.reply('No scheduled broadcasts pending.');
        return;
    }
    const lines = pending.map(s => `• \`${s.id}\` — ${new Date(s.sendAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST — "${(s.text || s.caption || '').slice(0, 50)}"`);
    await ctx.reply(`⏰ *Pending Scheduled Broadcasts*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

bot.command('cancelbroadcast', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
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
    const config = loadConfig();
    if (config.forceSubGroupIds.length === 0) {
        await ctx.reply('⚠️ Force-sub group is not configured yet. Please ask the admin.');
        return;
    }

    const unjoined = await getUnjoinedGroups(ctx, config.forceSubGroupIds, ctx.from.id);
    if (unjoined.length > 0) {
        await sendJoinPrompt(ctx, unjoined);
        return;
    }

    const check = checkRandomAllowed(ctx.from.id, config);
    if (!check.allowed) {
        if (check.reason === 'cooldown') {
            await ctx.reply(`⏳ Please wait ${check.retryAfter} second(s) and try again.`);
        } else {
            await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow, or use /myreferral to earn bonus credits.`);
        }
        return;
    }
    if (check.usedBonus) {
        await ctx.reply('💎 Used 1 bonus credit (daily limit reached).');
    }

    await sendRandomFiles(ctx);
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

    const check = checkRandomAllowed(ctx.from.id, config);
    if (!check.allowed) {
        if (check.reason === 'cooldown') {
            await ctx.reply(`⏳ Please wait ${check.retryAfter} second(s) and try again.`);
        } else {
            await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow, or use /myreferral to earn bonus credits.`);
        }
        return;
    }
    if (check.usedBonus) {
        await ctx.reply('💎 Used 1 bonus credit (daily limit reached).');
    }

    await sendRandomFiles(ctx);
});

// --- Admin-only /start menu ---
const ADMIN_START_TEXT = 'Welcome, Admin!\n\nChoose a section to manage:';
const ADMIN_START_KEYBOARD = {
    inline_keyboard: [
        [{ text: '📦 Mega Management', callback_data: 'menu_mega' }],
        [{ text: '🎬 File Sharing', callback_data: 'menu_fileshare' }]
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
        { command: 'cancelbroadcast', description: 'Cancel a scheduled broadcast' }
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
        `Source: ${sourceLabel}\n\n` +
        '_Everything below is button-driven — no need to enter the target chat._';

    const keyboard = {
        inline_keyboard: [
            [{ text: '➕ Add Force-Sub', callback_data: 'fs_addfs_menu' }, { text: '📋 Force-Sub List', callback_data: 'fs_listforcesub' }],
            [{ text: '🎯 Set Source', callback_data: 'fs_setsrc_menu' }],
            [{ text: '📁 List Files', callback_data: 'fs_listfiles' }, { text: '📊 Stats', callback_data: 'fs_stats' }],
            [{ text: `🔢 Per Request: ${config.shareCount}`, callback_data: 'fs_count_menu' }],
            [{ text: `⏱ Cooldown: ${config.cooldownSeconds}s`, callback_data: 'fs_cooldown_menu' }],
            [{ text: `📆 Daily Limit: ${config.dailyLimit === 0 ? 'Unlimited' : config.dailyLimit}`, callback_data: 'fs_dailylimit_menu' }],
            [{ text: `🗑 Auto-Delete: ${config.autoDeleteMinutes === 0 ? 'Off' : config.autoDeleteMinutes + 'm'}`, callback_data: 'fs_autodelete_menu' }],
            [{ text: `🔐 Forward Protection: ${config.protectContent ? 'ON' : 'OFF'}`, callback_data: 'fs_toggle_protect' }],
            [{ text: '📢 Broadcast', callback_data: 'fs_broadcast_menu' }],
            [{ text: '🖼 Auto-Post', callback_data: 'ap_menu' }],
            [{ text: '🛠 Maintenance Mode', callback_data: 'mm_menu' }],
            [{ text: '📦 MEGA Upload Destination', callback_data: 'mud_menu' }],
            [{ text: '🔙 Back', callback_data: 'menu_back' }]
        ]
    };

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('fs_toggle_protect', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const config = loadConfig();
    config.protectContent = !config.protectContent;
    saveConfig(config);
    await ctx.answerCbQuery(`Forward protection ${config.protectContent ? 'ON' : 'OFF'}`);
    await renderFileSharePanel(ctx);
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await renderMaintenancePanel(ctx);
});

bot.action('mm_toggle', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const config = loadConfig();
    config.maintenanceMode = !config.maintenanceMode;
    saveConfig(config);
    await ctx.answerCbQuery(config.maintenanceMode ? '🔴 Maintenance ON' : '🟢 Maintenance OFF');
    await renderMaintenancePanel(ctx);
});

bot.action('mm_add_user', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'mm_add_user' };
    await ctx.editMessageText('⌨️ Send the Telegram user ID to allow during maintenance, or /cancel.\n\n_Tip: ask them to send /start to any bot that shows their ID, e.g. @userinfobot._', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'mm_menu' }]] }
    });
});

bot.action('mm_remove_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
        (config.megaUploadMode === 'channel' ? `Channel: ${channelLabel}\n` : '') +
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await renderMegaUploadPanel(ctx);
});

bot.action(/^mud_mode:(personal|channel)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    const rows = chats.slice(0, 20).map(c => [{ text: `${chatTypeIcon(c.type)} ${c.title}`, callback_data: `${prefix}:${c.id}` }]);
    rows.push([{ text: '⌨️ Type ID / @username instead', callback_data: `${prefix}_manual` }]);
    rows.push([{ text: '🔙 Back', callback_data: backCallback }]);
    return { rows, truncated: chats.length > 20, total: chats.length };
}

bot.action('menu_fileshare', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await renderFileSharePanel(ctx);
});

// --- Read-only panels ---
bot.action('fs_listfiles', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const chatId = Number(ctx.match[1]);
    const settings = getForceSubSettings(chatId);
    const next = settings.mode === 'pending' ? 'auto' : 'pending';
    setForceSubSettings(chatId, { mode: next });
    await ctx.answerCbQuery(next === 'pending' ? '⏳ Pending mode ON' : '🔓 Auto-approve ON');
    await renderForceSubList(ctx);
});

bot.action(/^fs_fsdelay_menu:(-?\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const chatId = Number(ctx.match[1]);
    const hours = Number(ctx.match[2]);
    setForceSubSettings(chatId, { delayHours: hours });
    await ctx.answerCbQuery(hours === 0 ? 'Set to manual-only' : `✅ Auto-approve in ${hours}h`);
    await renderForceSubList(ctx);
});

bot.action('fs_listforcesub', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await renderForceSubList(ctx);
});

bot.action('noop', async (ctx) => ctx.answerCbQuery());

bot.action(/^fs_rmfs:(-?\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const chatId = Number(ctx.match[1]);
    const config = loadConfig();
    config.forceSubGroupIds = config.forceSubGroupIds.filter(id => id !== chatId);
    saveConfig(config);
    await ctx.answerCbQuery('✅ Removed');
    await renderForceSubList(ctx);
});

// --- Add Force-Sub (button-driven, no need to enter the target chat) ---
bot.action('fs_addfs_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const config = loadConfig();
    const { rows, truncated, total } = knownChatPickerKeyboard(config.forceSubGroupIds, 'fs_addfs', 'menu_fileshare', ctx.from.id);
    const note = total === 0
        ? '_I haven\'t seen any groups/channels yet — add me to one first, or type an ID/@username._'
        : truncated ? `_Showing 20 of ${total} known chats._` : '';
    await ctx.editMessageText(`➕ *Add Force-Sub*\n\nTap a group/channel I already know, or enter one manually.\n\n${note}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^fs_addfs:(-?\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'add_forcesub_manual' };
    await ctx.editMessageText('⌨️ Send the group/channel ID (e.g. `-1001234567890`) or `@username`.\n\nI must already be a member/admin there. Send /cancel to abort.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'fs_listforcesub' }]] }
    });
});

// --- Set Source (button-driven) ---
bot.action('fs_setsrc_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
            [{ text: '📤 Send Now', callback_data: 'fs_broadcast_send' }],
            [{ text: `🔁 Forward: ${config.broadcastForwardMode ? 'ON' : 'OFF'}`, callback_data: 'fs_toggle_forward' }],
            [{ text: '📜 History', callback_data: 'fs_broadcast_history' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('fs_broadcast_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await renderBroadcastMenu(ctx);
});

bot.action('fs_toggle_forward', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const config = loadConfig();
    config.broadcastForwardMode = !config.broadcastForwardMode;
    saveConfig(config);
    await ctx.answerCbQuery(`Forward mode ${config.broadcastForwardMode ? 'ON' : 'OFF'}`);
    await renderBroadcastMenu(ctx);
});

bot.action('fs_broadcast_history', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
        return await sharp(buffer).blur(25).toBuffer();
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

// Core auto-post engine, shared by the "🧪 Test Preview" setup flow and the
// automatic interval-based scheduler. preview=true sends the candidate post
// to the admin's own DM with Confirm/Skip instead of posting to the channel
// — setup-time only. Scheduled runs (preview=false) post directly, no confirm.
async function runAutopostForAdmin(adminId, { preview = false } = {}) {
    const cfg = getAutopostConfig(adminId);
    if (!cfg.channelId) return { error: 'no_channel' };

    const files = loadSharedFiles().filter(f => f.type === 'video');
    const unposted = files.filter(f => !cfg.postedTags.includes(`${f.chat_id}:${f.message_id}`));
    if (unposted.length === 0) return { error: 'no_files' };
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
            markAutopostTagSkipped(adminId, tag);
            return { error: 'no_thumbnail_skipped' };
        }
        const buffer = await downloadTelegramFile(thumbFileId);
        if (!buffer) {
            markAutopostTagSkipped(adminId, tag);
            return { error: 'no_thumbnail_skipped' };
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

    if (preview) {
        const msg = await bot.telegram.sendPhoto(adminId, thumbSource, {
            caption: `🧪 Preview\n\n${cfg.caption}`,
            reply_markup: { inline_keyboard: [
                [{ text: '✅ Post to Channel', callback_data: 'ap_confirm' }, { text: '❌ Skip', callback_data: 'ap_cancel' }]
            ] }
        });
        pendingAutopostPreview[adminId] = { tag, caption: cfg.caption, thumbSource, keyboard };
        return { previewed: true };
    }

    try {
        await bot.telegram.sendPhoto(cfg.channelId, thumbSource, { caption: cfg.caption, reply_markup: keyboard });
        markAutopostTagPosted(adminId, tag);
        return { posted: true, tag };
    } catch (err) {
        if (err.description && (err.description.includes('file') || err.description.includes('photo'))) {
            markAutopostTagSkipped(adminId, tag);
            return { error: 'bad_thumbnail_skipped' };
        }
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
        if (!cfg.enabled || !cfg.channelId || !cfg.intervalMinutes) continue;
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

async function renderAutopostPanel(ctx) {
    const adminId = ctx.from.id;
    const cfg = getAutopostConfig(adminId);
    const channelLabel = cfg.channelId
        ? (getKnownChats().find(c => String(c.id) === String(cfg.channelId))?.title || cfg.channelId)
        : 'Not set';
    const text = '🖼 *Auto-Post* (only visible/controllable by you)\n\n' +
        `Channel: ${channelLabel}\n` +
        `Interval: ${cfg.intervalMinutes === 0 ? 'Not set' : 'Every ' + formatIntervalMinutes(cfg.intervalMinutes)}\n` +
        `Caption: "${cfg.caption}"\n` +
        `Thumbnail: ${cfg.thumbnailMode === 'custom' ? (cfg.customThumbnailFileId ? 'Custom (uploaded)' : 'Custom (not uploaded yet!)') : "Video's own"}\n` +
        `Blur: ${cfg.blurEnabled ? 'ON' : 'OFF'}${sharp ? '' : ' (⚠️ sharp not installed — run npm install)'}\n` +
        `Status: ${cfg.enabled ? '✅ Running' : '⏸ Paused'}\n` +
        `Posted so far: ${cfg.postedTags.length}`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '🎯 Set Channel', callback_data: 'ap_setchannel_menu' }],
            [{ text: `⏱ Interval: ${formatIntervalMinutes(cfg.intervalMinutes)}`, callback_data: 'ap_interval_menu' }],
            [{ text: '✏️ Set Caption', callback_data: 'ap_caption' }],
            [{ text: `🖼 Thumbnail Source: ${cfg.thumbnailMode === 'custom' ? 'Custom' : 'Video'}`, callback_data: 'ap_thumb_toggle' }],
            [{ text: '📤 Upload Custom Thumbnail', callback_data: 'ap_thumb_upload' }],
            [{ text: `🔵 Blur: ${cfg.blurEnabled ? 'ON' : 'OFF'}`, callback_data: 'ap_blur_toggle' }],
            [{ text: cfg.enabled ? '⏸ Pause' : '▶️ Enable', callback_data: 'ap_toggle_enabled' }],
            [{ text: '🧪 Test Preview', callback_data: 'ap_test' }],
            [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]
        ]
    };
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.action('ap_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await renderAutopostPanel(ctx);
});

bot.action('ap_setchannel_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const { rows, truncated, total } = knownChatPickerKeyboard([], 'ap_setchannel', 'ap_menu', ctx.from.id);
    const note = total === 0
        ? '_I haven\'t seen any channels yet — add me to yours as admin first, or type an ID/@username._'
        : truncated ? `_Showing 20 of ${total} known chats._` : '';
    await ctx.editMessageText(`🎯 *Set Your Auto-Post Channel*\n\nOnly you post here — pick your own channel.\n\n${note}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
    });
});

bot.action(/^ap_setchannel:(-?\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const chatId = Number(ctx.match[1]);
    setAutopostConfig(ctx.from.id, { channelId: chatId });
    const chat = getKnownChats().find(c => String(c.id) === String(chatId));
    await ctx.answerCbQuery('✅ Channel set');
    await ctx.editMessageText(`✅ Auto-post channel set to "${chat ? chat.title : chatId}".`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_setchannel_manual', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'ap_setchannel_manual' };
    await ctx.editMessageText('⌨️ Send the channel ID (e.g. `-1001234567890`) or `@username`.\n\nI must already be admin there. Send /cancel to abort.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_interval_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const cfg = getAutopostConfig(ctx.from.id);
    const minuteRow = [15, 30, 45].map(m => ({ text: `${m}m`, callback_data: `ap_interval:${m}` }));
    const hourRow = [1, 3, 6, 12, 24].map(h => ({ text: `${h}h`, callback_data: `ap_interval:${h * 60}` }));
    await ctx.editMessageText(`⏱ *Auto-Post Interval*\n\nCurrent: ${formatIntervalMinutes(cfg.intervalMinutes)}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [minuteRow, hourRow, [{ text: '✏️ Custom', callback_data: 'ap_interval_custom' }], [{ text: '🔙 Back', callback_data: 'ap_menu' }]] }
    });
});

bot.action(/^ap_interval:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const n = parseInt(ctx.match[1], 10);
    setAutopostConfig(ctx.from.id, { intervalMinutes: n });
    await ctx.answerCbQuery(`✅ Every ${formatIntervalMinutes(n)}`);
    await renderAutopostPanel(ctx);
});

bot.action('ap_interval_custom', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'autopost_interval_custom' };
    await ctx.editMessageText('✏️ Send the interval — e.g. `45m`, `2h`, `1h30m`, or just a number for minutes, or /cancel.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_interval_menu' }]] }
    });
});

bot.action('ap_caption', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'autopost_caption' };
    await ctx.editMessageText('✏️ Send the caption to use for every auto-post, or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_thumb_toggle', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const cfg = getAutopostConfig(ctx.from.id);
    const next = cfg.thumbnailMode === 'custom' ? 'video' : 'custom';
    setAutopostConfig(ctx.from.id, { thumbnailMode: next });
    await ctx.answerCbQuery(`Thumbnail source: ${next}`);
    await renderAutopostPanel(ctx);
});

bot.action('ap_thumb_upload', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'autopost_thumbnail' };
    await ctx.editMessageText('📤 Send the photo to use as the thumbnail for every auto-post, or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ap_menu' }]] }
    });
});

bot.action('ap_blur_toggle', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const cfg = getAutopostConfig(ctx.from.id);
    if (!cfg.enabled) {
        if (!cfg.channelId) { await ctx.answerCbQuery('⚠️ Set a channel first.'); return; }
        if (!cfg.intervalMinutes) { await ctx.answerCbQuery('⚠️ Set an interval first.'); return; }
    }
    setAutopostConfig(ctx.from.id, { enabled: !cfg.enabled });
    await ctx.answerCbQuery(!cfg.enabled ? '▶️ Enabled' : '⏸ Paused');
    await renderAutopostPanel(ctx);
});

bot.action('ap_test', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const cfg = getAutopostConfig(ctx.from.id);
    if (!cfg.channelId) { await ctx.answerCbQuery('⚠️ Set a channel first.'); return; }
    await ctx.answerCbQuery('🧪 Generating preview...');
    const result = await runAutopostForAdmin(ctx.from.id, { preview: true });
    if (result.error === 'no_files') await ctx.reply('⚠️ No unposted videos in the source pool yet.');
    else if (result.error === 'no_thumbnail') await ctx.reply('⚠️ Could not read a thumbnail from that video — try uploading a custom thumbnail instead (🖼 Thumbnail Source → Custom).');
});

bot.action('ap_confirm', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
        await ctx.answerCbQuery('❌ Failed to post.');
        logError('Auto-post confirm', error);
    }
    delete pendingAutopostPreview[ctx.from.id];
});

bot.action('ap_cancel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    delete pendingAutopostPreview[ctx.from.id];
    await ctx.answerCbQuery('Skipped');
    await ctx.editMessageCaption('❌ Skipped — not posted.').catch(() => {});
});

// --- Quick-preset setting panels ---
function presetRow(values, prefix, suffix = '') {
    return values.map(v => ({ text: `${v}${suffix}`, callback_data: `${prefix}:${v}` }));
}

bot.action('fs_count_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`🔢 *Files per Request*\n\nCurrent: ${config.shareCount}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([1, 2, 3, 5], 'fs_count'), [{ text: '✏️ Custom', callback_data: 'fs_custom_count' }], [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_cooldown_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`⏱ *Cooldown*\n\nCurrent: ${config.cooldownSeconds}s`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([0, 10, 15, 30, 60], 'fs_cooldown', 's'), [{ text: '✏️ Custom', callback_data: 'fs_custom_cooldown' }], [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_dailylimit_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`📆 *Daily Limit*\n\nCurrent: ${config.dailyLimit === 0 ? 'Unlimited' : config.dailyLimit}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([0, 5, 10, 20], 'fs_dailylimit'), [{ text: '✏️ Custom', callback_data: 'fs_custom_dailylimit' }], [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_autodelete_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const n = parseInt(ctx.match[1], 10);
    const config = loadConfig();
    config.shareCount = n;
    saveConfig(config);
    await ctx.answerCbQuery(`✅ Set to ${n}`);
    await renderFileSharePanel(ctx);
});

bot.action(/^fs_cooldown:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const n = parseInt(ctx.match[1], 10);
    const config = loadConfig();
    config.cooldownSeconds = n;
    saveConfig(config);
    await ctx.answerCbQuery(`✅ Set to ${n}s`);
    await renderFileSharePanel(ctx);
});

bot.action(/^fs_dailylimit:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const n = parseInt(ctx.match[1], 10);
    const config = loadConfig();
    config.dailyLimit = n;
    saveConfig(config);
    await ctx.answerCbQuery(`✅ Set to ${n === 0 ? 'unlimited' : n}`);
    await renderFileSharePanel(ctx);
});

bot.action(/^fs_autodelete:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    const n = parseInt(ctx.match[1], 10);
    const config = loadConfig();
    config.autoDeleteMinutes = n;
    saveConfig(config);
    await ctx.answerCbQuery(`✅ Set to ${n === 0 ? 'off' : n + 'm'}`);
    await renderFileSharePanel(ctx);
});

bot.action('menu_back', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
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
// Group/channel chat: tracks photo/video files posted in the configured
// source group into the share pool (unchanged from before).
bot.on(['photo', 'video', 'animation'], async (ctx) => {
    if (ctx.chat.type === 'private') {
        if (!isAdmin(ctx.from.id)) return;

        const kind = ctx.message.animation ? 'animation' : (ctx.message.video ? 'video' : 'photo');
        const fileId = ctx.message.animation ? ctx.message.animation.file_id
            : ctx.message.video ? ctx.message.video.file_id
            : ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const caption = ctx.message.caption || '';

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
    if (!config.sourceGroupId || String(ctx.chat.id) !== String(config.sourceGroupId)) return;
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    if (!ctx.message.photo && !ctx.message.video) return; // ignore animations for the source pool

    const type = Array.isArray(ctx.message.photo) ? 'photo' : 'video';
    const added = addSharedFile(ctx.chat.id, ctx.message.message_id, type);
    if (added) {
        console.log(`Tracked ${type} msg #${ctx.message.message_id} in share pool`);
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

    // File tracking: only for the already-configured source channel
    if (post.photo || post.video) {
        const config = loadConfig();
        if (config.sourceGroupId && String(ctx.chat.id) === String(config.sourceGroupId)) {
            const type = post.photo ? 'photo' : 'video';
            const added = addSharedFile(ctx.chat.id, post.message_id, type);
            if (added) {
                console.log(`Tracked ${type} msg #${post.message_id} in share pool (channel)`);
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
    logError(`Handler error (${ctx.updateType})`, error);
});

process.on('unhandledRejection', (error) => {
    logError('Unhandled promise rejection', error);
});

process.on('uncaughtException', (error) => {
    logError('Uncaught exception', error);
});

bot.telegram.getMe().then(botInfo => {
    botUsername = botInfo.username;
    console.log(`🤖 Bot username: @${botUsername}`);

    console.log('🚀 Starting MEGA Downloader Bot...');
    console.log('👥 Working in: Private chats, Groups, Channels');
    console.log('📁 Temp directory:', os.tmpdir());
    console.log('🔗 Bot invite link: https://t.me/' + botUsername);

    bot.launch()
        .then(async () => {
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
            await setupCommandMenus();

            // Background schedulers: scheduled broadcasts + per-admin auto-posts.
            // Checked every 60s — cheap and frequent enough for hour-scale intervals.
            setInterval(() => {
                processDueScheduledBroadcasts().catch(err => logError('Scheduled broadcast tick', err));
            }, 60 * 1000);
            setInterval(() => {
                processAutopostTicks().catch(err => logError('Auto-post tick', err));
            }, 60 * 1000);
            setInterval(() => {
                processDelayedJoinApprovals().catch(err => logError('Delayed join approval tick', err));
            }, 60 * 1000);
        })
        .catch(err => {
            console.error('❌ Failed to start bot:', err);
            process.exit(1);
        });
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
