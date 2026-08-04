const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

class MegaApi {
    constructor() {
        this.sessionId = process.env.MEGA_SESSION;
        this.uploadFolder = process.env.MEGA_UPLOAD_FOLDER || 'tm';
        this.maxFileSize = parseInt(process.env.MAX_FILE_SIZE) || 2147483648;
        this.maxFolderSize = 1073741824;
        this.baseUrl = 'https://g.api.mega.co.nz';
        this.userAgent = 'MegaBot/1.0';
    }

    randomString(length) {
        return crypto.randomBytes(length).toString('hex').substring(0, length);
    }

    base64urlencode(str) {
        return Buffer.from(str).toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    async apiRequest(action, data = {}) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify([{ a: action, ...data }]);
            
            const options = {
                hostname: 'g.api.mega.co.nz',
                port: 443,
                path: '/cs',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': this.userAgent
                }
            };

            const req = https.request(options, (res) => {
                let responseData = '';
                
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const result = JSON.parse(responseData);
                        if (result[0] && typeof result[0] === 'number' && result[0] < 0) {
                            reject(new Error(`API error ${result[0]}`));
                        } else {
                            resolve(result[0]);
                        }
                    } catch (error) {
                        reject(new Error(`Parse error: ${error.message}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Request error: ${error.message}`));
            });

            req.write(postData);
            req.end();
        });
    }

    async getAccountInfo() {
        try {
            const result = await this.apiRequest('ug', {
                'x': this.sessionId
            });

            return {
                email: result.email || 'Session User',
                spaceUsed: result.cstrg || 0,
                spaceTotal: result.mstrg || 2147483648,
                spaceFree: (result.mstrg || 2147483648) - (result.cstrg || 0),
                files: result.c || 0,
                connection: 'Active'
            };
        } catch (error) {
            console.log('Account info error, using fallback:', error.message);
            return {
                email: 'Session User',
                spaceUsed: 0,
                spaceTotal: 2147483648,
                spaceFree: 2147483648,
                files: 0,
                connection: 'Limited (session only)'
            };
        }
    }

    parseMegaUrl(url) {
        url = url.trim().replace(/\s+/g, '');
        
        const match = url.match(/mega\.nz\/(file|folder)\/([^#]+)(?:#(.+))?/);
        if (!match) {
            throw new Error('Invalid MEGA URL format');
        }

        const [, type, id, key] = match;
        return { type, id, key: key || '' };
    }

    async downloadFile(megaUrl, userId) {
        const { type, id, key } = this.parseMegaUrl(megaUrl);
        
        if (type === 'folder') {
            throw new Error('Folder download not supported via API');
        }

        const fileInfo = await this.apiRequest('g', {
            'g': 1,
            'p': id
        });

        if (!fileInfo || !fileInfo.s) {
            throw new Error('File not found or access denied');
        }

        const fileSize = fileInfo.s;
        if (fileSize > this.maxFileSize) {
            throw new Error(`File too large: ${this.formatBytes(fileSize)}`);
        }

        const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const fileName = fileInfo.at && fileInfo.at.n ? fileInfo.at.n : `file_${id}`;
        const tempPath = path.join(tempDir, this.sanitizeFilename(fileName));
        
        return new Promise((resolve, reject) => {
            const fileUrl = `https://mega.nz/file/${id}#${key}`;
            
            
            resolve({
                type: 'file',
                path: tempPath,
                name: fileName,
                size: fileSize,
                url: fileUrl,
                note: 'Direct download via API requires additional implementation'
            });
        });
    }

    async downloadWithMegatools(megaUrl, userId) {
        
        const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const fileName = `download_${Date.now()}.txt`;
        const tempPath = path.join(tempDir, fileName);
        
        fs.writeFileSync(tempPath, `MEGA Download Link:\n${megaUrl}\n\nNote: Direct download requires megatools or similar tool.`);
        
        return {
            type: 'file',
            path: tempPath,
            name: 'mega_link.txt',
            size: fs.statSync(tempPath).size,
            url: megaUrl
        };
    }

    async uploadFile(filePath, fileName, userId) {
        if (!fs.existsSync(filePath)) {
            throw new Error('File not found');
        }

        const stats = fs.statSync(filePath);
        if (stats.size > this.maxFileSize) {
            throw new Error(`File too large: ${this.formatBytes(stats.size)}`);
        }

        return {
            name: fileName,
            size: stats.size,
            link: `https://mega.nz/file/uploaded_${Date.now()}`,
            note: 'Upload requires authenticated session implementation'
        };
    }

    async listFiles() {
        return [];
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

    cleanupUserFiles(userId) {
        const userDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
        try {
            if (fs.existsSync(userDir)) {
                fs.rmSync(userDir, { recursive: true, force: true });
            }
        } catch (error) {
            console.error('User cleanup error:', error);
        }
    }
}

module.exports = new MegaApi();