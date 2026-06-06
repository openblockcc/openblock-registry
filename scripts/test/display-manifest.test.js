/**
 * Standalone checks for display-manifest.js. No test framework in this repo, so
 * run directly: `node scripts/test/display-manifest.test.js` (or `npm test`).
 */

import assert from 'assert';
import {
    extractDisplay,
    listIconFields,
    hashIconBytes,
    canonicalStringify,
    computeDisplayHash,
    buildApprovedRecord
} from '../common/display-manifest.js';

const samplePkg = {
    author: 'OpenBlock',
    openblock: {
        deviceId: 'arduinoUno',
        name: {formatMessage: {id: 'arduinoUno.name', default: 'Arduino Uno'}},
        description: 'A classic board',
        helpLink: 'https://example.com/help',
        learnMore: 'https://example.com/learn',
        manufactor: 'Arduino',
        tags: ['arduino', 'kit'],
        iconURL: './icon.png',
        type: 'arduino'
    }
};

// extractDisplay only keeps frozen fields, normalizes formatMessage, drops type.
const display = extractDisplay(samplePkg);
assert.deepStrictEqual(display, {
    name: {id: 'arduinoUno.name', default: 'Arduino Uno'},
    description: 'A classic board',
    helpLink: 'https://example.com/help',
    learnMore: 'https://example.com/learn',
    manufactor: 'Arduino',
    tags: ['arduino', 'kit'],
    author: 'OpenBlock'
});
assert.ok(!('type' in display), 'non-frozen fields must be excluded');

// listIconFields surfaces only referenced icon fields.
assert.deepStrictEqual(listIconFields(samplePkg), [{field: 'iconURL', value: './icon.png'}]);

// canonicalStringify is key-order independent.
assert.strictEqual(
    canonicalStringify({b: 1, a: {d: 2, c: 3}}),
    canonicalStringify({a: {c: 3, d: 2}, b: 1})
);

// Icon hash is stable and content-addressed.
const iconHash = hashIconBytes(Buffer.from('fake-png-bytes'));
assert.match(iconHash, /^sha256:[0-9a-f]{64}$/);

// displayHash is deterministic and sensitive to both display and icon changes.
const icons = {iconURL: iconHash};
const h1 = computeDisplayHash(display, icons);
const h2 = computeDisplayHash(extractDisplay(samplePkg), {iconURL: hashIconBytes(Buffer.from('fake-png-bytes'))});
assert.strictEqual(h1, h2, 'identical input → identical hash');

const tampered = {...display, name: {id: 'arduinoUno.name', default: 'Arduino UNO (evil)'}};
assert.notStrictEqual(computeDisplayHash(tampered, icons), h1, 'name change must change hash');
assert.notStrictEqual(
    computeDisplayHash(display, {iconURL: hashIconBytes(Buffer.from('other-bytes'))}),
    h1,
    'icon change must change hash'
);

// Cross-repo contract: openblock-registry-cli mirrors this normalization to
// generate approved/{id}.json, and the bot recomputes here to verify it. If
// either side changes the algorithm, these frozen vectors must change in lockstep
// (the CLI's display-manifest.test.js pins the identical values).
assert.strictEqual(
    hashIconBytes(Buffer.from('fake-png-bytes')),
    'sha256:3c6ed5fc41c950bf0db531eb22f945467fb8d999f80d82ba27dcc9fd90add54d',
    'icon hash vector drifted — update the CLI mirror too'
);
assert.strictEqual(
    h1,
    'sha256:3eaf38fb08846c7923cede63daacba3e873f48b9eafc7089354273495d2de3bc',
    'displayHash vector drifted — update the CLI mirror too'
);

// buildApprovedRecord wires the binding + hash together.
const record = buildApprovedRecord({
    id: 'arduinoUno',
    type: 'devices',
    repository: 'https://github.com/openblock-plugin/arduinoUno',
    display,
    icons
});
assert.strictEqual(record.displayHash, h1);
assert.strictEqual(record.repository, 'https://github.com/openblock-plugin/arduinoUno');
assert.strictEqual(record.id, 'arduinoUno');

console.log('display-manifest.test.js: all assertions passed');
