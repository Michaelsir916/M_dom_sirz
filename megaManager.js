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
            
           
            this.storage = new mega.Storage({
                email: 'session',
                password: process.env.MEGA_SESSION,
                autologin: false
            });

         
            this.storage.on('ready', () => {
                console.log('✅ MEGA connected successfully!');
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

          
            this.connectionPromise = {};
            this.connectionPromise.promise = new Promise((resolve, reject) => {
                this.connectionPromise.resolve = resolve;
                this.connectionPromise.reject = reject;
            });

        
            setTimeout(() => {
                if (!this.isConnected && this.connectionPromise) {
                    this.connectionPromise.reject(new Error('Connection timeout'));
                }
            }, 10000);

        } catch (error) {
            console.error('Failed to initialize MEGA:', error);
            throw error;
        }
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
            throw new Error(`MEGA connection failed: ${error.message}`);
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

    async downloadItem(megaUrl, userId) {
        await this.ensureConnected();
        
      
        const cleanUrl = megaUrl.trim()
            .replace(/\s+/g, '')
            .replace(/^.*(mega\.nz\/)/, 'https://mega.nz/');
        
        console.log(`Downloading from: ${cleanUrl}`);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Download timeout'));
            }, 300000);

            try {
                
                const file = mega.File.fromURL(cleanUrl, {}, this.storage);
                
                file.loadAttributes((err) => {
                    if (err) {
                        clearTimeout(timeout);
                        return reject(new Error(`Failed to load: ${err.message}`));
                    }

                    console.log(`Loaded: ${file.name} (${file.directory ? 'Folder' : 'File'})`);

                    if (file.directory) {
                        this.handleFolderDownload(file, userId, timeout, resolve, reject);
                    } else {
                        this.handleFileDownload(file, userId, timeout, resolve, reject);
                    }
                });
            } catch (error) {
                clearTimeout(timeout);
                reject(new Error(`Invalid link: ${error.message}`));
            }
        });
    }

    async handleFileDownload(file, userId, timeout, resolve, reject) {
        try {
            if (file.size > this.maxFileSize) {
                clearTimeout(timeout);
                return reject(new Error(`File too large: ${this.formatBytes(file.size)}`));
            }

            const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const tempPath = path.join(tempDir, this.sanitizeFilename(file.name));
            const writeStream = fs.createWriteStream(tempPath);

            console.log(`Downloading file: ${file.name}`);

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

    async handleFolderDownload(folder, userId, timeout, resolve, reject) {
        try {
        
            const allFiles = this.getAllFilesFromFolder(folder);
            
            if (allFiles.length === 0) {
                clearTimeout(timeout);
                return reject(new Error('Folder is empty'));
            }

            const totalSize = allFiles.reduce((sum, file) => sum + file.size, 0);
            if (totalSize > this.maxFolderSize) {
                clearTimeout(timeout);
                return reject(new Error(`Folder too large: ${this.formatBytes(totalSize)}`));
            }

            console.log(`Folder has ${allFiles.length} files, total: ${this.formatBytes(totalSize)}`);

          
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