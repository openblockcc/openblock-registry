/**
 * Arduino toolchain packager
 * Downloads Arduino resources directly and packages them
 */

import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import {createWriteStream} from 'fs';
import {pipeline} from 'stream/promises';
import {createHash} from 'crypto';
import {exec} from 'child_process';
import {promisify} from 'util';
import archiver from 'archiver';
import logger from '../../common/logger.js';
import {fetchPackageIndex, collectDownloadResources, parseCore} from './index-parser.js';

const execAsync = promisify(exec);

// Domains with known SSL certificate issues
const INSECURE_DOMAINS = [
    'dl.cdn.sipeed.com'
];

/**
 * Check if a URL requires insecure connection (skip SSL verification)
 * @param {string} url - URL to check
 * @returns {boolean} True if SSL verification should be skipped
 */
const isInsecureDomain = (url) => {
    try {
        const urlObj = new URL(url);
        return INSECURE_DOMAINS.some(domain => urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`));
    } catch {
        return false;
    }
};

/**
 * Download a file from URL using http/https modules (supports insecure connections)
 * @param {string} url - Download URL
 * @param {string} destPath - Destination file path
 * @returns {Promise<void>} Promise that resolves when download is complete
 */
const downloadWithAgent = (url, destPath) => {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            rejectUnauthorized: !isInsecureDomain(url) // Skip SSL verification for known problematic domains
        };

        if (isInsecureDomain(url)) {
            logger.warn(`Using insecure connection for: ${urlObj.hostname}`);
        }

        const request = client.request(options, response => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                const redirectUrl = new URL(response.headers.location, url).toString();
                logger.info(`Redirecting to: ${redirectUrl}`);
                downloadWithAgent(redirectUrl, destPath).then(resolve)
.catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
                return;
            }

            const fileStream = createWriteStream(destPath);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', err => {
                fs.unlink(destPath).catch(() => {});
                reject(err);
            });
        });

        request.on('error', reject);
        request.end();
    });
};

/**
 * Download a file from URL
 * @param {string} url - Download URL
 * @param {string} destPath - Destination file path
 */
export const downloadFile = async (url, destPath) => {
    logger.info(`Downloading: ${url}`);
    await fs.mkdir(path.dirname(destPath), {recursive: true});

    if (isInsecureDomain(url)) {
        // Use custom download for domains with SSL issues
        await downloadWithAgent(url, destPath);
    } else {
        // Use native fetch for normal domains
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
        }
        const fileStream = createWriteStream(destPath);
        await pipeline(response.body, fileStream);
    }

    logger.success(`Downloaded: ${path.basename(destPath)}`);
};

// Increase maxBuffer for large archives (100MB)
const EXEC_OPTIONS = {maxBuffer: 100 * 1024 * 1024};

/**
 * Extract archive (zip, tar.gz, tar.bz2)
 * @param {string} archivePath - Archive file path
 * @param {string} destDir - Destination directory
 */
export const extractArchive = async (archivePath, destDir) => {
    await fs.mkdir(destDir, {recursive: true});

    if (archivePath.endsWith('.zip')) {
        // Use PowerShell on Windows, unzip on Unix
        if (process.platform === 'win32') {
            await execAsync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, EXEC_OPTIONS);
        } else {
            await execAsync(`unzip -o "${archivePath}" -d "${destDir}"`, EXEC_OPTIONS);
        }
    } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
        await execAsync(`tar -xzf "${archivePath}" -C "${destDir}"`, EXEC_OPTIONS);
    } else if (archivePath.endsWith('.tar.bz2') || archivePath.endsWith('.tbz2')) {
        await execAsync(`tar -xjf "${archivePath}" -C "${destDir}"`, EXEC_OPTIONS);
    } else {
        throw new Error(`Unsupported archive format: ${archivePath}`);
    }

    logger.success(`Extracted: ${path.basename(archivePath)}`);
};

/**
 * Setup Arduino CLI with additional board manager URLs
 * @param {string} cliPath - Path to arduino-cli executable
 * @param {string[]} additionalUrls - Additional board manager URLs
 * @param {string} dataDir - Arduino data directory
 */
export const setupArduinoCli = async (cliPath, additionalUrls, dataDir) => {
    const configPath = path.join(dataDir, 'arduino-cli.yaml');

    // Create config file
    const config = {
        board_manager: {
            additional_urls: additionalUrls
        },
        directories: {
            data: dataDir,
            downloads: path.join(dataDir, 'staging'),
            user: path.join(dataDir, 'user')
        }
    };

    await fs.mkdir(dataDir, {recursive: true});
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    // Update index
    logger.info('Updating Arduino core index...');
    await execAsync(`"${cliPath}" core update-index --config-file "${configPath}"`);
    logger.success('Core index updated');

    return configPath;
};

/**
 * Install Arduino core
 * @param {string} cliPath - Path to arduino-cli executable
 * @param {string} configPath - Path to arduino-cli config file
 * @param {string} core - Core to install (e.g., 'arduino:avr@1.8.6')
 */
export const installCore = async (cliPath, configPath, core) => {
    logger.info(`Installing core: ${core}`);
    await execAsync(`"${cliPath}" core install ${core} --config-file "${configPath}"`);
    logger.success(`Installed: ${core}`);
};

/**
 * Calculate SHA-256 checksum of a file
 * @param {string} filePath - File path
 * @returns {Promise<string>} Hex checksum
 */
export const calculateChecksum = async (filePath) => {
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content)
        .digest('hex');
};

/**
 * Create a zip archive from a directory
 * @param {string} sourceDir - Source directory to archive
 * @param {string} outputPath - Output zip file path
 * @param {string|boolean} destPath - Destination path in archive (default: directory name)
 *                                    Use false to put contents at root, true/undefined to use dir name
 * @returns {Promise<{size: number, checksum: string}>} Archive info
 */
export const createZipArchive = async (sourceDir, outputPath, destPath = null) => {
    await fs.mkdir(path.dirname(outputPath), {recursive: true});

    // Default: use the directory name as the root folder in the archive
    const archiveDestPath = destPath === null ? path.basename(sourceDir) : destPath;

    return new Promise((resolve, reject) => {
        const output = createWriteStream(outputPath);
        const archive = archiver('zip', {zlib: {level: 9}});

        output.on('close', async () => {
            const stats = await fs.stat(outputPath);
            const checksum = await calculateChecksum(outputPath);
            resolve({
                size: stats.size,
                checksum: `SHA-256:${checksum.toUpperCase()}`
            });
        });

        archive.on('error', reject);
        archive.pipe(output);
        // archiveDestPath: string = folder name in archive, false = put at root
        archive.directory(sourceDir, archiveDestPath);
        archive.finalize();
    });
};

/**
 * Get Arduino CLI executable name for current platform
 * @returns {string} Executable name
 */
export const getCliExecutable = () => {
    return process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
};

/**
 * Verify checksum of a downloaded file
 * @param {string} filePath - File path
 * @param {string} expectedChecksum - Expected checksum (format: "SHA-256:XXXX")
 * @returns {Promise<boolean>} True if checksum matches
 */
export const verifyChecksum = async (filePath, expectedChecksum) => {
    if (!expectedChecksum) return true;

    const [algorithm, expected] = expectedChecksum.split(':');
    if (algorithm.toUpperCase() !== 'SHA-256') {
        logger.warn(`Unsupported checksum algorithm: ${algorithm}`);
        return true;
    }

    const actual = await calculateChecksum(filePath);
    return actual.toUpperCase() === expected.toUpperCase();
};

/**
 * Download and verify a file
 * @param {string} url - Download URL
 * @param {string} destPath - Destination file path
 * @param {string} expectedChecksum - Expected checksum
 * @returns {Promise<void>} Resolves when download and verification is complete
 */
export const downloadAndVerify = async (url, destPath, expectedChecksum) => {
    await downloadFile(url, destPath);

    if (expectedChecksum) {
        const valid = await verifyChecksum(destPath, expectedChecksum);
        if (!valid) {
            await fs.unlink(destPath);
            throw new Error(`Checksum mismatch for ${path.basename(destPath)}`);
        }
        logger.debug(`Checksum verified: ${path.basename(destPath)}`);
    }
};

/**
 * Merge package indexes from multiple URLs
 * @param {string[]} urls - Array of package index URLs
 * @returns {Promise<object>} Merged package index
 */
export const mergePackageIndexes = async (urls) => {
    const merged = {packages: []};
    const packageMap = new Map();

    for (const url of urls) {
        try {
            const index = await fetchPackageIndex(url);
            for (const pkg of index.packages || []) {
                const existing = packageMap.get(pkg.name);
                if (existing) {
                    // Merge platforms and tools
                    existing.platforms = [...(existing.platforms || []), ...(pkg.platforms || [])];
                    existing.tools = [...(existing.tools || []), ...(pkg.tools || [])];
                } else {
                    packageMap.set(pkg.name, {...pkg});
                }
            }
        } catch (err) {
            logger.warn(`Failed to fetch package index from ${url}: ${err.message}`);
        }
    }

    merged.packages = Array.from(packageMap.values());
    return merged;
};

/**
 * Flatten extracted directory if contents are in a single subdirectory
 * Many archives extract to a folder like "avr-gcc-7.3.0-atmel3.6.1-arduino7/"
 * We want the contents directly in the target directory
 * @param {string} dir - Directory to flatten
 * @returns {Promise<void>} Resolves when flattening is complete
 */
const flattenExtractedDir = async (dir) => {
    const entries = await fs.readdir(dir, {withFileTypes: true});

    // If there's exactly one directory and no files, flatten it
    if (entries.length === 1 && entries[0].isDirectory()) {
        const subDirName = entries[0].name;
        const subDir = path.join(dir, subDirName);
        const subEntries = await fs.readdir(subDir);

        // Use a temporary directory to avoid conflicts when subdir name matches a file/folder being moved
        const tempDir = `${dir}_flatten_temp_${Date.now()}`;
        await fs.rename(subDir, tempDir);

        // Move all contents from temp directory to parent
        for (const entry of subEntries) {
            const srcPath = path.join(tempDir, entry);
            const destPath = path.join(dir, entry);
            await fs.rename(srcPath, destPath);
        }

        // Remove empty temp directory
        await fs.rmdir(tempDir);
        logger.debug(`Flattened: ${subDirName}`);
    }
};

/**
 * Custom error class for missing tools
 */
export class MissingToolsError extends Error {
    constructor (platform, missingTools) {
        const missingList = missingTools.map(t => `${t.packager}/${t.name}@${t.version}`).join(', ');
        super(`Missing tools for ${platform}: ${missingList}`);
        this.name = 'MissingToolsError';
        this.platform = platform;
        this.missingTools = missingTools;
    }
}

/**
 * Package a toolchain by directly downloading resources (no arduino-cli)
 * @param {object} options - Packaging options
 * @param {string} options.core - Core identifier (e.g., 'arduino:avr')
 * @param {string} options.version - Version to package
 * @param {string} options.platform - Target OpenBlock platform (e.g., 'win32-x64')
 * @param {string[]} options.indexUrls - Package index URLs
 * @param {string} options.workDir - Working directory
 * @returns {Promise<object>} Package result with packagesDir and fallbackUsed properties
 */
export const packageToolchainDirect = async (options) => {
    const {core, version, platform, indexUrls, workDir} = options;
    const {packager, architecture} = parseCore(core);

    logger.info(`Packaging ${core}@${version} for ${platform}`);

    // Merge all package indexes
    logger.info('Fetching package indexes...');
    const packageIndex = await mergePackageIndexes(indexUrls);

    // Collect download resources
    const resources = collectDownloadResources(packageIndex, packager, architecture, version, platform);

    if (resources.errors.length > 0) {
        for (const err of resources.errors) {
            logger.error(err);
        }
        throw new Error(`Failed to collect download resources`);
    }

    if (!resources.platform) {
        throw new Error(`Platform not found: ${core}@${version}`);
    }

    // Check for missing tools - if any tool is missing for this platform, skip packaging
    if (resources.missingTools.length > 0) {
        throw new MissingToolsError(platform, resources.missingTools);
    }

    // Create directories
    const downloadDir = path.join(workDir, 'downloads');
    const packagesDir = path.join(workDir, 'packages');
    await fs.mkdir(downloadDir, {recursive: true});
    await fs.mkdir(packagesDir, {recursive: true});

    // Download and extract platform (core)
    logger.info(`Downloading platform: ${packager}:${architecture}@${version}`);
    const platformArchive = path.join(downloadDir, resources.platform.archiveFileName);
    await downloadAndVerify(resources.platform.url, platformArchive, resources.platform.checksum);

    // Extract platform to packages/{packager}/hardware/{architecture}/{version}/
    const platformDestDir = path.join(packagesDir, packager, 'hardware', architecture, version);
    await fs.mkdir(platformDestDir, {recursive: true});
    await extractArchive(platformArchive, platformDestDir);

    // Move contents if extracted into a subdirectory
    await flattenExtractedDir(platformDestDir);

    // Download and extract tools
    logger.info(`Downloading ${resources.tools.length} tools...`);
    for (const tool of resources.tools) {
        logger.info(`  Downloading: ${tool.name}@${tool.version}`);
        const toolArchive = path.join(downloadDir, tool.archiveFileName);
        await downloadAndVerify(tool.url, toolArchive, tool.checksum);

        // Extract tool to packages/{packager}/tools/{toolname}/{version}/
        const toolDestDir = path.join(packagesDir, tool.packager, 'tools', tool.name, tool.version);
        await fs.mkdir(toolDestDir, {recursive: true});
        await extractArchive(toolArchive, toolDestDir);

        // Move contents if extracted into a subdirectory
        await flattenExtractedDir(toolDestDir);
    }

    logger.success(`Package assembled: ${packagesDir}`);
    return {packagesDir, fallbackUsed: resources.fallbackUsed};
};

export default {
    downloadFile,
    extractArchive,
    setupArduinoCli,
    installCore,
    createZipArchive,
    calculateChecksum,
    getCliExecutable,
    verifyChecksum,
    downloadAndVerify,
    mergePackageIndexes,
    packageToolchainDirect,
    MissingToolsError
};
