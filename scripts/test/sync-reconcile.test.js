/**
 * Integration check for display reconciliation (§5.8): a version synced while its
 * approved baseline was stale (display overridden) gets promoted to its real
 * display once the baseline catches up and the newest tag is re-checked.
 * Run: `node scripts/test/sync-reconcile.test.js` (or `npm test`).
 */

import assert from 'assert';
import sync from '../packages/sync.js';
import {addPackageVersion} from '../common/packages-json.js';

const {planReconciliation, buildPackageEntry} = sync;

const type = 'devices';
const repoUrl = 'https://github.com/openblock-plugin/arduinoUno';

// --- planReconciliation -----------------------------------------------------

const NEW_HASH = 'sha256:new';
const overridden = {displayOverridden: true, pendingDisplayHash: NEW_HASH};

// Not overridden → no reconciliation.
assert.deepStrictEqual(
    planReconciliation(['2.0.0'], ['1.0.0'], ['2.0.0', '1.0.0'], {deviceId: 'x'}, NEW_HASH),
    {toAdd: ['2.0.0'], toSkip: ['1.0.0'], reconciledTag: null}
);

// Overridden but baseline has NOT caught up (approved ≠ pending) → no rebuild.
// This is the key guard: no per-sync churn while the baseline PR is unmerged.
assert.strictEqual(
    planReconciliation([], ['2.0.0', '1.0.0'], ['1.0.0', '2.0.0'], overridden, 'sha256:old').reconciledTag,
    null
);
// ...and no baseline at all (approvedDisplayHash omitted) → still no rebuild.
assert.strictEqual(
    planReconciliation([], ['2.0.0'], ['2.0.0'], overridden).reconciledTag,
    null
);

// Overridden AND baseline caught up → pull newest tag back into toAdd.
const recon = planReconciliation([], ['2.0.0', '1.0.0'], ['1.0.0', '2.0.0'], overridden, NEW_HASH);
assert.deepStrictEqual(recon.toAdd, ['2.0.0'], 'newest tag forced to rebuild');
assert.deepStrictEqual(recon.toSkip, ['1.0.0'], 'newest tag removed from skip');
assert.strictEqual(recon.reconciledTag, '2.0.0');

// Caught up but newest already building → no duplicate.
assert.strictEqual(
    planReconciliation(['2.0.0'], ['1.0.0'], ['2.0.0', '1.0.0'], overridden, NEW_HASH).reconciledTag,
    null
);

// --- promotion: re-check with a now-matching baseline clears the override ----

// Live entry is still serving the old approved display, flagged overridden.
let packagesJson = {
    packages: {
        devices: [{
            deviceId: 'arduinoUno',
            name: 'Arduino Uno',
            iconURL: 'https://registry.openblock.cc/devices/arduinoUno/icon.png',
            repository: repoUrl,
            displayOverridden: true,
            pendingDisplayHash: NEW_HASH,
            versions: [{version: '2.0.0', url: 'https://r2/2.0.0.zip', checksum: 'SHA-256:x', size: '20'}]
        }],
        extensions: [],
        toolchains: []
    }
};

// Baseline PR has merged: 2.0.0 is force-rebuilt, enforcement now matches, so it
// takes the publish (non-override) path — the entry is built from the real dist.
const realDist = {
    author: 'OpenBlock',
    openblock: {
        deviceId: 'arduinoUno',
        name: 'Arduino Uno R3',
        iconURL: 'https://registry.openblock.cc/devices/arduinoUno/2.0.0/icon.png'
    }
};
const promotedEntry = buildPackageEntry(realDist, type, '2.0.0', repoUrl, {
    url: 'https://r2/2.0.0.zip',
    archiveFileName: 'arduinoUno-2.0.0.zip',
    checksum: 'x',
    size: 20
});

packagesJson = addPackageVersion(packagesJson, type, promotedEntry);
const result = packagesJson.packages.devices[0];

assert.strictEqual(result.name, 'Arduino Uno R3', 'real display promoted after baseline merge');
assert.strictEqual(result.iconURL, 'https://registry.openblock.cc/devices/arduinoUno/2.0.0/icon.png');
assert.ok(!Object.prototype.hasOwnProperty.call(result, 'displayOverridden'), 'override flag cleared on promotion');
assert.ok(!Object.prototype.hasOwnProperty.call(result, 'pendingDisplayHash'), 'pending hash cleared on promotion');

console.log('sync-reconcile.test.js: all assertions passed');
