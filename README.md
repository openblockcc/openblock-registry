# OpenBlock Registry

OpenBlock 官方插件注册中心，管理所有官方和社区贡献的设备、扩展和工具链。

## 概述

此仓库是 OpenBlock 生态系统的中央索引，包含：

- **设备 (Devices)** - Arduino、ESP32 等开发板定义
- **扩展 (Extensions)** - 传感器、执行器等功能扩展
- **工具链 (Toolchains)** - 编译器和上传工具

## 资源获取

所有资源托管在 Cloudflare R2，通过 CDN 分发：

```text
https://registry.openblock.cc/packages.json
```

## 仓库结构

```text
openblock-registry/
├── README.md                    # 本文件
├── CONTRIBUTING.md              # 贡献指南
├── registry.json                # 设备和扩展仓库列表
├── toolchains.json              # 工具链构建配置
├── TOOLCHAINS.md                # 可用工具链状态表格
├── schemas/
│   └── registry.schema.json     # registry.json 的 JSON Schema
└── scripts/
    ├── generate-toolchains-md.js  # 生成 TOOLCHAINS.md 的脚本
    └── toolchains/                # 工具链构建脚本
```

## 文件说明

### registry.json

存放设备和扩展的 GitHub 仓库地址列表：

```json
{
    "devices": [
        "https://github.com/openblockcc/device-arduino-uno"
    ],
    "extensions": [
        "https://github.com/openblockcc/extension-servo"
    ]
}
```

### toolchains.json

存放工具链的构建配置（Arduino Board Manager URLs 和 core 映射）：

```json
{
    "arduino": {
        "board_manager": {
            "additional_urls": ["..."]
        },
        "packages": [
            {
                "id": "arduino-arduino-avr",
                "core": "arduino:avr"
            }
        ]
    }
}
```

### TOOLCHAINS.md

展示当前 R2 中可用的工具链状态，详见 [TOOLCHAINS.md](./TOOLCHAINS.md)。

## 发布你的插件

### 1. 安装 CLI 工具

```bash
npm install -g @openblock/cli
```

### 2. 确保你的项目符合要求

- `package.json` 包含正确的 `openblock` 字段
- 项目使用 Git 管理，有对应版本的 tag
- 包含必需文件：`LICENSE`、`README.md`、`icon.png`

### 3. 发布

```bash
cd your-plugin-project
npx @openblock/cli publish
```

CLI 会自动验证并创建 Pull Request，将你的仓库地址添加到 `registry.json`。

## Toolchain 收录流程

```plaintext
1. 插件开发者需要某个 toolchain
       │
       ▼
2. 检查 TOOLCHAINS.md 是否已有该 toolchain
       │
   ┌───┴───┐
   │       │
   ▼       ▼
 已有    没有
   │       │
   ▼       ▼
直接使用  修改 toolchains.json 提交 PR
```

## 相关链接

- [OpenBlock 官网](https://openblock.cc)
- [插件开发指南](https://openblock.cc/docs/plugin-development)
- [CLI 工具文档](https://openblock.cc/docs/cli)

## 许可证

MIT License
