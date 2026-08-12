# 参与贡献

感谢你愿意改进拾忆。提交代码前，请先通过 Issue 描述问题或需求；修复明确的小问题可以直接提交 Pull Request。

## 开发流程

1. Fork 仓库并从 `main` 创建功能分支。
2. 运行 `npm install` 安装开发依赖。
3. 保持修改范围清晰，并为行为变化补充相应测试。
4. 运行 `npx playwright install chromium` 和 `npm test`。
5. 提交 Pull Request，说明修改内容、验证方式和可能影响的数据兼容性。

请勿提交 API Key、浏览器导出的学习数据、个人错题、服务器地址、`.env` 文件、构建产物或 `node_modules`。涉及备份格式或 IndexedDB 结构的修改，应保持旧数据可导入，或在 Pull Request 中明确迁移办法。

参与本项目即表示你同意所提交的内容按 GNU GPL v3 许可发布。

## 维护者发布

正式版本发布前应确认工作区内容、版本号、npm 登录账号和包内容：

```bash
npm test
npm run pack:check
npm whoami
npm publish
```

npm 已发布的版本不能覆盖。后续发布请先按语义化版本更新版本号，例如修复版本使用 `npm version patch`，再同步提交版本变更和 Git tag。

仓库使用 GitHub Actions：Pull Request 和 `main` 推送运行 CI，CI 通过后部署体验站；版本标签触发 npm Trusted Publishing。服务器部署密钥只保存在 GitHub Environment Secrets 中，不应写入源码或提交历史。
