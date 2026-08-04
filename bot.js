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
    getUnseenFiles,
    markSeen,
    recordRequest,
    getAllUserIds,
    getStats,
    isAdmin
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
                });
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

                    await sendTelegramFile(ctx, file.path, file.name, file.size, (progress) => {
                        folderUploadUpdater(progress, file.name, file.size, i + 1);
                    });

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
        await ctx.reply('👋 Welcome! Send /random to get files.');
        return;
    }

    const unjoined = await getUnjoinedGroups(ctx, config.forceSubGroupIds, ctx.from.id);
    if (unjoined.length > 0) {
        await sendJoinPrompt(ctx, unjoined);
        return;
    }

    await ctx.reply('✅ You\'re already a member! Send /random to get files.');
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
        await ctx.reply('🎉 You\'ve received all the files currently available! Check back later for new ones.');
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
            await ctx.reply(`⏳ These file(s) will auto-delete in ${config.autoDeleteMinutes} minute(s).`);
        }
    } else {
        await ctx.reply('❌ Could not send the file(s), please try again.');
    }
}

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
            await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow.`);
        }
        return;
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
            await ctx.reply(`🚫 You've reached today's limit. Try again tomorrow.`);
        }
        return;
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
        { command: 'broadcast', description: 'Message all /random users' }
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
    const text = '🎬 *File Sharing*\n\n' +
        '_Setup (run inside the target group):_\n' +
        '`/setsource` `/setforcesub` `/unsetforcesub`\n\n' +
        '_Other (need a value, type manually):_\n' +
        '`/delfile <index>` `/broadcast <msg>`';

    const keyboard = {
        inline_keyboard: [
            [{ text: '📁 List Files', callback_data: 'fs_listfiles' }, { text: '📊 Stats', callback_data: 'fs_stats' }],
            [{ text: '📋 Force-Sub Groups', callback_data: 'fs_listforcesub' }],
            [{ text: `🔢 Per Request: ${config.shareCount}`, callback_data: 'fs_count_menu' }],
            [{ text: `⏱ Cooldown: ${config.cooldownSeconds}s`, callback_data: 'fs_cooldown_menu' }],
            [{ text: `📆 Daily Limit: ${config.dailyLimit === 0 ? 'Unlimited' : config.dailyLimit}`, callback_data: 'fs_dailylimit_menu' }],
            [{ text: `🗑 Auto-Delete: ${config.autoDeleteMinutes === 0 ? 'Off' : config.autoDeleteMinutes + 'm'}`, callback_data: 'fs_autodelete_menu' }],
            [{ text: '🔙 Back', callback_data: 'menu_back' }]
        ]
    };

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
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
    const text = files.length === 0
        ? 'No files in the pool yet.'
        : `📁 Files (${files.length} total, showing first 50):\n\n` +
          files.slice(0, 50).map((f, i) => `${i}. ${f.type} — msg #${f.message_id} — ${f.added_at.slice(0, 10)}`).join('\n') +
          '\n\nTo remove: `/delfile <index>`';
    await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
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

bot.action('fs_listforcesub', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const config = loadConfig();
    let text;
    if (config.forceSubGroupIds.length === 0) {
        text = 'No force-sub groups set yet.';
    } else {
        const lines = await Promise.all(config.forceSubGroupIds.map(async (id) => {
            try {
                const chat = await ctx.telegram.getChat(id);
                return `• ${chat.title} (${id})`;
            } catch (e) {
                return `• ${id} (unreachable)`;
            }
        }));
        text = `📋 Force-Sub Groups:\n\n${lines.join('\n')}`;
    }
    await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
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
    await ctx.editMessageText(`🔢 *Files per Request*\n\nCurrent: ${config.shareCount}\n\nPick a value, or type \`/setcount <n>\` for a custom one.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([1, 2, 3, 5], 'fs_count'), [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_cooldown_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`⏱ *Cooldown*\n\nCurrent: ${config.cooldownSeconds}s\n\nPick a value, or type \`/setcooldown <sec>\` for a custom one.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([0, 10, 15, 30, 60], 'fs_cooldown', 's'), [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_dailylimit_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`📆 *Daily Limit*\n\nCurrent: ${config.dailyLimit === 0 ? 'Unlimited' : config.dailyLimit}\n\nPick a value (0 = unlimited), or type \`/setdailylimit <n>\` for a custom one.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([0, 5, 10, 20], 'fs_dailylimit'), [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
    });
});

bot.action('fs_autodelete_menu', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const config = loadConfig();
    await ctx.editMessageText(`🗑 *Auto-Delete*\n\nCurrent: ${config.autoDeleteMinutes === 0 ? 'Off' : config.autoDeleteMinutes + ' min'}\n\nPick a value (0 = off), or type \`/setautodelete <min>\` for a custom one.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [presetRow([0, 10, 30, 60], 'fs_autodelete', 'm'), [{ text: '🔙 Back', callback_data: 'menu_fileshare' }]] }
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

    const config = loadConfig();
    if (!config.sourceGroupId || String(ctx.chat.id) !== String(config.sourceGroupId)) return;
    if (!ctx.from || !isAdmin(ctx.from.id)) return;

    const type = Array.isArray(ctx.message.photo) ? 'photo' : 'video';
    const added = addSharedFile(ctx.chat.id, ctx.message.message_id, type);
    if (added) {
        console.log(`Tracked ${type} msg #${ctx.message.message_id} in share pool`);
    }
});

// ===== End Force-Sub File Sharing Feature =====

bot.on('message', async (ctx) => {
    const text = ctx.message.text;

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