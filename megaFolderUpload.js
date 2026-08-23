// megaFolderUpload.js
//
// Engine for the "📂 Folder Upload" admin feature (MEGA Management panel).
// Separate from the existing quick-download flow in bot.js (downloadMegaFile /
// downloadMegaFolder) — those stay untouched. This module is only used by the
// new folder-browse-and-select flow.
//
// Responsibilities:
//   1. Multi-account MEGA login pool + rotation when an account hits its
//      bandwidth/quota limit.
//   2. Loading a MEGA folder link's tree (anonymous — browsing metadata
//      doesn't need an authenticated account) and letting bot.js walk it.
//   3. Downloading a single file with a size-scaled timeout, using an
//      authenticated account's quota when available, and verifying the
//      downloaded size matches the expected size (corrupt-file detection).
//
// Persistence for the account pool lives in fileShare.js's config.json
// (config.megaAccounts) — this module only touches it via the functions
// passed in from bot.js, it doesn't read/write the file directly, so there
// is exactly one place that owns the on-disk schema.

const mega = require('megajs');
const fs = require('fs');

// account: { id, email, password, label }
// Cached authenticated Storage instances, keyed by account.id. Lost on
// restart, which is fine — reconnecting is cheap and automatic on first use.
const storageCache = new Map();

// Cooldown timestamps (ms epoch) live in config.megaAccounts[i].disabledUntil,
// persisted via the getMegaAccounts/setMegaAccountCooldown functions bot.js
// passes in — kept out of this module so there is one source of truth.

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function sanitizeFilename(filename) {
    return String(filename || 'file')
        .replace(/[<>:"/\\|?*]/g, '_')
        .trim()
        .substring(0, 200) || 'file';
}

// Best-effort detection of a MEGA bandwidth/quota error so the caller knows
// to rotate to the next account instead of treating it as a hard failure.
// megajs surfaces MEGA's own API error codes inside the error message —
// exact wording can vary by megajs version, so this matches on several
// known signals rather than one exact string. If a real quota error slips
// through unmatched, it'll just be treated as a normal failure (file
// skipped) rather than triggering rotation — safe default, worth tightening
// once you see real error text from your VPS logs.
function isQuotaError(err) {
    if (!err) return false;
    const msg = String(err.message || err).toLowerCase();
    return /quota|overquota|over quota|bandwidth|rate limit|ratelimit|temporarily unavailable|etempunavail|too many connections|-17|-18|-19/.test(msg);
}

function parseMegaFolderUrl(url) {
    const cleaned = String(url).trim().replace(/\s+/g, '');
    if (!/mega\.nz\/folder\//.test(cleaned)) return null;
    return cleaned;
}

// Logs in (or reuses a cached session for) one account. Resolves with the
// megajs Storage instance once ready.
function ensureAccountStorage(account) {
    if (storageCache.has(account.id)) {
        const cached = storageCache.get(account.id);
        if (cached.ready) return Promise.resolve(cached.storage);
        return cached.promise;
    }

    const storage = new mega.Storage({
        email: account.email,
        password: account.password,
        autologin: true,
        keepalive: true
    });

    const entry = { storage, ready: false, promise: null };
    entry.promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            storageCache.delete(account.id);
            reject(new Error(`MEGA login timed out for ${account.label || account.email}`));
        }, 40000);

        storage.on('ready', () => {
            clearTimeout(timeout);
            entry.ready = true;
            resolve(storage);
        });
        storage.on('error', (err) => {
            clearTimeout(timeout);
            storageCache.delete(account.id);
            reject(new Error(`MEGA login failed for ${account.label || account.email}: ${err.message}`));
        });
    });
    storageCache.set(account.id, entry);
    return entry.promise;
}

// Picks the next usable account (not on cooldown), round-robin from
// lastIndex. Returns null if none are usable (caller falls back to
// anonymous access, which still works, just at MEGA's slower anon-IP quota).
function pickAccount(accounts, excludeIds = []) {
    const now = Date.now();
    const excluded = new Set(excludeIds);
    const usable = accounts.filter(a => !excluded.has(a.id) && (!a.disabledUntil || a.disabledUntil <= now));
    if (usable.length === 0) return null;
    return usable[Math.floor(Math.random() * usable.length)];
}

