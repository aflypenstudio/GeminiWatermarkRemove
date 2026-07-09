# 巴娜娜透かし除去ツール&微調器

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | [繁體中文](README_zh-TW.md) | [简体中文](README_zh-CN.md) | [日本語](README_ja.md) | [한국어](README_ko.md)

M-bM-!M-5M-e画像の透かしを除去するために特別に設計された強力なWebツールです。このツールは完全にブラウザ上で動作し、画像をサーバーにアップロードする必要がないため、プライバシーが確保されます。

## 🖼️ デモ

<div align="center">
  <img src="assets/demo_preview_1.png" alt="デモ 1" width="45%">
  <img src="assets/demo_preview_2.png" alt="デモ 2" width="45%">
</div>


## ✨ 主な機能

- **🚫 自動透かし除去**：逆アルファブレンドアルゴリズム（Reverse Alpha Blending）を利用して、透かしで覆われたピクセルを正確に復元します。
- **🎨 カスタムロゴ置換**：独自のロゴ画像をアップロードして元の透かし位置に置き換えることができ、透明度（0%〜100%）とサイズ（10%〜200%）を調整可能です。
- **🔒 プライバシー優先**：すべての処理はローカルブラウザで行われ、画像がデバイス外に送信されることはありません。
- **⚡ リアルタイムプレビュー**：アップロードと同時に処理され、素早く結果を確認できます。
- **🖱️ ドラッグ＆ドロップ対応**：画像をウィンドウに直接ドラッグして処理できます。
- **👀 比較モード**：処理後の画像を長押し（クリックしたまま）すると元の画像が表示され、除去効果を簡単に比較できます。
- **⚙️ スマート＆手動モード**：
  - **自動検出**：画像解像度に基づいて透かしのサイズを自動的に判断します。
  - **手動選択**：特殊な状況に対応するために、小（48px）または大（96px）モードを強制的に選択できます。
- **💾 高画質ダウンロード**：処理後の画像をPNG（可逆）またはJPEG（圧縮）形式でダウンロード。
- **🖥️ デスクトップアプリケーション**：オフラインで使用でき、パフォーマンスが向上したTauriネイティブデスクトップアプリを提供。
- **📋 クリップボード貼り付け**：スクリーンショットや画像の直接貼り付け (Ctrl+V) に対応。
- **📦 一括 ZIP ダウンロード**：複数の画像をダウンロードする際、自動的に ZIP ファイルにまとめます。
- **🌐 多言語対応**：英語、繁体字中国語、簡体字中国語、日本語、韓国語に対応。

## 🛠️ 技術的な仕組み

このプロジェクトは純粋なJavaScript（Canvas API）で実装されています。Gemini透かしのアルファマスクを事前に読み込み、各ピクセルの元の色値を計算して透かしの影響を「逆算」することで、ロスレスまたはほぼ痕跡のない除去効果を実現しています。

## 🚀 使い方

1. **Webページを開く**：ブラウザで直接 `index.html` を開きます。
2. **画像をアップロード**：アップロードエリアをクリックして画像を選択するか、JPG/PNG/WEBP画像を直接ドラッグします。
3. **結果を確認**：システムが自動的に処理し、結果を表示します。
4. **設定を調整**（必要な場合）：結果が良くない場合は、ドロップダウンメニューで「Force Small」または「Force Large」に切り替えてみてください。
5. **ダウンロード**：満足したら「Download」ボタンをクリックして画像を保存します。

## 📦 インストールと実行

このプロジェクトは静的Webページであり、複雑なバックエンド環境をインストールする必要はありません。

1. **プロジェクトをクローン**：
   ```bash
   git clone https://github.com/aflypenstudio/GeminiWatermarkRemove.git
   ```
2. **ディレクトリに移動**：
   ```bash
   cd GeminiWatermarkRemove
   ```
3. **実行**：
   `index.html` をブラウザで直接開いて使用できます。
   *注意：ブラウザのセキュリティポリシー（CORS）により、ローカルファイルを直接開くとマスク画像の読み込みに失敗する場合があります。Pythonなどを使用して簡易ローカルサーバーを実行することをお勧めします：*
   ```bash
   # Python 3
   python -m http.server 8000
   ```

   その後、ブラウザで `http://localhost:8000` にアクセスしてください。

## 🖥️ デスクトップアプリケーション (Tauri)

Web版に加えて、[Tauri](https://tauri.app/) で構築されたネイティブデスクトップアプリケーションも提供しています。

### 特徴
- **オフラインサポート**：インターネット接続なしで動作
- **ネイティブパフォーマンス**：ネイティブAPIによる高速なファイル処理
- **ブラウザ不要**：スタンドアロンアプリケーションとして実行

### ダウンロード
> 近日公開予定 - インストーラーは [Releases](https://github.com/kevintsai1202/GeminiWatermarkRemove/releases) ページをご確認ください。

### ソースからビルド
```bash
# 前提条件：Rust、Node.js
cargo install tauri-cli

# クローンしてビルド
git clone https://github.com/aflypenstudio/GeminiWatermarkRemove.git
cd GeminiWatermarkRemove
git checkout feature/tauri-app

# 開発モード
cargo tauri dev

# インストーラーをビルド
cargo tauri build
```
出力場所：`src-tauri/target/release/bundle/`


## 🙏 謝辞 (Acknowledgements)

このプロジェクトに貴重な情報とインスピレーションを与えてくれた [GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) に深く感謝します。

## 📄 ライセンス (License)

このプロジェクトは MIT ライセンスの下でライセンスされています。詳細は [LICENSE](LICENSE) ファイルを参照してください。

