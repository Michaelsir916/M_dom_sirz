const { Telegraf } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mega = require('megajs');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();
const {
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
} = require('./fileShare');
const queue = require('./queue');

const bot = new Telegraf(process.env.BOT_TOKEN);

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

// In-memory "what is this admin currently typing for" state, keyed by admin
// user id. Used so button flows (add force-sub, set source, broadcast, custom
// values) can ask the admin to send one plain message instead of a slash
// command. Cleared on use, on /cancel, or lost on restart (admin just retaps).
const pendingAction = {};

// ===== Reliability helpers: admin notifications =====
function getAdminIds() {
    return (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
}

// Where maintenance/alert messages (dead-link cleanup, error alerts, weekly
// digest, health-check ping) get sent. Defaults to the first admin's DM if
// no adminLogChatId has been configured.
function getLogChatId(config) {
    if (config.adminLogChatId) return config.adminLogChatId;
    const admins = getAdminIds();
    return admins.length > 0 ? admins[0] : null;
}

async function notifyAdmins(text, extra = {}) {
    const admins = getAdminIds();
    for (const id of admins) {
        try {
            await bot.telegram.sendMessage(id, text, { parse_mode: 'Markdown', ...extra });
        } catch (e) {
            console.error(`Could not notify admin ${id}:`, e.message);
        }
    }
}

async function notifyLogChat(text, extra = {}) {
    const config = loadConfig();
    const chatId = getLogChatId(config);
    if (!chatId) return;
    try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
    } catch (e) {
        console.error(`Could not send to log chat ${chatId}:`, e.message);
    }
}

// ===== Error-rate alert =====
// Every recorded error checks whether the threshold was crossed within the
// configured window. Fires ONE grouped alert per window (not per error) so
// admins get a "🚨 High error rate" summary instead of spam.
let lastErrorAlertAt = 0;
async function checkErrorRateAndAlert() {
    const config = loadConfig();
    const windowMs = (config.errorAlertWindowMinutes || 5) * 60 * 1000;
    const recent = getRecentErrors(windowMs);
    if (recent.length < (config.errorAlertThreshold || 5)) return;
    if (Date.now() - lastErrorAlertAt < windowMs) return; // already alerted this window
    lastErrorAlertAt = Date.now();

    const sample = recent.slice(-5).map(e => `• ${e.message}`).join('\n');
    await notifyLogChat(
        `🚨 *High Error Rate*\n\n${recent.length} errors in the last ${config.errorAlertWindowMinutes} minute(s).\n\n*Recent:*\n${sample}`
    );
}

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

