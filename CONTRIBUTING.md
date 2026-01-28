# 贡献指南

感谢你对 OpenBlock Registry 的贡献！本指南将帮助你了解如何提交插件。

## 提交方式

### 推荐：使用 CLI 工具

```bash
npm install -g @openblock/cli
cd your-plugin-project
npx @openblock/cli publish
```

CLI 工具会自动验证并创建规范的 Pull Request。

### 手动提交（不推荐）

如果你需要手动提交，请按以下步骤操作：

1. Fork 此仓库
2. 修改 `packages.json`，添加你的包条目
3. 提交 Pull Request

## 插件要求

### 必需文件

| 文件 | 说明 |
|------|------|
| `package.json` | 包含 `openblock` 配置字段 |
| `LICENSE` | 开源许可证 |
| `README.md` | 说明文档 |
| `icon.png` | 插件图标 (推荐 128x128) |

### package.json 示例

```json
{
    "name": "my-extension",
    "version": "1.0.0",
    "description": "My awesome extension",
    "author": "Your Name <email@example.com>",
    "license": "MIT",
    "repository": {
        "type": "git",
        "url": "https://github.com/username/my-extension"
    },
    "openblock": {
        "id": "myExtension",
        "type": "extension",
        "name": "My Extension",
        "description": "Does something awesome",
        "iconURL": "./icon.png",
        "tags": ["sensor", "input"],
        "supportDevices": ["arduinoUno", "esp32"]
    }
}
```

### Git Tag 要求

- 使用语义化版本格式：`v1.0.0`、`v1.2.3`
- Tag 必须已推送到远程仓库
- Tag 版本必须与 `package.json` 中的 `version` 一致

### 仓库要求

- 必须是 **GitHub 公开仓库**
- 仓库必须可访问
- Tag 对应的 zip 文件必须可下载

## 审核流程

1. **自动验证** - CI 会自动检查格式、唯一性、下载链接
2. **人工审核** - 维护者检查代码安全性和内容合规性
3. **资源上传** - 审核通过后，资源自动上传到 R2
4. **合并发布** - PR 合并后约 10 分钟内生效

## 验证清单

提交前请确认：

- [ ] `package.json` 格式正确
- [ ] `openblock.id` 在本仓库中唯一
- [ ] Git tag 存在且版本匹配
- [ ] 仓库是公开的
- [ ] 必需文件齐全

## Toolchain 申请

Toolchain（编译工具链）由 OpenBlock 官方统一管理。

如需新增 Toolchain，请：

1. 提交 Issue，说明需求
2. 提供上游源地址（Arduino/ARM/Espressif 等）
3. 等待维护者收录

## 常见问题

### Q: 为什么我的 PR 验证失败？

检查 CI 日志中的错误信息，常见原因：
- `openblock.id` 与现有包重复
- Git tag 不存在或未推送
- 仓库不是公开的

### Q: 如何更新已发布的版本？

发布新版本即可。每个版本一旦发布，内容不可变更。

### Q: 如何撤销发布？

```bash
npx @openblock/cli unpublish 1.0.0
```

这会提交一个移除该版本的 PR。

## 联系方式

- [GitHub Issues](https://github.com/openblockcc/openblock-registry/issues)
- [Discord 社区](https://discord.gg/openblock)

