# 巴娜娜水印&微調器

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | [繁體中文](README_zh-TW.md) | [简体中文](README_zh-CN.md) | [日本語](README_ja.md) | [한국어](README_ko.md)

这是一个强大的网页工具，专门设计用于去除由 Google Gemini 生成图片中的水印。此工具完全在浏览器端运行，无需将图片上传至服务器，确保您的隐私安全。

## 🎯 与原版的差异
本项目是专注于水印移除并强化标志定制功能的**改版**。

## 🖼️ 实际演示

<div align="center">
  <img src="assets/demo_preview_1.png" alt="实际演示 1" width="45%">
  <img src="assets/demo_preview_2.png" alt="实际演示 2" width="45%">
</div>


## ✨ 主要功能

- **🚫 自动去除水印**：利用逆向 Alpha 混合算法（Reverse Alpha Blending），精确还原被水印覆盖的像素。
- **🎨 自定义 Logo 替换**：上传您的 Logo 图片，取代原本水印位置，并可调整透明度（0% ~ 100%）及大小（10% ~ 300%）。
- **📥 弹性下载选项**：
  - **单张下载**：点击下载按钮取得含 Logo 版本（前置 R_/S_）。下载前勾选「N」可下载无 Logo 版本（N_ 前缀）。
  - **批量下载**：上传 Logo 后，ZIP 会同时包含两种版本：
    - 含 Logo：`R_图片_clean.png`（横式）/ `S_图片_clean.png`（竖式）
    - 无 Logo：`N_图片_clean.png`
- **🔒 隐私优先**：所有处理皆在您的本地浏览器中完成，图片不会离开您的设备。
- **⚡ 即时预览**：上传即处理，快速查看结果。
- **🖱️ 拖拽支持**：支持将图片直接拖拽至窗口进行处理。
- **👀 对比模式**：长按处理后的图片即可查看原始图片，方便比较去除效果。
- **⚙️ 智能与手动模式**：
  - **自动检测**：根据图片分辨率自动判断水印大小。
  - **手动选择**：可强制选择小（48px）或大（96px）水印模式以应对特殊情况。
- **💾 高画质下载**：一键下载处理后的图片，支持 PNG（无损）或 JPEG（压缩）格式。
- **📋 剪贴板粘贴**：支持直接粘贴 (Ctrl+V) 截图或图片进行处理。
- **📦 批量 ZIP 下载**：下载多张图片时自动打包为 ZIP 文件（`banana_watermark_remover.zip`），方便整理。
- **🌐 多语言支持**：界面支持英文、繁体中文、简体中文、日文及韩文。

## 🛠️ 技术原理

此项目使用纯 JavaScript (Canvas API) 实现。它预先加载了 Gemini 水印的 Alpha 遮罩（Mask），并通过计算每个像素的原始颜色值来“反算”扣除水印的影响，从而通过无损或近乎无痕的去除效果。

## 🚀 如何使用

1. **开启网页**：直接在浏览器中打开 `index.html`。
2. **上传图片**：点击上传区域选择图片，或直接将 JPG/PNG/WEBP 图片拖入。
3. **查看结果**：系统会自动处理并显示结果。
4. **调整设置**（如有需要）：如果效果不佳，可以尝试在下拉菜单中切换“Force Small”或“Force Large”。
5. **下载**：满意后点击“Download”按钮保存图片。

## 📦 安装与运行

本项目为静态网页，无需安装复杂的后端环境。

1. **克隆项目**：
   ```bash
   git clone https://github.com/aflypenstudio/GeminiWatermarkRemove.git
   ```
2. **进入目录**：
   ```bash
   cd GeminiWatermarkRemove
   ```
3. **运行**：
   直接用浏览器打开 `index.html` 即可使用。
   *注意：由于浏览器安全策略（CORS），若直接开启本地文件可能会导致遮罩图片加载失败。建议使用简单的本地服务器运行，例如使用 Python：*
   ```bash
   # Python 3
   python -m http.server 8000
   ```

   然后在浏览器访问 `http://localhost:8000`。

## 🖥️ 桌面应用程序 (Tauri)

除了网页版本，我们也提供使用 [Tauri](https://tauri.app/) 构建的原生桌面应用程序。

### 特色功能
- **离线使用**：无需网络连接即可运作
- **原生性能**：通过原生 API 提供更快的文件处理
- **独立运行**：无需浏览器即可执行

### 下载
> 即将推出 - 请至 [Releases](https://github.com/kevintsai1202/GeminiWatermarkRemove/releases) 页面下载安装包。

### 从源代码构建
```bash
# 前置需求：Rust、Node.js
cargo install tauri-cli

# 克隆并构建
git clone https://github.com/aflypenstudio/GeminiWatermarkRemove.git
cd GeminiWatermarkRemove
git checkout feature/tauri-app

# 开发模式
cargo tauri dev

# 构建安装包
cargo tauri build
```
输出位置：`src-tauri/target/release/bundle/`


## 🙏 致谢 (Acknowledgements)

特别感谢 [GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) 项目提供的重要信息与灵感。

## 📄 授权条款 (License)

本道目采用 MIT 授权条款。详细内容请参阅 [LICENSE](LICENSE) 文件。