// If this MEGA link already produced pool entries, treat re-sending it as a
// delete request (no need to browse /listfiles for the index) instead of
// re-downloading and re-uploading the same file. Returns true if it handled
// the message (i.e. deleted something) so the caller should stop there.
async function tryDeleteBySourceLink(ctx, megaLink) {
    const matches = findFilesBySourceLink(megaLink);
    if (matches.length === 0) return false;

    const removed = removeFilesBySourceLink(megaLink);
    try {
        await ctx.reply(`🗑 Removed ${removed.length} file(s) from the pool that came from this link.`);
    } catch (e) {
        console.error('Cannot confirm source-link deletion:', e.message);
    }
    return true;
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

function classifyFileType(filename) {
    if (isVideoFile(filename)) return 'video';
    if (isImageFile(filename)) return 'photo';
    if (isAudioFile(filename)) return 'audio';
    return 'document';
}

async function sendTelegramFile(ctx, filePath, fileName, fileSize, progressCallback) {
    const caption = `${fileName}\nSize: ${formatBytes(fileSize)}`;
    const chatId = ctx.chat.id;

    try {
        await startMtproto();
        const forceDocument = !isVideoFile(fileName) && !isImageFile(fileName) && !isAudioFile(fileName);
        let captionPrefix = '📄';
        if (isVideoFile(fileName)) captionPrefix = '🎬';
        else if (isImageFile(fileName)) captionPrefix = '🖼️';
        else if (isAudioFile(fileName)) captionPrefix = '🎵';

        return await client.sendFile(chatId, {
            file: filePath,
            caption: '',
            forceDocument: forceDocument,
            replyTo: ctx.message ? ctx.message.message_id : undefined,
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
                    let expired = false;

                    if (err.message.includes('ENOENT') || err.message.includes('not found')) {
                        errorMsg = 'File/Folder not found. Link may be expired or invalid.';
                        expired = true;
                    } else if (err.message.includes('decryption')) {
                        errorMsg = 'Decryption failed. Check if your link has the correct key';
                        expired = true;
                    }

                    const rejection = new Error(errorMsg);
                    rejection.linkExpired = expired; // lets processMegaLink show a distinct ⚠️ expiry warning
                    reject(rejection);
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
                const sentMsg = await sendTelegramFile(ctx, result.path, result.name, result.size, (progress) => {
                    uploadUpdater(progress, result.name, result.size, 1, 1);
                });
                if (sentMsg && sentMsg.id && String(chatId) === String(loadConfig().sourceGroupId)) {
                    addSharedFile(chatId, sentMsg.id, classifyFileType(result.name), megaLink);
                }
                await deleteStatus();

                if (chatType !== 'private') {
                    try {
                        await ctx.reply(`✅ *File sent successfully!*`);
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

                    const sentMsg = await sendTelegramFile(ctx, file.path, file.name, file.size, (progress) => {
                        folderUploadUpdater(progress, file.name, file.size, i + 1);
                    });
                    if (sentMsg && sentMsg.id && String(chatId) === String(loadConfig().sourceGroupId)) {
                        addSharedFile(chatId, sentMsg.id, classifyFileType(file.name), megaLink);
                    }

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
        recordError(`MEGA link failed (${chatId}): ${error.message}`);
        checkErrorRateAndAlert();

        let errorMessage;
        if (error.linkExpired) {
            // Fast, distinct warning for a link that's simply dead/expired,
            // instead of a generic "download failed".
            errorMessage = `⚠️ *Link Expired / Invalid*\n\n` +
                `*Error:* ${error.message}\n\n` +
                `This MEGA link couldn't be read at all — it's likely expired, deleted, or mistyped. ` +
                `Nothing was downloaded.`;
        } else {
            errorMessage = `❌ *Download Failed*\n\n`;
            errorMessage += `*Error:* ${error.message}\n\n`;
            errorMessage += `*Please check:*\n`;
            errorMessage += `1. Link is correct and not expired\n`;
            errorMessage += `2. Includes #key at the end\n`;
            errorMessage += `3. File/folder exists`;
        }

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

async function sendJoinPrompt(ctx, groupIds) {
    const buttons = [];
    for (const groupId of groupIds) {
        try {
            const chat = await ctx.telegram.getChat(groupId);
            let inviteLink = chat.invite_link || await ctx.telegram.exportChatInviteLink(groupId);
            buttons.push([{ text: `➡️ Join ${chat.title || 'Group'}`, url: inviteLink }]);
        } catch (error) {
            console.error(`Could not generate invite link for ${groupId}:`, error.message);
        }
    }

    if (buttons.length === 0) {
        await ctx.reply('⚠️ You need to join the required group(s), but I could not generate an invite link. Please contact the admin.');
        return;
    }

    buttons.push([{ text: '✅ I\'ve Joined — Verify', callback_data: 'recheck_sub' }]);

    await ctx.reply('🔒 *Join the group(s) below to unlock files*', {
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
            const sent = await ctx.telegram.copyMessage(ctx.chat.id, file.chat_id, file.message_id);
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

// --- User-facing: My Stats ---
const MY_STATS_KEYBOARD = { inline_keyboard: [[{ text: '📊 My Stats', callback_data: 'user_mystats' }]] };

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

    let text = `📊 *Your Stats*\n\n` +
        `Files received (all-time): ${s.totalFilesReceived}\n` +
        `/random requests today: ${s.requestsToday}\n` +
        `Cooldown: ${cooldownLine}\n` +
        `Daily limit: ${dailyLine}\n` +
        `🎟 Bonus credits: ${s.bonusCredits}`;
    if (s.bonusCredits === 0) {
        text += `\n\n_Got a promo code? Redeem it with /redeem CODE for extra requests past today's limit._`;
    }
    return text;
}

bot.command('mystats', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply(formatMyStats(ctx.from.id), { parse_mode: 'Markdown' });
});

bot.action('user_mystats', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(formatMyStats(ctx.from.id), { parse_mode: 'Markdown' });
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
        await ctx.reply('Usage: `/broadcast your message`', { parse_mode: 'Markdown' });
        return;
    }
    const userIds = getAllUserIds();
    if (userIds.length === 0) {
        await ctx.reply('No users have used /random yet.');
        return;
    }
    const status = await ctx.reply(`📢 Broadcasting to ${userIds.length} user(s)...`);
    let sent = 0, failed = 0;
    for (const uid of userIds) {
        try {
            await ctx.telegram.sendMessage(uid, msg);
            sent++;
        } catch (e) {
            failed++;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, `✅ Broadcast complete.\nSent: ${sent} | Failed: ${failed}`);
});

// --- Admin: promo codes (bonus credits) ---
bot.command('gencode', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    const [code, creditsStr, maxUsesStr] = parts;
    const credits = parseInt(creditsStr, 10);
    const maxUses = maxUsesStr !== undefined ? parseInt(maxUsesStr, 10) : 0;

    if (!code || isNaN(credits) || credits <= 0) {
        await ctx.reply(
            'Usage: `/gencode CODE credits [maxUses]`\n\n' +
            'Example: `/gencode BONUS5 3` — grants 3 bonus requests, unlimited redemptions\n' +
            '`/gencode BONUS5 3 50` — same, but capped at 50 redemptions total',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    const entry = createPromoCode(code, credits, isNaN(maxUses) ? 0 : maxUses);
    await ctx.reply(
        `✅ Promo code created: \`${entry.code}\`\n` +
        `Grants: ${entry.credits} bonus request(s)\n` +
        `Max redemptions: ${entry.maxUses === 0 ? 'Unlimited' : entry.maxUses}`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('delcode', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const code = ctx.message.text.trim().split(/\s+/)[1];
    if (!code) {
        await ctx.reply('Usage: `/delcode CODE`', { parse_mode: 'Markdown' });
        return;
    }
    const ok = deletePromoCode(code);
    await ctx.reply(ok ? `✅ Deleted code \`${code.toUpperCase()}\`.` : '❌ No such code.', { parse_mode: 'Markdown' });
});

bot.command('listcodes', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const codes = listPromoCodes();
    if (codes.length === 0) {
        await ctx.reply('No promo codes yet. Create one with `/gencode CODE credits`.', { parse_mode: 'Markdown' });
        return;
    }
    const lines = codes.slice(0, 30).map(c =>
        `\`${c.code}\` — ${c.credits} credit(s), used ${c.usedBy.length}${c.maxUses > 0 ? `/${c.maxUses}` : ''} time(s)`
    );
    await ctx.reply(`🎟 *Promo Codes* (${codes.length}):\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

// Any user can redeem a code for bonus /random requests.
bot.command('redeem', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const code = ctx.message.text.trim().split(/\s+/)[1];
    if (!code) {
        await ctx.reply('Usage: `/redeem CODE`', { parse_mode: 'Markdown' });
        return;
    }
    const result = redeemPromoCode(code, ctx.from.id);
    if (!result.success) {
        const reasons = {
            not_found: '❌ That code doesn\'t exist.',
            already_used: '❌ You\'ve already redeemed this code.',
            exhausted: '❌ This code has reached its redemption limit.'
        };
        await ctx.reply(reasons[result.reason] || '❌ Could not redeem that code.');
        return;
    }
    await ctx.reply(`🎉 Redeemed! You got ${result.credits} bonus /random request(s) past your daily limit.`);
});

// --- Admin: peak-hour insight ---
bot.command('peakhours', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const hours = getPeakHours();
    const max = Math.max(...hours, 1);
    const lines = hours.map((count, h) => {
        const barLen = Math.round((count / max) * 12);
        const bar = '▓'.repeat(barLen) + '░'.repeat(12 - barLen);
        return `${String(h).padStart(2, '0')}:00 ${bar} ${count}`;
    });
    const peakHour = hours.indexOf(max === 1 && hours.every(h => h === 0) ? 0 : max);
    await ctx.reply(
        `📈 *Peak-Hour Insight* (all-time /random requests)\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\nBusiest hour: ${String(peakHour).padStart(2, '0')}:00`,
        { parse_mode: 'Markdown' }
    );
});

// --- User-facing ---
bot.command('random', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

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

    const check = recordRequest(ctx.from.id, config.cooldownSeconds, config.dailyLimit);
    if (!check.allowed) {
        if (check.reason === 'cooldown') {
            await ctx.reply(`⏳ Please wait ${check.retryAfter} second(s) and try again.`);
        } else {
            await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow, or use a promo code with /redeem CODE for extra requests.`);
        }
        return;
    }
    if (check.usedBonusCredit) {
        await ctx.reply('🎟 Daily limit reached — used 1 bonus credit for this request.');
    }

    await sendRandomFiles(ctx);
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

    const check = recordRequest(ctx.from.id, config.cooldownSeconds, config.dailyLimit);
    if (!check.allowed) {
        if (check.reason === 'cooldown') {
            await ctx.reply(`⏳ Please wait ${check.retryAfter} second(s) and try again.`);
        } else {
            await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow, or use a promo code with /redeem CODE for extra requests.`);
        }
        return;
    }
    if (check.usedBonusCredit) {
        await ctx.reply('🎟 Daily limit reached — used 1 bonus credit for this request.');
    }

    await sendRandomFiles(ctx);
});
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
            { command: 'random', description: 'Get a random file' },
            { command: 'redeem', description: 'Redeem a promo code' }
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
        { command: 'gencode', description: 'Create a promo code' },
        { command: 'delcode', description: 'Delete a promo code' },
        { command: 'listcodes', description: 'List promo codes' },
        { command: 'peakhours', description: 'Busiest hours for /random' }
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
            [{ text: '📢 Broadcast', callback_data: 'fs_broadcast_menu' }],
            [{ text: '🎟 Promo Codes', callback_data: 'fs_codes' }, { text: '📈 Peak Hours', callback_data: 'fs_peakhours' }],
            [{ text: '🔙 Back', callback_data: 'menu_back' }]
        ]
    };

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// Renders a list of known groups/channels (auto-tracked from any update the
// bot has seen from them) as tappable buttons, excluding already-picked ones.
function knownChatPickerKeyboard(excludeIds, prefix, backCallback) {
    const exclude = new Set(excludeIds.map(String));
    const chats = getKnownChats().filter(c => !exclude.has(String(c.id)));
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

bot.action('fs_codes', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const codes = listPromoCodes();
    const text = codes.length === 0
        ? '🎟 *Promo Codes*\n\nNo codes yet.\n\nCreate one with `/gencode CODE credits [maxUses]`.'
        : `🎟 *Promo Codes* (${codes.length})\n\n` + codes.slice(0, 30).map(c =>
            `\`${c.code}\` — ${c.credits} credit(s), used ${c.usedBy.length}${c.maxUses > 0 ? `/${c.maxUses}` : ''} time(s)`
        ).join('\n') + '\n\nManage with `/gencode`, `/delcode`, `/listcodes`.';
    await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_peakhours', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const hours = getPeakHours();
    const max = Math.max(...hours, 1);
    const anyData = hours.some(h => h > 0);
    const lines = hours.map((count, h) => {
        const barLen = Math.round((count / max) * 12);
        const bar = '▓'.repeat(barLen) + '░'.repeat(12 - barLen);
        return `${String(h).padStart(2, '0')}:00 ${bar} ${count}`;
    });
    const peakHour = hours.indexOf(max);
    const text = `📈 *Peak-Hour Insight*\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`` +
        (anyData ? `\n\nBusiest hour: ${String(peakHour).padStart(2, '0')}:00` : '\n\nNo requests recorded yet.');
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
    const text = `📋 *Force-Sub Groups/Channels* (${entries.length}) — tap ❌ to remove:`;
    const rows = entries.map(e => [{ text: e.label, callback_data: 'noop' }, { text: '❌', callback_data: `fs_rmfs:${e.id}` }]);
    rows.push([{ text: '➕ Add More', callback_data: 'fs_addfs_menu' }]);
    rows.push([{ text: '🔙 Back', callback_data: 'menu_fileshare' }]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
}

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
    const { rows, truncated, total } = knownChatPickerKeyboard(config.forceSubGroupIds, 'fs_addfs', 'menu_fileshare');
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
    const { rows, truncated, total } = knownChatPickerKeyboard([], 'fs_setsrc', 'menu_fileshare');
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
bot.action('fs_broadcast_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    pendingAction[ctx.from.id] = { type: 'broadcast' };
    await ctx.editMessageText('📢 Send the message to broadcast to all /random users now, or /cancel.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu_fileshare' }]] }
    });
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

// Track photo/video files posted by admin in the configured source group.
// Only the (chat_id, message_id) is saved — sharing later uses copyMessage.
bot.on(['photo', 'video'], async (ctx) => {
    if (ctx.chat.type === 'private') return;
    trackKnownChat(ctx);

    const config = loadConfig();
    if (!config.sourceGroupId || String(ctx.chat.id) !== String(config.sourceGroupId)) return;
    if (!ctx.from || !isAdmin(ctx.from.id)) return;

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
                if (await tryDeleteBySourceLink(ctx, megaLink)) return;
                await queue.add(() => processMegaLink(ctx, megaLink));
            }
        }
        return;
    }
    const command = text.split(' ')[0].split('@')[0];
    if (!['/setforcesub', '/setsource', '/unsetforcesub'].includes(command)) return;

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
        saveConfig(config);
        await ctx.reply(`✅ Removed "${ctx.chat.title}" from the force-sub list.`);
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

    if (action.type === 'broadcast') {
        delete pendingAction[userId];
        const userIds = getAllUserIds();
        if (userIds.length === 0) {
            await ctx.reply('No users have used /random yet.');
            return;
        }
        const status = await ctx.reply(`📢 Broadcasting to ${userIds.length} user(s)...`);
        let sent = 0, failed = 0;
        for (const uid of userIds) {
            try {
                await ctx.telegram.sendMessage(uid, text);
                sent++;
            } catch (e) {
                failed++;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, `✅ Broadcast complete.\nSent: ${sent} | Failed: ${failed}`);
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

    if (await tryDeleteBySourceLink(ctx, megaLink)) return;

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
    recordError(`${ctx?.chat?.type || '?'} ${ctx?.chat?.id || '?'}: ${err.message}`);
    checkErrorRateAndAlert();
    try {
        if (ctx.chat.type === 'private') {
            ctx.reply('❌ An internal error occurred. Please try again.');
        }
    } catch (e) {
        console.error('Failed to send error:', e);
    }
});

// ===== Health-check / auto-restart notice =====
// Anything that crashes the process (uncaught error, unhandled rejection)
// gets logged + a best-effort alert to the admin, then the process exits so
// the process manager (pm2, systemd, etc.) restarts it. The startup message
// below fires on every restart, so it doubles as the "I'm back up" alert.
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught exception:', err);
    recordError(`uncaughtException: ${err.message}`);
    notifyAdmins(`💥 *Bot Crashed*\n\nUncaught exception:\n\`${err.message}\`\n\nRestarting...`)
        .finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('💥 Unhandled rejection:', msg);
    recordError(`unhandledRejection: ${msg}`);
    checkErrorRateAndAlert();
    // Rejections alone don't necessarily corrupt state, so we don't force-exit here.
});

// ===== Scheduled jobs: dead-link cleaner + weekly digest =====
// Dead-link cleaner: periodically forwards each pooled file to the admin log
// chat (then immediately deletes that copy) purely to test whether the
// source message still exists. If Telegram rejects the forward, the source
// was deleted, so the pool entry is dropped too. Runs in small batches with
// a delay between checks to stay well clear of flood limits.
async function runDeadLinkCleaner() {
    const config = loadConfig();
    const logChatId = getLogChatId(config);
    if (!logChatId) return;

    const files = loadSharedFiles();
    const batch = files.slice(0, 25); // cap per run
    let removed = 0;

    for (const f of batch) {
        try {
            const fwd = await bot.telegram.forwardMessage(logChatId, f.chat_id, f.message_id, { disable_notification: true });
            await bot.telegram.deleteMessage(logChatId, fwd.message_id).catch(() => {});
        } catch (e) {
            // Source message is gone (deleted / chat unreachable) — drop it from the pool.
            removeSharedFile(f.chat_id, f.message_id);
            removed++;
        }
        await new Promise(r => setTimeout(r, 300));
    }

    if (removed > 0) {
        await notifyLogChat(`🧹 *Dead-Link Cleaner*\n\nChecked ${batch.length} file(s), removed ${removed} dead entr${removed === 1 ? 'y' : 'ies'} from the pool.`);
    }
}

// Weekly digest: files/requests/errors/promo redemptions + peak hour, sent
// to the log chat once every 7 days.
let lastDigestAt = 0;
async function maybeSendWeeklyDigest() {
    const config = loadConfig();
    if (!config.weeklyDigestEnabled) return;
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - lastDigestAt < weekMs) return;
    lastDigestAt = Date.now();

    const since = Date.now() - weekMs;
    const stats = getStats();
    const errorCount = getErrorCountSince(since);
    const promoRedemptions = getPromoRedemptionsSince(since);
    const hours = getPeakHours();
    const peakHour = hours.indexOf(Math.max(...hours));

    const text = `📊 *Weekly Digest*\n\n` +
        `Total files in pool: ${stats.totalFiles}\n` +
        `Total users: ${stats.totalUsers}\n` +
        `Requests today: ${stats.requestsToday}\n` +
        `Errors (7d): ${errorCount}\n` +
        `Promo redemptions (7d): ${promoRedemptions}\n` +
        `Peak hour (all-time): ${String(peakHour).padStart(2, '0')}:00 (${hours[peakHour]} requests)`;

    await notifyLogChat(text);
}

function startScheduledJobs() {
    const config = loadConfig();
    const intervalMs = (config.deadLinkCheckHours || 6) * 60 * 60 * 1000;
    setInterval(() => runDeadLinkCleaner().catch(e => console.error('Dead-link cleaner error:', e.message)), intervalMs);
    // Also check once shortly after startup, and check weekly-digest eligibility every hour.
    setTimeout(() => runDeadLinkCleaner().catch(e => console.error('Dead-link cleaner error:', e.message)), 60 * 1000);
    setInterval(() => maybeSendWeeklyDigest().catch(e => console.error('Weekly digest error:', e.message)), 60 * 60 * 1000);
}

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
            startScheduledJobs();
            notifyAdmins(`✅ *Bot Started*\n\n@${botUsername} is up and running.`).catch(() => {});
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
