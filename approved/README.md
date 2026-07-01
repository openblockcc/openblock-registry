# approved/ — frozen display baselines

This directory is the **trust anchor for the display channel** (see
[`SECURITY_RISK_ANALYSIS.md` §5](../SECURITY_RISK_ANALYSIS.md)).

Each plugin has one `{id}.json` holding a PR-reviewed snapshot of the fields a
user *sees and trusts* in the GUI: `name`, `description`, `helpLink`,
`learnMore`, `manufactor`, `tags`, `author`, and the content hashes of its
icons. The combined `displayHash` is what the sync pipeline compares against on
every new tag.

```
approved/
  arduinoUno.json              # frozen display fields + icon hashes + displayHash + repo→id binding
  arduinoUno.iconURL.png       # (optional) icon bytes, for image diff during PR review
```

Schema: [`../schemas/approved.schema.json`](../schemas/approved.schema.json).
Format produced by `scripts/common/display-manifest.js` → `buildApprovedRecord`.

## How a baseline gets here

1. A maintainer opens (or the CLI auto-opens) a PR adding/updating `{id}.json`.
2. The validation bot posts an **authoritative report** rendered from the plugin
   at its published git tag — not from the PR body, which is attacker-controlled.
3. Merging the PR **freezes** that display content.

## Why it matters

- **Code still flows per tag.** Only the *display* channel is frozen; new `.zip`
  code, version, checksum keep syncing automatically.
- **Drift is overridden, not displayed.** If a later tag changes a frozen field
  without an accompanying approved-PR, sync publishes the code but keeps the
  approved display values (strategy **b**). Users never see unreviewed names or
  icons.
- **No silent renames or icon swaps** → no phishing via the plugin library.

> This does **not** sandbox plugin code (R4.1). An attacker can still ship RCE in
> a new tag's `main.js`; the display freeze only stops impersonation/phishing.
