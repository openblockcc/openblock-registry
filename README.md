# OpenBlock Registry

The central index and distribution system for the OpenBlock ecosystem. This repository manages plugin registration, toolchain configuration, and automated distribution to users worldwide.

## Table of Contents

- [Plugin Types](#plugin-types)
- [Publishing Plugins](#publishing-plugins)
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
