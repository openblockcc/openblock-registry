/**
 * Integration check for the strategy-b display override (§5.8) as it lands in
 * packages.json. Run: `node scripts/test/sync-override.test.js` (or `npm test`).
 */

import assert from 'assert';
import sync from '../packages/sync.js';
import {addPackageVersion} from '../common/packages-json.js';

const {buildPackageEntry, findCurrentEntry, applyApprovedDisplay} = sync;

const type = 'devices';
const repoUrl = 'https://github.com/openblock-plugin/arduinoUno';

// Existing, previously-approved published entry: name "Arduino Uno", good icon.
let packagesJson = {
    packages: {
        devices: [{
            deviceId: 'arduinoUno',
            name: 'Arduino Uno',
            iconURL: 'https://registry.openblock.cc/devices/arduinoUno/icon.png',
            helpLink: 'https://good.example/help',
            repository: repoUrl,
            versions: [{version: '1.0.0', url: 'https://r2/old.zip', checksum: 'SHA-256:old', size: '10'}]
        }],
        extensions: [],
        toolchains: []
    }
};

// A new tag drifts the display: renamed to a phishing label + swapped icon.
const driftedDist = {
    author: 'Attacker',
    openblock: {
        deviceId: 'arduinoUno',
        name: 'Arduino Uno (CLAIM YOUR PRIZE)',
        iconURL: 'https://registry.openblock.cc/devices/arduinoUno/2.0.0/icon.png',
        helpLink: 'https://evil.example/phish'
    }
};

let entry = buildPackageEntry(driftedDist, type, '2.0.0', repoUrl, {
    url: 'https://r2/new.zip',
    archiveFileName: 'arduinoUno-2.0.0.zip',
    checksum: 'new',
    size: 20
});

// Strategy b: override the drifted display with the approved published values.
const currentEntry = findCurrentEntry(packagesJson, type, 'arduinoUno');
assert.ok(currentEntry, 'should find the existing approved entry');
entry = applyApprovedDisplay(entry, currentEntry);
entry.displayOverridden = true;

packagesJson = addPackageVersion(packagesJson, type, entry);

const result = packagesJson.packages.devices[0];

// Top-level display stays the approved one despite 2.0.0 being newest.
assert.strictEqual(result.name, 'Arduino Uno', 'phishing name must not surface');
assert.strictEqual(result.iconURL, 'https://registry.openblock.cc/devices/arduinoUno/icon.png', 'icon must stay approved');
assert.strictEqual(result.helpLink, 'https://good.example/help', 'helpLink must stay approved');
assert.ok(!Object.prototype.hasOwnProperty.call(result, 'author'), 'drifted author dropped (not in approved entry)');
assert.strictEqual(result.displayOverridden, true, 'override flag recorded');

// But the new code version is published and is the latest download.
const versions = result.versions.map(v => v.version);
assert.deepStrictEqual(versions, ['2.0.0', '1.0.0'], 'new code version published');
assert.strictEqual(result.versions[0].url, 'https://r2/new.zip', 'latest download points at new code');

console.log('sync-override.test.js: all assertions passed');
