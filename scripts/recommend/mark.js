#!/usr/bin/env node

/**
 * Add the packages a just-merged PR introduced into registry.json's
 * `recommended` allowlist.
 *
 * Invoked by the mark-recommended workflow when a merged PR carries the
 * `recommended` label. New URLs are those present in the current (post-merge)
 * registry but absent from the base (pre-merge) registry. The file is rewritten
 * preserving its original line endings, so the diff touches only the
 * recommended block.
 */

import fs from 'fs/promises';

const parseArgs = () => {
    const opts = {};
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            opts[key] = value;
        }
    }
    return opts;
};

const newEntries = (current = [], base = []) => {
    const baseSet = new Set(base);
    return current.filter(url => !baseSet.has(url));
};

const addUnique = (list = [], additions) => {
    const set = new Set(list);
    const result = [...list];
    for (const url of additions) {
        if (!set.has(url)) {
            set.add(url);
            result.push(url);
        }
    }
    return result;
};

const main = async () => {
    const {current, base, output} = parseArgs();
    if (!current || !base) {
        throw new Error('Usage: mark.js --current=<registry.json> --base=<base-registry.json> [--output=<path>]');
    }

    const rawCurrent = await fs.readFile(current, 'utf-8');
    const currentRegistry = JSON.parse(rawCurrent);

    let baseRegistry = {devices: [], extensions: []};
    try {
        baseRegistry = JSON.parse(await fs.readFile(base, 'utf-8'));
    } catch {
        // No base registry (e.g. first commit): treat everything as new.
    }

    const newDevices = newEntries(currentRegistry.devices, baseRegistry.devices);
    const newExtensions = newEntries(currentRegistry.extensions, baseRegistry.extensions);

    if (newDevices.length === 0 && newExtensions.length === 0) {
        console.log('No newly added packages found; nothing to recommend.');
        return;
    }

    const recommended = currentRegistry.recommended ?? {devices: [], extensions: []};
    recommended.devices = addUnique(recommended.devices, newDevices);
    recommended.extensions = addUnique(recommended.extensions, newExtensions);
    currentRegistry.recommended = recommended;

    // Preserve the original file's line endings and trailing-newline style so
    // the commit diff is limited to the recommended block.
    const eol = rawCurrent.includes('\r\n') ? '\r\n' : '\n';
    const trailing = /\n$/.test(rawCurrent) ? eol : '';
    let serialized = JSON.stringify(currentRegistry, null, 4);
    if (eol !== '\n') {
        serialized = serialized.replace(/\n/g, eol);
    }
    serialized += trailing;

    await fs.writeFile(output ?? current, serialized, 'utf-8');
    console.log(`Recommended +${newDevices.length} device(s), +${newExtensions.length} extension(s)`);
};

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
