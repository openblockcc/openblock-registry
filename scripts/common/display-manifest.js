/**
 * Shared display-manifest normalization for the display-channel hardening (§5).
 *
 * Three consumers must agree byte-for-byte on what "the display content" of a
 * plugin version is and how it hashes:
 *   - the PR validation bot (renders the authoritative report from a git tag),
 *   - the freeze baseline under approved/{id}.json (committed, PR-reviewed),
 *   - the sync pipeline (compares each new tag's dist against the baseline).
 *
 * Keeping the extraction + normalization + hashing in one module is what
 * guarantees those three speak the same language. The functions here are pure:
 * they take already-loaded manifest data and icon byte hashes, never touching
 * the network or filesystem, so the same logic runs identically on the bot
 * (HTTP-fetched tag) and in sync (local dist).
 */

import crypto from 'crypto';

/**
 * Frozen text fields drawn from the `openblock` section of package.json.
 * These are the human-readable strings a user sees and trusts in the GUI.
 */
export const FROZEN_OPENBLOCK_FIELDS = [
    'name',
    'description',
    'helpLink',
    'learnMore',
    'manufactor',
    'tags'
];

/**
 * Icon fields. Frozen by content hash (the bytes), not by URL, since the URL is
 * rewritten to R2/base64 during build. Icons are the highest-risk display item.
 */
export const ICON_FIELDS = [
    'iconURL',
    'connectionIconURL',
    'connectionSmallIconURL'
];

/**
 * Normalize a name/description field that may be a plain string or a
 * formatMessage descriptor. The displayed text is frozen at the manifest level:
 * a formatMessage keeps both its id and default so neither can be swapped
 * silently; a plain string is kept verbatim.
 * @param {*} value - Raw field value
 * @returns {*} Canonical representation (string, or {id, default}) or null
 */
const normalizeMessage = (value) => {
    if (typeof value === 'string') {
        return value;
    }
    if (value && typeof value === 'object' && value.formatMessage) {
        const fm = value.formatMessage;
        return {
            id: typeof fm.id === 'string' ? fm.id : null,
            default: typeof fm.default === 'string' ? fm.default : null
        };
    }
    return null;
};

/**
 * Normalize the npm `author` field (string or {name, email, url} object) into a
 * stable shape so equivalent authors hash identically.
 * @param {*} author - Raw author value
 * @returns {*} Canonical author (string or {name, email, url}) or null
 */
const normalizeAuthor = (author) => {
    if (typeof author === 'string') {
        return author;
    }
    if (author && typeof author === 'object') {
        return {
            name: author.name ?? null,
            email: author.email ?? null,
            url: author.url ?? null
        };
    }
    return null;
};

/**
 * Extract the frozen display object from a compiled package.json. Only fields
 * that are present are included, so the baseline stays minimal and a later tag
 * that adds a field is treated as a change (not a silent match).
 * @param {object} packageJson - Compiled dist/package.json (or tag package.json)
 * @returns {object} Canonical display object (no icons — those hash separately)
 */
export const extractDisplay = (packageJson) => {
    const openblock = packageJson.openblock || {};
    const display = {};

    for (const field of FROZEN_OPENBLOCK_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(openblock, field)) {
            continue;
        }
        const value = openblock[field];
        if (field === 'name' || field === 'description') {
            display[field] = normalizeMessage(value);
        } else if (field === 'tags') {
            // Preserve authored order; only coerce to an array of strings.
            display[field] = Array.isArray(value) ? value.map(String) : value;
        } else {
            display[field] = value;
        }
    }

    if (Object.prototype.hasOwnProperty.call(packageJson, 'author')) {
        display.author = normalizeAuthor(packageJson.author);
    }

    return display;
};

/**
 * List the icon fields actually referenced by a manifest, with their raw values.
 * Lets callers know which icon bytes they need to hash for this plugin.
 * @param {object} packageJson - Compiled dist/package.json (or tag package.json)
 * @returns {Array<{field: string, value: string}>} Referenced icon fields
 */
export const listIconFields = (packageJson) => {
    const openblock = packageJson.openblock || {};
    const refs = [];
    for (const field of ICON_FIELDS) {
        const value = openblock[field];
        if (typeof value === 'string' && value) {
            refs.push({field, value});
        }
    }
    return refs;
};

/**
 * Hash an icon's raw bytes. The freeze is over content, so the same image hashes
 * the same whether it arrived as a relative file, an R2 URL, or a data URI.
 * @param {Buffer|Uint8Array} bytes - Icon file bytes
 * @returns {string} `sha256:<hex>`
 */
export const hashIconBytes = (bytes) => {
    const hash = crypto.createHash('sha256');
    hash.update(bytes);
    return `sha256:${hash.digest('hex')}`;
};

/**
 * Deterministically stringify a value with object keys sorted recursively, so
 * structurally equal display data always produces identical bytes to hash.
 * @param {*} value - JSON-serializable value
 * @returns {string} Canonical JSON string
 */
export const canonicalStringify = (value) => {
    const canonicalize = (node) => {
        if (Array.isArray(node)) {
            return node.map(canonicalize);
        }
        if (node && typeof node === 'object') {
            const out = {};
            for (const key of Object.keys(node).sort()) {
                out[key] = canonicalize(node[key]);
            }
            return out;
        }
        return node;
    };
    return JSON.stringify(canonicalize(value));
};

/**
 * Compute the single displayHash binding the text display object and the icon
 * content hashes together. This is the value compared across the bot report,
 * the approved baseline, and every incoming sync version.
 * @param {object} display - Display object from extractDisplay()
 * @param {object} icons - Map of icon field → `sha256:<hex>`
 * @returns {string} `sha256:<hex>`
 */
export const computeDisplayHash = (display, icons) => {
    const payload = canonicalStringify({display, icons: icons || {}});
    const hash = crypto.createHash('sha256');
    hash.update(payload, 'utf-8');
    return `sha256:${hash.digest('hex')}`;
};

/**
 * Assemble a full approved-baseline record for approved/{id}.json. Pairs the
 * repo→id binding (which also closes the R3.1 namespace-takeover gap) with the
 * frozen display object, icon hashes, and the combined displayHash.
 * @param {object} options - Record options
 * @param {string} options.id - Plugin id (deviceId or extensionId)
 * @param {string} options.type - 'devices' or 'extensions'
 * @param {string} options.repository - Canonical repository URL
 * @param {object} options.display - Display object from extractDisplay()
 * @param {object} options.icons - Map of icon field → `sha256:<hex>`
 * @returns {object} Approved baseline record
 */
export const buildApprovedRecord = ({id, type, repository, display, icons}) => ({
    id,
    type,
    repository,
    display,
    icons: icons || {},
    displayHash: computeDisplayHash(display, icons)
});

export default {
    FROZEN_OPENBLOCK_FIELDS,
    ICON_FIELDS,
    extractDisplay,
    listIconFields,
    hashIconBytes,
    canonicalStringify,
    computeDisplayHash,
    buildApprovedRecord
};