// Loads a folder link's full tree in one shot (megajs's 'f' request returns
// the whole nested structure). Pass an authenticated `storage` instance to
// have the resulting tree (and any downloads from it) draw against that
// account's quota instead of the anonymous per-IP one — same technique
// megaManager.js already uses elsewhere in this project. Omit it (or pass
// null) for anonymous access, which is all that's needed just to browse.
function loadFolderTree(url, storage) {
    return new Promise((resolve, reject) => {
        let root;
        try {
            root = storage ? mega.File.fromURL(url, {}, storage) : mega.File.fromURL(url);
        } catch (error) {
            return reject(new Error(`Invalid MEGA folder link: ${error.message}`));
        }
        if (!root) return reject(new Error('Could not parse MEGA folder link'));

        const timeout = setTimeout(() => reject(new Error('Timed out loading folder from MEGA')), 30000);
        root.loadAttributes((err) => {
            clearTimeout(timeout);
            if (err) return reject(new Error(`Failed to load folder: ${err.message}`));
            if (!root.directory) return reject(new Error('That link points to a single file, not a folder — use the regular MEGA link flow for single files.'));
            resolve(root);
        });
    });
}

// Direct (non-recursive) children of a folder node, split by type.
function splitChildren(node) {
    const children = Array.isArray(node.children) ? node.children : [];
    return {
        folders: children.filter(c => c.directory),
        files: children.filter(c => !c.directory)
    };
}

// Walks a folder node down a path of child-name segments (used to
// reconstruct a selection after the admin has navigated a few levels deep,
// and to re-locate a job's folder after a bot restart for resume).
function walkPath(rootNode, nameSegments) {
    let node = rootNode;
    for (const name of nameSegments) {
        const { folders } = splitChildren(node);
        const next = folders.find(f => f.name === name);
        if (!next) return null;
        node = next;
    }
    return node;
}

const VIDEO_EXT = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff'];

function classifyFile(name) {
    const lower = String(name || '').toLowerCase();
    if (VIDEO_EXT.some(ext => lower.endsWith(ext))) return 'video';
    if (IMAGE_EXT.some(ext => lower.endsWith(ext))) return 'photo';
    return 'other';
}

// Timeout scales with size so small files fail fast and large ones aren't
// cut off mid-transfer. Mirrors the same logic already used elsewhere in
// this project for the single-link download flow.
function calculateTimeout(bytes) {
    const BASE_MS = 30000;
    const MIN_SPEED_BYTES_PER_MS = (1024 * 1024) / 1000; // ~1 MB/s floor
    const MIN_TIMEOUT = 60000;
    const MAX_TIMEOUT = 45 * 60 * 1000;
    return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, BASE_MS + (bytes / MIN_SPEED_BYTES_PER_MS)));
}

// Downloads one already-resolved file node (from loadFolderTree's result
// tree — anonymous or authenticated, whichever the caller loaded) to
// destPath. Verifies the final size on disk matches the expected size; a
// mismatch is treated as a corrupt/incomplete download and the partial file
// is removed.
async function downloadFileNode(node, destPath, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
        const expectedSize = node.size || 0;
        const timeout = setTimeout(() => {
            reject(new Error('Download timed out'));
        }, calculateTimeout(expectedSize));

        const writeStream = fs.createWriteStream(destPath);
        let downloaded = 0;
        let stream;
        try {
            stream = node.download();
        } catch (error) {
            clearTimeout(timeout);
            writeStream.end();
            return reject(new Error(`Download failed to start: ${error.message}`));
        }

        stream.on('data', (chunk) => {
            downloaded += chunk.length;
            if (onProgress) onProgress(downloaded, expectedSize);
        });
        stream.on('error', (err) => {
            clearTimeout(timeout);
            writeStream.end();
            try { fs.unlinkSync(destPath); } catch (e) { /* best-effort */ }
            reject(err);
        });
        stream.pipe(writeStream);

        writeStream.on('finish', () => {
            clearTimeout(timeout);
            // Corrupt/incomplete check — MEGA link expired mid-transfer,
            // connection dropped silently, etc. Only trust files whose size
            // matches what MEGA reported for the node.
            if (expectedSize > 0 && downloaded !== expectedSize) {
                try { fs.unlinkSync(destPath); } catch (e) { /* best-effort */ }
                return reject(new Error(`Corrupt download — expected ${formatBytes(expectedSize)}, got ${formatBytes(downloaded)}`));
            }
            resolve({ path: destPath, size: downloaded });
        });
        writeStream.on('error', (err) => {
            clearTimeout(timeout);
            try { fs.unlinkSync(destPath); } catch (e) { /* best-effort */ }
            reject(err);
        });
    });
}

module.exports = {
    formatBytes,
    sanitizeFilename,
    isQuotaError,
    parseMegaFolderUrl,
    loadFolderTree,
    splitChildren,
    walkPath,
    classifyFile,
    pickAccount,
    downloadFileNode,
    ensureAccountStorage
};
