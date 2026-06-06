/**
 * Read/write access to the committed display-freeze baseline under approved/.
 *
 * Each plugin gets approved/{id}.json — a PR-reviewed snapshot of its frozen
 * display fields, icon content hashes, the combined displayHash, and the
 * repo→id binding. This directory is the trust anchor for §5: sync compares
 * every incoming tag against it, and changing it requires a human-reviewed PR.
 *
 * Reviewer-facing icon bytes may sit beside the JSON (e.g. {id}.iconURL.png) so
 * a PR diff shows the image, but the security comparison only ever uses the
 * hashes inside the JSON — never the loose files.
 */

import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the committed approved/ directory. */
export const APPROVED_DIR = path.resolve(__dirname, '../../approved');

/**
 * Path to a plugin's approved baseline JSON.
 * @param {string} id - Plugin id (deviceId or extensionId)
 * @param {string} [approvedDir] - Override baseline directory
 * @returns {string} Absolute file path
 */
export const approvedManifestPath = (id, approvedDir = APPROVED_DIR) =>
    path.join(approvedDir, `${id}.json`);

/**
 * Path to a reviewer-facing approved icon file (for PR diff image preview).
 * @param {string} id - Plugin id
 * @param {string} field - Icon field name (iconURL, connectionIconURL, ...)
 * @param {string} ext - File extension including dot (e.g. '.png')
 * @param {string} [approvedDir] - Override baseline directory
 * @returns {string} Absolute file path
 */
export const approvedIconPath = (id, field, ext, approvedDir = APPROVED_DIR) =>
    path.join(approvedDir, `${id}.${field}${ext}`);

/**
 * Read a plugin's approved baseline. Returns null when the plugin has never been
 * reviewed (no baseline committed yet).
 * @param {string} id - Plugin id
 * @param {string} [approvedDir] - Override baseline directory
 * @returns {Promise<object|null>} Approved record or null
 */
export const readApprovedManifest = async (id, approvedDir = APPROVED_DIR) => {
    try {
        const content = await fs.readFile(approvedManifestPath(id, approvedDir), 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
};

/**
 * Write a plugin's approved baseline (used by tooling that prepares the freeze
 * PR). Creates the directory if needed.
 * @param {object} record - Approved record from buildApprovedRecord()
 * @param {string} [approvedDir] - Override baseline directory
 * @returns {Promise<string>} Path written
 */
export const writeApprovedManifest = async (record, approvedDir = APPROVED_DIR) => {
    await fs.mkdir(approvedDir, {recursive: true});
    const filePath = approvedManifestPath(record.id, approvedDir);
    await fs.writeFile(filePath, `${JSON.stringify(record, null, 4)}\n`, 'utf-8');
    return filePath;
};

export default {
    APPROVED_DIR,
    approvedManifestPath,
    approvedIconPath,
    readApprovedManifest,
    writeApprovedManifest
};
