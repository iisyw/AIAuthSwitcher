# AIAuthSwitcher

AIAuthSwitcher 是一个 VS Code 扩展，用来查看、备份、导入、导出和切换本地 AI 工具授权文件。

当前版本仅支持 Codex，授权文件路径为 `~/.codex/auth.json`。

## 功能

- 展示当前 Codex 账号摘要
- 备份当前授权到扩展存储目录
- 恢复、删除和导出已保存备份
- 导入单账号 JSON 或多账号合集 JSON
- 通过侧边栏 `+` 入口登录并添加 Codex 账号
- 切换授权后提示重载 VS Code 窗口

## 使用

1. 在 VS Code 侧边栏打开 `AIAuthSwitcher`。
2. 查看当前账号信息，或使用“备份”区域管理已有授权。
3. 点击顶部 `+` 按钮，选择 `Codex`，输入邮箱、密码和验证码以添加账号。
4. 切换授权后按提示重载窗口。

授权备份存放在扩展的 VS Code 全局存储目录中。

## 注意事项

- 扩展会处理本地授权信息，请将导出的备份文件当作凭证保管。
- 扩展不会主动上传授权数据到远程服务。
- 如果目标扩展已经在内存中缓存授权，切换后仍需要重载窗口才会生效。

## 开发

```bash
npm install
npm run compile
npm run lint
```

本地打包 VSIX：

```bash
npx @vscode/vsce package --allow-missing-repository
```
