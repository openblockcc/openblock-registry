/**
 * GitHub source downloader
 * Clones GitHub repository tags (with submodules) and creates archives
 */

import fs from 'fs/promises';
import path from 'path';
import {createWriteStream} from 'fs';
import {createHash} from 'crypto';
import {spawn} from 'child_process';
import logger from '../../common/logger.js';
import {LIMITS, parseSubmoduleUrls, validateSubmodules} from '../../common/limits.js';

/**
 * Run a git command and capture its output. Resolves on exit code 0.
 * @param {string[]} args - Arguments passed to git
 * @param {string} [cwd] - Working directory
 * @returns {Promise<{stdout: string, stderr: string}>} Captured output
 */
const runGit = (args, cwd) => new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
        cwd,
        env: {
            ...process.env,
            // Never prompt for credentials in CI
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: 'echo'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => {
        stdout += chunk.toString();
    });
    proc.stderr.on('data', chunk => {
        stderr += chunk.toString();
    });
    proc.on('error', err => {
        reject(new Error(`Failed to spawn git: ${err.message}`));
    });
    proc.on('close', code => {
        if (code === 0) {
            resolve({stdout, stderr});
        } else {
            const cmd = ['git', ...args].join(' ');
            reject(new Error(`${cmd} exited with code ${code}\n${stderr.trim()}`));
        }
    });
});

/**
 * Calculate SHA-256 checksum of a file
 * @param {string} filePath - File path
 * @returns {Promise<string>} SHA-256 checksum in uppercase
 */
export const calculateChecksum = async (filePath) => {
    const hash = createHash('sha256');
    const fileBuffer = await fs.readFile(filePath);
    hash.update(fileBuffer);
    return hash.digest('hex').toUpperCase();
};

/**
 * Get file size in bytes
 * @param {string} filePath - File path
 * @returns {Promise<number>} File size in bytes
 */
export const getFileSize = async (filePath) => {
    const stats = await fs.stat(filePath);
    return stats.size;
};

/**
 * Total size of a directory tree in bytes (follows no symlinks). Used to enforce
 * the clone-size cap after fetching source + submodules.
 * @param {string} dir - Directory path
 * @returns {Promise<number>} Total size in bytes
 */
export const dirSize = async (dir) => {
    let total = 0;
    const entries = await fs.readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            total += await dirSize(full);
        } else if (entry.isFile()) {
            const stats = await fs.stat(full);
            total += stats.size;
        }
    }
    return total;
};

/**
 * Fetch a repo's declared submodules under a github.com + https policy (R2.1).
 * Reads .gitmodules as data first and rejects the whole clone if any submodule
 * URL is off-github / non-https or the count exceeds the cap — before any
 * submodule content is fetched, so a malicious .gitmodules can't trigger SSRF.
 * Only validated top-level submodules are fetched (no recursion into nested ones).
 * @param {string} clonePath - Cloned repository path
 * @returns {Promise<void>} Resolves once submodules are fetched (or none exist)
 */
const fetchSubmodulesSafely = async (clonePath) => {
    const gitmodulesPath = path.join(clonePath, '.gitmodules');
    let configOutput = '';
    try {
        const res = await runGit(['config', '--file', gitmodulesPath, '--get-regexp', '\\.url$']);
        configOutput = res.stdout;
    } catch {
        // No .gitmodules (or no url entries) → nothing to fetch.
        return;
    }

    const entries = parseSubmoduleUrls(configOutput);
    if (entries.length === 0) {
        return;
    }

    const {ok, errors} = validateSubmodules(entries);
    if (!ok) {
        throw new Error(`Submodule policy violation: ${errors.join('; ')}`);
    }

    // Lock the transport to https for the fetch itself, as defense in depth on
    // top of the github.com host check above (blocks file://, ext::, ssh, git://).
    await runGit([
        '-c', 'core.autocrlf=false',
        '-c', 'core.symlinks=false',
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        'submodule', 'update', '--init', '--depth=1', '--quiet'
    ], clonePath);
};

/**
 * Shallow-clone a GitHub repository at a given tag, with all submodules.
 *
 * GitHub-generated source archives (archive/refs/tags/<tag>.zip) do NOT include
 * submodule contents, so we must use git clone for plugins that use submodules.
 *
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} tag - Tag name
 * @param {string} tempDir - Temporary directory parent
 * @returns {Promise<{extractedPath: string, cleanup: Function}>} Cloned path and cleanup function
 */
export const downloadAndExtractTag = async (owner, repo, tag, tempDir) => {
    const url = `https://github.com/${owner}/${repo}.git`;
    const clonePath = path.join(tempDir, `${repo}-${tag}`);

    // Make sure the target directory does not exist (git clone refuses to clone into a non-empty dir)
    await fs.rm(clonePath, {recursive: true, force: true}).catch(() => {});

    try {
        // Clone WITHOUT recursing submodules: .gitmodules is attacker-controlled,
        // so we must read+validate it as data before fetching anything (R2.1).
        logger.debug(`Cloning ${url} @ ${tag}...`);
        await runGit([
            // Disable autocrlf so source files (especially firmware/binary blobs) round-trip cleanly
            '-c', 'core.autocrlf=false',
            '-c', 'core.symlinks=false',
            'clone',
            '--depth=1',
            '--branch', tag,
            '--single-branch',
            '--quiet',
            url,
            clonePath
        ]);

        // Validate + fetch submodules under the github.com/https policy (R2.1).
        await fetchSubmodulesSafely(clonePath);

        // Enforce the clone-size cap on the full tree, source + submodules (R2.3).
        const cloneBytes = await dirSize(clonePath);
        if (cloneBytes > LIMITS.maxCloneBytes) {
            throw new Error(`Clone size ${cloneBytes} exceeds limit ${LIMITS.maxCloneBytes}`);
        }

        logger.debug(`Cloned to ${clonePath} (${cloneBytes} bytes)`);

        return {
            extractedPath: clonePath,
            cleanup: async () => {
                try {
                    await fs.rm(clonePath, {recursive: true, force: true});
                    logger.debug(`Cleaned up ${clonePath}`);
                } catch (err) {
                    logger.warn(`Failed to cleanup ${clonePath}: ${err.message}`);
                }
            }
        };
    } catch (err) {
        // Cleanup on failure
        await fs.rm(clonePath, {recursive: true, force: true}).catch(() => {});
        throw new Error(`Failed to clone ${owner}/${repo}@${tag}: ${err.message}`);
    }
};

/**
 * Create a zip archive from a directory
 * @param {string} sourceDir - Source directory to zip
 * @param {string} outputPath - Output zip file path
 * @returns {Promise<{path: string, checksum: string, size: number}>} Zip file info
 */
export const createZipArchive = async (sourceDir, outputPath) => {
    const archiver = (await import('archiver')).default;

    await fs.mkdir(path.dirname(outputPath), {recursive: true});

    const output = createWriteStream(outputPath);
    const archive = archiver('zip', {
        zlib: {level: 9} // Maximum compression
    });

    return new Promise((resolve, reject) => {
        output.on('close', async () => {
            try {
                const checksum = await calculateChecksum(outputPath);
                const size = await getFileSize(outputPath);

                logger.debug(`Created zip: ${outputPath} (${size} bytes, SHA-256: ${checksum})`);

                resolve({
                    path: outputPath,
                    checksum,
                    size
                });
            } catch (err) {
                reject(err);
            }
        });

        archive.on('error', reject);
        output.on('error', reject);

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
};

export default {
    downloadAndExtractTag,
    createZipArchive,
    calculateChecksum,
    getFileSize
};
