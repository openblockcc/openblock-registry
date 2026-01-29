# Toolchain 自动打包发布系统

本系统用于自动下载、打包和发布 Arduino 工具链到 Cloudflare R2 存储。

## 功能特性

- **自动版本检测**：从 Arduino 官方包索引获取最新版本
- **增量更新**：只处理新版本，跳过已存在的版本
- **旧版本清理**：自动删除不再需要的旧版本（先上传新版本，再删除旧版本）
- **跨平台打包**：在任意平台上打包所有目标架构（无需 arduino-cli）
- **完整依赖打包**：打包整个 `packages/` 目录，包含所有依赖工具
- **Checksum 验证**：下载文件后验证 SHA-256 校验和

## 目录结构

```
toolchains/
├── README.md                 # 本文件
├── sync.js                   # 主同步脚本
├── calculate-diff.js         # 差异计算脚本
├── merge-packages.js         # packages.json 合并工具
└── arduino/
    ├── index-parser.js       # Arduino 包索引解析器
    ├── packager.js           # 打包工具
    └── platform-mapper.js    # 平台映射
```

## 配置文件

### toolchains.json

位于仓库根目录，定义需要同步的工具链：

```json
{
  "arduino": {
    "board_manager": {
      "additional_urls": [
        "https://downloads.arduino.cc/packages/package_index.json",
        "https://espressif.github.io/arduino-esp32/package_esp32_index.json"
      ]
    },
    "packages": [
      {
        "id": "arduino-arduino-avr",
        "core": "arduino:avr"
      },
      {
        "id": "arduino-esp32-esp32",
        "core": "esp32:esp32"
      }
    ]
  }
}
```

## 环境变量

运行同步脚本需要配置以下环境变量：

| 变量名 | 说明 | 必需 |
|--------|------|------|
| `R2_ACCOUNT_ID` | Cloudflare 账户 ID | ✓ |
| `R2_ACCESS_KEY_ID` | R2 访问密钥 ID | ✓ |
| `R2_SECRET_ACCESS_KEY` | R2 访问密钥 | ✓ |
| `R2_BUCKET` | R2 存储桶名称 | 默认: `openblock-registry` |
| `R2_PUBLIC_URL` | R2 公开访问 URL | 默认: `https://registry.openblock.cc` |

## 使用方法

### 安装依赖

```bash
cd openblock-registry/scripts
npm install
```

### 查看差异（不执行任何操作）

```bash
npm run diff:toolchains
```

输出示例：
```
Calculating Toolchain Diff
──────────────────────────────────────────────────
Fetching Latest Versions
──────────────────────────────────────────────────
i arduino-arduino-avr: latest version is 1.8.6
i arduino-esp32-esp32: latest version is 3.0.0

Diff Results
──────────────────────────────────────────────────
i To Add (8):
  + arduino-arduino-avr@1.8.6#win32-x64
  + arduino-arduino-avr@1.8.6#darwin-x64
  ...
i To Delete (8):
  - arduino-arduino-avr@1.8.5#win32-x64
  - arduino-arduino-avr@1.8.5#darwin-x64
  ...
```

### 执行同步

```bash
npm run sync:toolchains
```

### Dry Run 模式

只显示将要执行的操作，不实际执行：

```bash
node toolchains/sync.js --dry-run
```

### 指定平台

只处理特定平台：

```bash
node toolchains/sync.js --platform win32-x64
```

## 工作流程

1. **读取配置**：从 `toolchains.json` 读取需要同步的包列表
2. **获取最新版本**：从 Arduino 包索引获取每个包的最新版本
3. **计算差异**：比较期望状态与 `packages.json` 中的当前状态
4. **打包新版本**（直接下载，无需 arduino-cli）：
   - 解析 package_index.json 获取下载信息
   - 下载 platform core 和所有依赖的 tools
   - 验证 SHA-256 校验和
   - 组装 `packages/` 目录结构
   - 打包为 zip 并上传到 R2
5. **删除旧版本**：从 R2 删除不再需要的旧版本压缩包
6. **更新 packages.json**：添加新版本条目，移除旧版本条目

### 跨平台打包

由于采用直接下载方式，**可以在任意平台上打包所有目标架构**。例如在 ubuntu-latest 上可以同时打包：
- win32-x64, win32-ia32
- darwin-x64, darwin-arm64
- linux-x64, linux-ia32, linux-arm64, linux-arm

这大大简化了 CI/CD 配置，只需要一个 runner 即可完成所有平台的打包。

## 压缩包结构

生成的压缩包内部结构：

```
{id}-{platform}-{version}.zip
└── packages/
    └── arduino/
        ├── hardware/
        │   └── avr/
        │       └── 1.8.6/
        └── tools/
            ├── avr-gcc/
            ├── avrdude/
            └── ...
```

## 支持的平台

| 平台标识 | 操作系统 | 架构 |
|----------|----------|------|
| `win32-x64` | Windows | x64 |
| `win32-ia32` | Windows | x86 |
| `darwin-x64` | macOS | Intel |
| `darwin-arm64` | macOS | Apple Silicon |
| `linux-x64` | Linux | x64 |
| `linux-arm64` | Linux | ARM64 |
| `linux-arm` | Linux | ARM32 |

## GitHub Actions 集成

由于采用直接下载方式，只需要**一个 ubuntu-latest runner** 即可打包所有平台。

已配置的 workflow 文件：`.github/workflows/sync-arduino-toolchains.yml`

触发条件：
- 手动触发（支持 dry-run 模式）
- 每周一 00:00 UTC 自动运行
- `toolchains.json` 文件变更时

环境变量（需在 GitHub Secrets 中配置）：
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_PUBLIC_URL`

