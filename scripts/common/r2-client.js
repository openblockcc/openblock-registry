/**
 * Cloudflare R2 client for uploading and deleting files
 */

import {S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand} from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import logger from './logger.js';

// R2 configuration from environment variables
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'openblock-registry';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://registry.openblock.cc';

let s3Client = null;

/**
 * Initialize S3 client for R2
 * @returns {S3Client} S3 client instance
 */
const getClient = () => {
    if (!s3Client) {
        if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
            throw new Error('R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
        }

        s3Client = new S3Client({
            region: 'auto',
            endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY
            }
        });
    }
    return s3Client;
};

/**
 * Format file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size
 */
const formatSize = (bytes) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
};

/**
 * Upload a file to R2
 * @param {string} localPath - Local file path
 * @param {string} remotePath - Remote path in R2 bucket
 * @returns {Promise<{url: string, size: number}>} Upload result
 */
export const uploadFile = async (localPath, remotePath) => {
    const client = getClient();
    const fileContent = await fs.readFile(localPath);
    const stats = await fs.stat(localPath);

    const command = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: remotePath,
        Body: fileContent,
        ContentType: 'application/zip'
    });

    await client.send(command);
    const url = `${R2_PUBLIC_URL}/${remotePath}`;

    logger.success(`Uploaded: ${remotePath} (${formatSize(stats.size)})`);

    return {
        url,
        size: stats.size
    };
};

/**
 * Delete a file from R2
 * @param {string} remotePath - Remote path in R2 bucket
 */
export const deleteFile = async (remotePath) => {
    const client = getClient();

    const command = new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: remotePath
    });

    await client.send(command);
    logger.success(`Deleted: ${remotePath}`);
};

/**
 * Check if a file exists in R2
 * @param {string} remotePath - Remote path in R2 bucket
 * @returns {Promise<boolean>} True if file exists
 */
export const fileExists = async (remotePath) => {
    try {
        const client = getClient();
        const command = new HeadObjectCommand({
            Bucket: R2_BUCKET,
            Key: remotePath
        });
        await client.send(command);
        return true;
    } catch (err) {
        if (err.name === 'NotFound') {
            return false;
        }
        throw err;
    }
};

/**
 * Get public URL for a file
 * @param {string} remotePath - Remote path in R2 bucket
 * @returns {string} Public URL
 */
export const getPublicUrl = (remotePath) => {
    return `${R2_PUBLIC_URL}/${remotePath}`;
};

/**
 * Upload JSON data directly to R2
 * @param {object} data - JSON data to upload
 * @param {string} remotePath - Remote path in R2 bucket
 * @returns {Promise<{url: string}>} Upload result
 */
export const uploadJson = async (data, remotePath) => {
    const client = getClient();
    const content = JSON.stringify(data, null, 4);

    const command = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: remotePath,
        Body: content,
        ContentType: 'application/json'
    });

    await client.send(command);
    const url = `${R2_PUBLIC_URL}/${remotePath}`;

    logger.success(`Uploaded: ${remotePath} (${formatSize(content.length)})`);

    return {url};
};

export default {
    uploadFile,
    uploadJson,
    deleteFile,
    fileExists,
    getPublicUrl
};
