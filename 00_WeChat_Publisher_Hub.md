# 📡 Obsidian WeChat Publisher 项目控制台 (Project Hub)

> **项目定位**：专为法律人与自媒体创作者研发的本地微信排版与公众号草稿箱一键直连同步插件。
> **主开发者**：铭泽律师 (Maxwell)
> **开源许可**：MIT License (公益免费开源)

---

## 🛠️ 项目资产看板 (Project Assets)

*   **当前稳定版本**：`v1.1.0` (2026-06-02)
*   **本地插件目录**：[[.obsidian/plugins/obsidian-wechat-publisher/|Live Plugin Folder]]
*   **本地源码目录**：[[01_Projects/App_WeChat_Publisher/|Project Source Directory]]
*   **GitHub 仓库**：[Maxwell-zhu214/obsidian-wechat-publisher](https://github.com/Maxwell-zhu214/obsidian-wechat-publisher)

---

## 📝 核心管理文档 (Management Docs)

*   📖 **项目自述与用户手册**：[[01_Projects/App_WeChat_Publisher/README.md|README.md]]  
    *包含功能优势、隐私安全说明、手动安装说明、二维码引流配置。*
*   📅 **版本迭代与开发日志**：[[01_Projects/App_WeChat_Publisher/Dev_Log.md|Dev_Log.md]]  
    *包含 v1.0.0 到 v1.1.0 的重大版本更新记录以及未来开发规划路线图 (Roadmap)。*

---

## 🔒 隐私安全与配置规范

1. **密钥存放**：敏感凭证（AppID / AppSecret）绝不能进入本项目目录，其物理路径仅限在本地 Vault 的 `.obsidian/plugins/obsidian-wechat-publisher/data.json` 文件内，外部不可读。
2. **Git 提交保护**：根目录下的 `.gitignore` 已经配置完毕，防止本地敏感配置及调试日志外泄。
3. **开源签名**：请确保所有向外分发的 `main.js` 头部保留作者铭泽律师的版权署名。
