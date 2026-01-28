# OpenBlock Registry

OpenBlock 官方插件注册中心，管理所有官方和社区贡献的插件、设备、库和工具链。

## 概述

此仓库是 OpenBlock 生态系统的中央索引，包含：

- **设备 (Devices)** - Arduino、ESP32 等开发板定义
- **扩展 (Extensions)** - 传感器、执行器等功能扩展
- **库 (Libraries)** - Arduino/MicroPython 共享库
- **工具链 (Toolchains)** - 编译器和上传工具

## 资源获取

所有资源托管在 Cloudflare R2，通过 CDN 分发：

```
https://registry.openblock.cc/packages.json
```

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

CLI 会自动验证并创建 Pull Request。

## 仓库结构

```
openblock-registry/
├── README.md                 # 本文件
├── CONTRIBUTING.md           # 贡献指南
├── packages.json             # 官方包索引
├── .github/
│   └── workflows/
│       ├── validate-pr.yml   # PR 验证工作流
│       ├── upload-to-r2.yml  # R2 上传工作流
│       └── sync-mirrors.yml  # 镜像同步工作流
└── schemas/
    └── package-entry.schema.json  # JSON Schema
```

## packages.json 结构

```json
{
    "schemaVersion": "1.0.0",
    "updatedAt": "2026-01-27T10:00:00Z",
    "packages": {
        "devices": [],
        "extensions": [],
        "libraries": [],
        "toolchains": []
    }
}
```

## 相关链接

- [OpenBlock 官网](https://openblock.cc)
- [插件开发指南](https://openblock.cc/docs/plugin-development)
- [CLI 工具文档](https://openblock.cc/docs/cli)

## 许可证

MIT License

