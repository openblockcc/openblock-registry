/**
 * Standalone checks for limits.js (R2.1 submodule rules + R2.3 caps).
 * Run: `node scripts/test/limits.test.js` (or `npm test`).
 */

import assert from 'assert';
import {isAllowedSubmoduleUrl, parseSubmoduleUrls, validateSubmodules, LIMITS} from '../common/limits.js';

// Allowed: https github.com only.
assert.ok(isAllowedSubmoduleUrl('https://github.com/arduino-libraries/Servo.git'));
assert.ok(isAllowedSubmoduleUrl('https://github.com/openblockcc/avr-stl'));

// Rejected: non-https, other hosts, look-alikes, non-http schemes, junk.
assert.ok(!isAllowedSubmoduleUrl('http://github.com/x/y.git'), 'http rejected');
assert.ok(!isAllowedSubmoduleUrl('https://gitlab.com/x/y.git'), 'other host rejected');
assert.ok(!isAllowedSubmoduleUrl('https://github.com.evil.com/x/y'), 'suffix look-alike rejected');
assert.ok(!isAllowedSubmoduleUrl('https://github.com@evil.com/x/y'), 'userinfo look-alike rejected');
assert.ok(!isAllowedSubmoduleUrl('https://evil.com/github.com/x'), 'path look-alike rejected');
assert.ok(!isAllowedSubmoduleUrl('git://github.com/x/y'), 'git scheme rejected');
assert.ok(!isAllowedSubmoduleUrl('git@github.com:x/y.git'), 'scp form rejected');
assert.ok(!isAllowedSubmoduleUrl('file:///etc/passwd'), 'file scheme rejected');
assert.ok(!isAllowedSubmoduleUrl('ext::sh -c whoami'), 'ext scheme rejected');
assert.ok(!isAllowedSubmoduleUrl('http://169.254.169.254/'), 'SSRF host rejected');

// Parse `git config --file .gitmodules --get-regexp \.url$` output.
const parsed = parseSubmoduleUrls(
    'submodule.libraries/Servo.url https://github.com/arduino-libraries/Servo.git\n' +
    'submodule.libraries/avr-stl.url https://github.com/openblockcc/avr-stl.git\n'
);
assert.deepStrictEqual(parsed, [
    {key: 'submodule.libraries/Servo.url', url: 'https://github.com/arduino-libraries/Servo.git'},
    {key: 'submodule.libraries/avr-stl.url', url: 'https://github.com/openblockcc/avr-stl.git'}
]);

// validateSubmodules: legit set passes.
assert.deepStrictEqual(validateSubmodules(parsed), {ok: true, errors: []});

// One bad URL fails.
const bad = validateSubmodules([{key: 's.url', url: 'http://169.254.169.254/'}]);
assert.strictEqual(bad.ok, false);
assert.strictEqual(bad.errors.length, 1);

// Too many submodules fails on count.
const many = Array.from({length: LIMITS.maxSubmodules + 1}, (_, i) => ({
    key: `s${i}.url`,
    url: 'https://github.com/x/y.git'
}));
assert.ok(validateSubmodules(many).errors.some(e => /Too many submodules/.test(e)));

// Empty set is fine.
assert.deepStrictEqual(validateSubmodules([]), {ok: true, errors: []});

console.log('limits.test.js: all assertions passed');
