/**
 * Standalone checks for display-enforcement.js.
 * Run: `node scripts/test/display-enforcement.test.js` (or `npm test`).
 */

import assert from 'assert';
import {enforceDisplay} from '../packages/display-enforcement.js';

const repoUrl = 'https://github.com/foo/bar';
const approved = {repository: repoUrl, displayHash: 'sha256:abc'};

// No baseline → publish but flag for review.
assert.deepStrictEqual(
    enforceDisplay({id: 'x', repoUrl, approved: null, incomingDisplayHash: 'sha256:z', hasCurrentEntry: false}),
    {action: 'publish', pendingReview: true, reason: "No approved baseline for 'x'; display published unreviewed"}
);

// Wrong repo for the id → reject (R3.1 namespace takeover).
assert.strictEqual(
    enforceDisplay({
        id: 'x',
        repoUrl: 'https://github.com/evil/bar',
        approved,
        incomingDisplayHash: 'sha256:abc',
        hasCurrentEntry: true
    }).action,
    'reject'
);

// Matching hash → publish as-is.
assert.deepStrictEqual(
    enforceDisplay({id: 'x', repoUrl, approved, incomingDisplayHash: 'sha256:abc', hasCurrentEntry: true}),
    {action: 'publish'}
);

// Drift with a live entry to fall back to → override (strategy b).
assert.strictEqual(
    enforceDisplay({id: 'x', repoUrl, approved, incomingDisplayHash: 'sha256:DRIFT', hasCurrentEntry: true}).action,
    'override'
);

// Drift with no live entry → reject (nothing approved to serve).
assert.strictEqual(
    enforceDisplay({id: 'x', repoUrl, approved, incomingDisplayHash: 'sha256:DRIFT', hasCurrentEntry: false}).action,
    'reject'
);

console.log('display-enforcement.test.js: all assertions passed');
