/**
 * GitHub tag zip downloader
 * Downloads and extracts GitHub repository tags
 */

import fs from 'fs/promises';
import path from 'path';
import {createWriteStream} from 'fs';
import {pipeline} from 'stream/promises';
import {createHash} from 'crypto';
import {Extract} from 'unzipper';
import logger from '../../common/logger.js';

/**
 * Download a file from URL
 * @param {string} url - Download URL
 * @param {string} destPath - Destination file path
 * @returns {Promise<void>} Promise that resolves when download is complete
 */
const downloadFile = async (url, destPath) => {
    const response = await fetch(url);
    
    if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    await pipeline(
        response.body,
        createWriteStream(destPath)
    );
};

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
 * Extract zip file to a directory
 * @param {string} zipPath - Zip file path
 * @param {string} destDir - Destination directory
 * @returns {Promise<string>} Extracted directory path (first directory in zip)
 */
const extractZip = async (zipPath, destDir) => {
    await fs.mkdir(destDir, {recursive: true});
    
    const readStream = (await import('fs')).createReadStream(zipPath);
    await pipeline(
        readStream,
        Extract({path: destDir})
    );

    // GitHub zip files contain a single root directory named {repo}-{tag}
    // Return the path to this directory
    const entries = await fs.readdir(destDir);
    if (entries.length === 0) {
        throw new Error('Extracted zip is empty');
    }

    const extractedPath = path.join(destDir, entries[0]);
    const stats = await fs.stat(extractedPath);
    
    if (!stats.isDirectory()) {
        throw new Error('Expected a directory in the zip file');
    }

    return extractedPath;
};

/**
 * Download GitHub tag zip and extract it
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} tag - Tag name
 * @param {string} tempDir - Temporary directory for extraction
 * @returns {Promise<{extractedPath: string, cleanup: Function}>} Extracted path and cleanup function
 */
export const downloadAndExtractTag = async (owner, repo, tag, tempDir) => {
    const url = `https://github.com/${owner}/${repo}/archive/refs/tags/${tag}.zip`;
    const zipPath = path.join(tempDir, `${repo}-${tag}.zip`);
    const extractDir = path.join(tempDir, `${repo}-${tag}`);

    try {
        logger.debug(`Downloading ${url}...`);
        await downloadFile(url, zipPath);
        
        logger.debug(`Extracting to ${extractDir}...`);
        const extractedPath = await extractZip(zipPath, extractDir);
        
        // Clean up zip file
        await fs.unlink(zipPath);
        
        logger.debug(`Extracted to ${extractedPath}`);
        
        return {
            extractedPath,
            cleanup: async () => {
                try {
                    await fs.rm(extractDir, {recursive: true, force: true});
                    logger.debug(`Cleaned up ${extractDir}`);
                } catch (err) {
                    logger.warn(`Failed to cleanup ${extractDir}: ${err.message}`);
                }
            }
        };
    } catch (err) {
        // Cleanup on error
        try {
            await fs.unlink(zipPath).catch(() => {});
            await fs.rm(extractDir, {recursive: true, force: true}).catch(() => {});
        } catch {
            // Ignore cleanup errors
        }

        throw new Error(`Failed to download/extract ${owner}/${repo}@${tag}: ${err.message}`);
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
