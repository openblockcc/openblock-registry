# OpenBlock Registry

The central index and distribution system for the OpenBlock ecosystem. This repository manages plugin registration, toolchain configuration, and automated distribution to users worldwide.

## Table of Contents

- [Plugin Types](#plugin-types)
- [Publishing Plugins](#publishing-plugins)
- [Recommended Plugins](#recommended-plugins)
- [Version Management](#version-management)
- [Translation](#translation)
- [Toolchains](#toolchains)
- [FAQ](#faq)

## Plugin Types

- **Devices** - Board definitions (e.g., Arduino Uno R4, ESP32)
- **Extensions** - Functional modules (e.g., sensors, actuators, communication modules)

## Publishing Plugins

Register your plugin by adding its GitHub URL to `registry.json`:

```json
{
  "devices": [
    "https://github.com/your-org/your-device-plugin"
  ],
  "extensions": [
    "https://github.com/your-org/your-extension-plugin"
  ]
}
```

**How to publish:**

1. Use [openblock-registry-cli](https://github.com/openblockcc/openblock-registry-cli) (recommended)
2. Or manually submit a PR to add your repository to `registry.json`

For more details, see the [Plugin Development Guide](https://wiki.openblock.cc/developer-guide/plugin-development).

Once merged, the system will automatically:

- Fetch plugin information from your repository
- Validate plugin compliance
- Add to `packages.json` index
- Distribute via `registry.openblock.cc`

## Recommended Plugins

A curated `recommended` allowlist surfaces the most common, general-purpose boards and components at the front of the device/extension libraries, so the first-screen experience for students and teachers is not diluted as the ecosystem grows. It is an **opt-in allowlist**: a plugin is shown in front only when a maintainer explicitly selects it; everything else falls back to alphabetical order.

The allowlist lives in `registry.json` under a `recommended` block of repository URLs (each URL must also appear in the matching `devices`/`extensions` list):

```json
{
  "recommended": {
    "devices": ["https://github.com/your-org/your-device-plugin"],
    "extensions": ["https://github.com/your-org/your-extension-plugin"]
  }
}
```

Ownership stays central: the flag is set in this repository, never read from a plugin's own `package.json`. During sync it is injected into `packages.json` as a package-level `recommended` field for the client to use as a secondary sort key.

**Selection criteria** (maintainer editorial judgment — there is no install/usage telemetry):

- Commonly used in teaching
- General-purpose rather than vendor-specific niche hardware
- Broad community adoption

**How a plugin gets recommended:**

- **New plugins** — when accepting the registration PR, a maintainer adds the `recommended` label and merges. An automated workflow then writes the newly added URLs into the `recommended` block. Applying labels requires repository triage/write access, so contributors cannot recommend their own plugins.
- **Existing plugins (add or revoke)** — a maintainer edits the `recommended` block directly (add or remove a URL) in a small PR, which goes through the same validation and review.

**Appeal:** if you believe your plugin should be recommended, email the maintainers to request a re-evaluation. The selection criteria above are published to keep the curated list transparent.

## Version Management

- Use Git tags to release new versions
- System automatically detects tag updates daily
- New versions are added to the index automatically
- Users can see and install new versions in OpenBlock

## Translation

Translation of all OpenBlock projects is managed on the Transifex service: <https://www.transifex.com/openblockcc/public/>

Want to help translate? Join us on Transifex!

**How it works:**

1. System automatically collects i18n content from your plugin
2. Content is pushed to Transifex for community translation
3. When new translations are available, a PR is automatically created to your repository
4. Review and merge the PR to update translations

## Toolchains

Toolchains are the tools required to compile and upload code (compilers, upload tools, libraries, etc.).

**Using toolchains:**

- Specify the toolchain ID in your device plugin's `package.json`
- System automatically downloads and configures toolchains for users

**Available toolchains:**

See [TOOLCHAINS.md](./TOOLCHAINS.md) for the list of available toolchains.

**Request a new toolchain:**

1. Check [TOOLCHAINS.md](./TOOLCHAINS.md) to confirm it's not listed
2. Submit an Issue or PR with your request

## Automation

The system automatically:

- Checks all registered plugins for updates daily
- Syncs translation files
- Validates plugins on PR submission
- Creates Issues in your repository if errors occur

## FAQ

**Q: How long until my plugin appears in OpenBlock?**

A: Usually within 24 hours after PR merge.

**Q: How do I update my published plugin?**

A: Create a new Git tag in your plugin repository. The system will detect and update automatically.

**Q: What is a translation PR?**

A: The system collects i18n content and pushes to Transifex. When new translations are available, it creates a PR to your repository automatically.

**Q: What if I receive an error Issue?**

A: Check the error details in the Issue, fix the problem, and the system will retry on the next sync.

**Q: How do I specify a toolchain?**

A: Set the `toolchain` ID in the `openblock` field of your `package.json`. See [TOOLCHAINS.md](./TOOLCHAINS.md).

## Resources

- [Plugin Development Guide](https://wiki.openblock.cc/developer-guide/plugin-development)
- [Registry CLI Tool](https://github.com/openblockcc/openblock-registry-cli)
- [Issue Tracker](https://github.com/openblockcc/openblock-registry/issues)

## License

MIT License
