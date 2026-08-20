const mega = require('megajs');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();
class MegaManager {
    constructor() {
        this.storage = null;
        this.uploadFolder = process.env.MEGA_UPLOAD_FOLDER || 'tm';
        this.maxFileSize = parseInt(process.env.MAX_FILE_SIZE) || 2147483648;
        this.maxFolderSize = 1073741824;
        this.isConnected = false;
        this.connectionPromise = null;
        this.initialize();
    }

    async initialize() {
        try {
            console.log('🔧 Initializing MEGA Manager...');

            const email = process.env.MEGA_EMAIL;
            const password = process.env.MEGA_PASSWORD;

            if (!email || !password) {
                throw new Error('MEGA_EMAIL / MEGA_PASSWORD not set in .env — authenticated login requires both');
            }

            this.connectionPromise = {};
            this.connectionPromise.promise = new Promise((resolve, reject) => {
                this.connectionPromise.resolve = resolve;
                this.connectionPromise.reject = reject;
            });

            // Real authenticated account login (not an anonymous/public-link
            // session). This is what lets downloads use the account's own
            // transfer quota instead of MEGA's anonymous per-IP quota.
            this.storage = new mega.Storage({
                email,
                password,
                autologin: true,
                keepalive: true
            });

            this.storage.on('ready', () => {
                console.log(`✅ MEGA connected successfully as ${email}`);
                this.isConnected = true;
                if (this.connectionPromise) {
                    this.connectionPromise.resolve();
                }
            });

            this.storage.on('error', (err) => {
                console.error('❌ MEGA connection error:', err.message);
                this.isConnected = false;
                if (this.connectionPromise) {
                    this.connectionPromise.reject(err);
                }
            });

            setTimeout(() => {
                if (!this.isConnected && this.connectionPromise) {
                    this.connectionPromise.reject(new Error('Connection timeout'));
                }
            }, 40000);

        } catch (error) {
            console.error('Failed to initialize MEGA:', error);
            this.isConnected = false;
            if (this.connectionPromise) {
                this.connectionPromise.reject(error);
            }
        }
    }

    // Allows callers to retry a login that failed at startup (e.g. .env was
    // fixed after the process started) without restarting the whole bot.
    async reconnect() {
        this.isConnected = false;
        this.storage = null;
        await this.initialize();
        return this.ensureConnected();
    }

    async ensureConnected() {
        if (this.isConnected) {
            return;
        }

        if (!this.connectionPromise) {
            throw new Error('MEGA not initialized');
        }

        try {
            await this.connectionPromise.promise;
        } catch (error) {
            // connectionPromise wraps ONE Promise object — once it has
            // rejected (e.g. the 20s startup timeout fired), awaiting it
            // again replays that exact same cached rejection forever, even
            // after the network recovers. Clear it here so the next call
            // starts a fresh login attempt instead of looping on a stale
            // failure until the bot is restarted.
            this.connectionPromise = null;
            throw new Error(`MEGA connection failed: ${error.message}`);
        }
    }

