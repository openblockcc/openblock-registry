/**
 * Display-freeze enforcement for the sync pipeline (§5.7 / §5.8).
 *
 * Pure decision logic: given an incoming version's display hash and the committed
 * approved baseline, decide what sync should do. No IO — the caller performs the
 * uploads and packages.json writes.
 *
 * Default drift policy is strategy **b** (§5.8): the code of a drifted version
 * still publishes, but its display fields are forced back to the approved
 * baseline so a user can never see an unreviewed name/icon. This also asserts the
 * repo→id binding, closing the R3.1 namespace-takeover gap.
 */

/**
 * Display fields as they appear in a packages.json entry. When overriding a
 * drifted version, these are taken from the last-approved published entry
 * (already in publishable shape) rather than reconstructed from the normalized
 * baseline.
 */
export const DISPLAY_ENTRY_FIELDS = [
    'name',
    'description',
    'iconURL',
    'connectionIconURL',
    'connectionSmallIconURL',
    'helpLink',
    'learnMore',
    'manufactor',
    'tags',
    'author'
];

/**
 * Decide how to handle an incoming version's display channel.
 * @param {object} options - Decision inputs
 * @param {string} options.id - Plugin id
 * @param {string} options.repoUrl - Repository URL of the version being synced
 * @param {object|null} options.approved - approved/{id}.json record, or null if never reviewed
 * @param {string} options.incomingDisplayHash - displayHash computed from the new dist
 * @param {boolean} options.hasCurrentEntry - Whether packages.json already has a published entry for this id
 * @returns {object} Decision with action ('publish'|'override'|'reject'), optional pendingReview and reason
 */
export const enforceDisplay = ({id, repoUrl, approved, incomingDisplayHash, hasCurrentEntry}) => {
    // Not yet reviewed: keep sync working pre-adoption, but flag the version so the
    // unreviewed state is observable and a baseline PR can be chased.
    if (!approved) {
        return {
            action: 'publish',
            pendingReview: true,
            reason: `No approved baseline for '${id}'; display published unreviewed`
        };
    }

    // R3.1: the baseline binds this id to one repository. A different repo
    // claiming the same id is a namespace-takeover attempt — reject it.
    if (approved.repository && approved.repository !== repoUrl) {
        return {
            action: 'reject',
            reason: `Namespace binding violation: id '${id}' is bound to ${approved.repository}, not ${repoUrl}`
        };
    }

    // Reviewed and unchanged: publish the display straight from the new dist.
    if (approved.displayHash === incomingDisplayHash) {
        return {action: 'publish'};
    }

    // Drift with no published baseline entry to fall back to: we cannot serve an
    // approved display, so block until the baseline PR catches up.
    if (!hasCurrentEntry) {
        return {
            action: 'reject',
            reason: `Display drift for '${id}' with no published baseline entry to fall back to; update approved/${id}.json via PR`
        };
    }

    // Drift (strategy b): publish code, force display back to the approved values.
    return {
        action: 'override',
        reason: `Display drift for '${id}'; serving approved display and dropping drifted values`
    };
};

export default {
    DISPLAY_ENTRY_FIELDS,
    enforceDisplay
};
