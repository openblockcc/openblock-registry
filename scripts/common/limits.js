/**
 * Resource limits and submodule constraints for the sync pipeline (R2.1 + R2.3).
 *
 * All checks here are automated blanket rules — no per-plugin manual review:
 *   - submodule URLs must be https://github.com/... (blocks SSRF to internal
 *     hosts and non-http schemes like file://, ext::, ssh, git://)
 *   - hard caps on versions per repo/run, clone size, zip size, versions kept
 *     per package, and submodule count (bounds DoS / Actions-quota burn)
 *
 * The functions are pure (string/number in, result out) so they unit-test
 * without git or the network.
 */

export const LIMITS = {
    // Newest N new versions built per repository per sync run; older ones are
    // dropped (nobody needs a plugin's 500th historical version).
    maxNewVersionsPerRepo: 20,
    // Cloned working tree size cap (source + fetched submodules), bytes.
    maxCloneBytes: 100 * 1024 * 1024,
    // Built plugin .zip size cap, bytes.
    maxZipBytes: 50 * 1024 * 1024,
    // versions[] kept per package in packages.json (keeps the file bounded).
    maxVersionsPerPackage: 40,
    // Submodule entries allowed in a single repo.
    maxSubmodules: 16
};

/**
 * Whether a submodule URL is allowed: https scheme and exactly github.com host.
 * Uses URL parsing so look-alikes (github.com.evil.com, github.com@evil.com,
 * https://evil/github.com) and non-http schemes are all rejected.
 * @param {string} url - Submodule URL
 * @returns {boolean} True if allowed
 */
export const isAllowedSubmoduleUrl = (url) => {
    let parsed;
    try {
        parsed = new URL(String(url).trim());
    } catch {
        return false;
    }
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com';
};

/**
 * Parse the output of `git config --file .gitmodules --get-regexp \.url$`.
 * Each line looks like: `submodule.<name>.url <url>`.
 * @param {string} gitConfigOutput - Raw command stdout
 * @returns {Array<{key: string, url: string}>} Parsed submodule URL entries
 */
export const parseSubmoduleUrls = (gitConfigOutput) => {
    const entries = [];
    for (const line of String(gitConfigOutput).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        const sep = trimmed.indexOf(' ');
        if (sep === -1) {
            continue;
        }
        entries.push({key: trimmed.slice(0, sep), url: trimmed.slice(sep + 1).trim()});
    }
    return entries;
};

/**
 * Validate the submodule set: count within cap and every URL https://github.com.
 * @param {Array<{key: string, url: string}>} entries - From parseSubmoduleUrls
 * @param {object} [limits] - Limit overrides (defaults to LIMITS)
 * @returns {{ok: boolean, errors: string[]}} Validation result
 */
export const validateSubmodules = (entries, limits = LIMITS) => {
    const errors = [];
    if (entries.length > limits.maxSubmodules) {
        errors.push(`Too many submodules: ${entries.length} > ${limits.maxSubmodules}`);
    }
    for (const {key, url} of entries) {
        if (!isAllowedSubmoduleUrl(url)) {
            errors.push(`Disallowed submodule URL for ${key}: ${url} (only https://github.com/ is allowed)`);
        }
    }
    return {ok: errors.length === 0, errors};
};

export default {
    LIMITS,
    isAllowedSubmoduleUrl,
    parseSubmoduleUrls,
    validateSubmodules
};