    // Call this instead of ensureConnected() from download/upload entry
    // points when you want a failed connection to actually retry rather
    // than just report the same error again. Since ensureConnected() now
    // clears connectionPromise on failure, calling it a second time here
    // triggers a brand-new login instead of reusing a dead one.
    async ensureConnectedWithRetry(retries = 1) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                if (!this.connectionPromise && !this.isConnected) {
                    await this.initialize();
                }
                await this.ensureConnected();
                return;
            } catch (error) {
                if (attempt === retries) throw error;
                console.log(`⏳ MEGA connect attempt ${attempt + 1} failed, retrying...`);
            }
        }
    }

    async getAccountInfo() {
        try {
            await this.ensureConnected();
            
        
            const account = this.storage.account || {};
            const rootFiles = this.storage.files || {};
            
            
            let fileCount = 0;
            if (this.storage.root && this.storage.root.children) {
                fileCount = this.storage.root.children.length;
            }

            return {
                email: account.email || 'Session User',
                spaceUsed: account.spaceUsed || 0,
                spaceTotal: account.spaceTotal || 2147483648,
                spaceFree: (account.spaceTotal || 2147483648) - (account.spaceUsed || 0),
                files: fileCount,
                connection: 'Active'
            };
        } catch (error) {
            console.error('Error getting account info:', error);
            return {
                email: 'Not Connected',
                spaceUsed: 0,
                spaceTotal: 0,
                spaceFree: 0,
                files: 0,
                connection: 'Failed'
            };
        }
    }

    // Timeout scales with size instead of a single fixed 5-minute cap, so a
    // small file doesn't wait needlessly long to fail and a large file isn't
    // cut off before a slow-but-working transfer can finish.
    // Assumes a conservative minimum sustained speed; base covers MEGA API
    // handshake/connection overhead before bytes start moving.
    calculateDownloadTimeout(bytes) {
        const BASE_MS = 30000;                          // connection/setup overhead
        const MIN_SPEED_BYTES_PER_MS = (1024 * 1024) / 1000; // assume at least ~1 MB/s
        const MIN_TIMEOUT = 60000;                       // never less than 1 min
        const MAX_TIMEOUT = 45 * 60 * 1000;              // never more than 45 min
        const computed = BASE_MS + (bytes / MIN_SPEED_BYTES_PER_MS);
        return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, computed));
    }

    async downloadItem(megaUrl, userId) {
        await this.ensureConnected();
        
      
        const cleanUrl = megaUrl.trim()
            .replace(/\s+/g, '')
            .replace(/^.*(mega\.nz\/)/, 'https://mega.nz/');
        
        console.log(`Downloading from: ${cleanUrl}`);

        return new Promise((resolve, reject) => {
            // Short timeout just for resolving the link + reading its
            // attributes (name/size) — actual size isn't known yet, so this
            // stays fixed. The real, size-aware timeout is set once we know
            // what we're downloading (see handleFileDownload/handleFolderDownload).
            const connectTimeout = setTimeout(() => {
                reject(new Error('Download timeout'));
            }, 30000);

            try {
                
                const file = mega.File.fromURL(cleanUrl, {}, this.storage);
                
                file.loadAttributes((err) => {
                    clearTimeout(connectTimeout);
                    if (err) {
                        return reject(new Error(`Failed to load: ${err.message}`));
                    }

                    console.log(`Loaded: ${file.name} (${file.directory ? 'Folder' : 'File'})`);

                    if (file.directory) {
                        this.handleFolderDownload(file, userId, resolve, reject);
                    } else {
                        this.handleFileDownload(file, userId, resolve, reject);
                    }
                });
            } catch (error) {
                clearTimeout(connectTimeout);
                reject(new Error(`Invalid link: ${error.message}`));
            }
        });
    }

    async handleFileDownload(file, userId, resolve, reject) {
        let timeout;
        try {
            if (file.size > this.maxFileSize) {
                return reject(new Error(`File too large: ${this.formatBytes(file.size)}`));
            }

            timeout = setTimeout(() => {
                reject(new Error('Download timeout'));
            }, this.calculateDownloadTimeout(file.size));

            const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const tempPath = path.join(tempDir, this.sanitizeFilename(file.name));
            const writeStream = fs.createWriteStream(tempPath);

            console.log(`Downloading file: ${file.name} (${this.formatBytes(file.size)}, timeout ${Math.round(this.calculateDownloadTimeout(file.size) / 1000)}s)`);

            file.download({})
                .on('error', (err) => {
                    clearTimeout(timeout);
                    writeStream.end();
                    this.cleanupFile(tempPath);
                    reject(new Error(`Download failed: ${err.message}`));
                })
                .pipe(writeStream);

            writeStream.on('finish', () => {
                clearTimeout(timeout);
                resolve({
                    type: 'file',
                    path: tempPath,
                    name: file.name,
                    size: file.size
                });
            });

            writeStream.on('error', (err) => {
                clearTimeout(timeout);
                this.cleanupFile(tempPath);
                reject(new Error(`Save failed: ${err.message}`));
            });

        } catch (error) {
            clearTimeout(timeout);
            reject(new Error(`File processing error: ${error.message}`));
        }
    }

    async handleFolderDownload(folder, userId, resolve, reject) {
        let timeout;
        try {
        
            const allFiles = this.getAllFilesFromFolder(folder);
            
            if (allFiles.length === 0) {
                return reject(new Error('Folder is empty'));
            }

            const totalSize = allFiles.reduce((sum, file) => sum + file.size, 0);
            if (totalSize > this.maxFolderSize) {
                return reject(new Error(`Folder too large: ${this.formatBytes(totalSize)}`));
            }

            timeout = setTimeout(() => {
                reject(new Error('Download timeout'));
            }, this.calculateDownloadTimeout(totalSize));

            console.log(`Folder has ${allFiles.length} files, total: ${this.formatBytes(totalSize)}, timeout ${Math.round(this.calculateDownloadTimeout(totalSize) / 1000)}s`);

          
            const folderDir = path.join(os.tmpdir(), 'mega-bot', userId.toString(), this.sanitizeFilename(folder.name));
            if (!fs.existsSync(folderDir)) {
                fs.mkdirSync(folderDir, { recursive: true });
            }

            const downloadedFiles = [];
            
            for (const fileInfo of allFiles) {
                try {
                    const filePath = path.join(folderDir, this.sanitizeFilename(fileInfo.name));
                    await this.downloadFileToPath(fileInfo.node, filePath);
                    downloadedFiles.push({
                        path: filePath,
                        name: fileInfo.name,
                        size: fileInfo.size
                    });
                    console.log(`Downloaded: ${fileInfo.name}`);
                } catch (error) {
                    console.error(`Failed to download ${fileInfo.name}:`, error.message);
                }
            }

            clearTimeout(timeout);
            
            if (downloadedFiles.length === 0) {
                return reject(new Error('No files could be downloaded'));
            }

            resolve({
                type: 'folder',
                folderPath: folderDir,
                files: downloadedFiles,
                fileCount: downloadedFiles.length,
                totalSize: totalSize,
                name: folder.name
            });

        } catch (error) {
            clearTimeout(timeout);
            reject(new Error(`Folder download error: ${error.message}`));
        }
    }

    getAllFilesFromFolder(folder, files = []) {
        if (!folder.children) return files;
        
        for (const child of folder.children) {
            if (child.directory) {
                this.getAllFilesFromFolder(child, files);
            } else {
                files.push({
                    node: child,
                    name: child.name,
                    size: child.size || 0
                });
            }
        }
        
        return files;
    }

    async downloadFileToPath(file, filePath) {
        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(filePath);
            
            file.download({})
                .on('error', reject)
                .pipe(writeStream);
            
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }

    async uploadFile(filePath, fileName, userId) {
        await this.ensureConnected();
        
        if (!fs.existsSync(filePath)) {
            throw new Error('File not found');
        }

        const stats = fs.statSync(filePath);
        if (stats.size > this.maxFileSize) {
            throw new Error(`File too large: ${this.formatBytes(stats.size)}`);
        }

        console.log(`Uploading: ${fileName} (${this.formatBytes(stats.size)})`);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Upload timeout'));
            }, 600000);

            try {
                let uploadFolder = this.storage.root.children.find(child => 
                    child && child.name === this.uploadFolder && child.directory
                );

                if (!uploadFolder) {
                    this.storage.mkdir(this.uploadFolder, (err, folder) => {
                        if (err) {
                            clearTimeout(timeout);
                            return reject(new Error(`Failed to create folder: ${err.message}`));
                        }
                        this.doUpload(folder, filePath, fileName, stats, timeout, resolve, reject);
                    });
                } else {
                    this.doUpload(uploadFolder, filePath, fileName, stats, timeout, resolve, reject);
                }
            } catch (error) {
                clearTimeout(timeout);
                reject(new Error(`Upload setup failed: ${error.message}`));
            }
        });
    }

    async doUpload(folder, filePath, fileName, stats, timeout, resolve, reject) {
        const readStream = fs.createReadStream(filePath);
        
        folder.upload({
            name: this.sanitizeFilename(fileName)
        }, readStream, (err, file) => {
            clearTimeout(timeout);
            
            if (err) {
                readStream.destroy();
                return reject(new Error(`Upload failed: ${err.message}`));
            }

            console.log(`Upload successful: ${file.name}`);
            
            let downloadLink = 'No direct link';
            try {
                if (file.downloadId) {
                    downloadLink = `https://mega.nz/file/${file.downloadId}`;
                }
            } catch (e) {
            }

            resolve({
                name: file.name,
                size: stats.size,
                link: downloadLink
            });
        });

        readStream.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Read error: ${err.message}`));
        });
    }

    async listFiles() {
        try {
            await this.ensureConnected();
            
            const uploadFolder = this.storage.root.children.find(child => 
                child && child.name === this.uploadFolder && child.directory
            );

            if (!uploadFolder) {
                return [];
            }

            const files = [];
            for (const child of uploadFolder.children || []) {
                if (child && !child.directory) {
                    files.push({
                        name: child.name,
                        size: child.size || 0,
                        link: child.downloadId ? `https://mega.nz/file/${child.downloadId}` : null
                    });
                }
            }
            return files;
        } catch (error) {
            console.error('List files error:', error);
            return [];
        }
    }
    sanitizeFilename(filename) {
        return filename.replace(/[<>:"/\\|?*]/g, '_')
                      .trim()
                      .substring(0, 200);
    }

    formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    cleanupFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }

    cleanupFolder(folderPath) {
        try {
            if (fs.existsSync(folderPath)) {
                fs.rmSync(folderPath, { recursive: true, force: true });
            }
        } catch (error) {
            console.error('Folder cleanup error:', error);
        }
    }

    cleanupUserFiles(userId) {
        const userDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
        this.cleanupFolder(userDir);
    }
}
module.exports = new MegaManager();
