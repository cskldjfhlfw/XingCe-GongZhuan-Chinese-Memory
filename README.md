# 拾忆：公考学习辅助工具

拾忆是一款面向公务员考试复习的浏览器端学习工具。它把每天要背的内容、错题、词语积累和专注训练放在同一个地方，减少重复整理，把时间留给真正的学习。

在线体验：[yeen666.cn:17843](http://yeen666.cn:17843/)

> 体验站使用 HTTP，仅建议试用。正式录入学习资料前请阅读下方的“数据与隐私”。

## 快速使用

已安装 Node.js 20+ 时，可以直接在终端运行：

```bash
npx shiyi-browser-study-assistant
```

看到“拾忆已启动”后，打开 `http://127.0.0.1:8765`。如需指定端口，在命令后添加端口号：

```bash
npx shiyi-browser-study-assistant 17843
```

首次使用建议先添加一条记忆内容，熟悉复习日历和今日待办；需要 AI 整理时，再到“AI 整理台”填写自己的 DeepSeek API Key。

## 能做什么

1. **记忆与复习提醒**：录入当天背诵内容，根据预设复习节点生成待办，并在日历中查看复习安排。
2. **番茄钟**：记录专注时长和完成次数，帮助安排学习与休息。
3. **AI 错题整理**：导入 DOCX、PDF、图片或文本，由 AI 识别试卷、题型、题目和复盘笔记；识别结果可先审核、修改，再批量写入错题库。
4. **工作记忆训练**：包含 N-Back、舒尔特方格和序列相加，可选择难度并查看历史与近期成绩。
5. **成语词语积累**：独立保存释义、辨析、例句和掌握状态，也可以从导入资料中提取候选词语。
6. **常识与政治理论**：从学习资料中提取知识点，经人工审核后进入独立知识库。
7. **花生 800 词**：通过语义分类、知识图谱和词簇故事建立联想；可调用 LLM 补全释义、例句、辨析和记忆线索。
8. **词语记忆卡片**：在花生 800 词中先主动回忆、再揭示答案，并以“忘记 / 模糊 / 记得 / 熟练”记录掌握情况和安排后续复习。

## 数据与隐私

拾忆没有业务后端，学习数据保存在当前浏览器的 IndexedDB 中。服务器只提供静态页面，不保存你的题目、复习记录或 DeepSeek API Key。

- 不同浏览器、设备、域名、协议和端口拥有不同的浏览器存储，数据不会自动同步。
- 清除站点数据、重装浏览器或更换访问地址前，请先使用左下角“全局备份”导出 JSON；各模块仍可单独备份。
- 全局备份覆盖记忆、成语词语、错题、常识政治、AI 审核队列与用量、训练、番茄钟、直播课、词语图谱和花生 800 词，不包含 DeepSeek API Key。
- 导入备份前建议再次导出当前数据；“覆盖导入”会替换对应模块的数据。
- AI 功能是可选的。API Key 只需填写一次，保存在当前浏览器；请求由浏览器直接发送到 DeepSeek。
- HTTP 页面无法提供完整的传输安全保证。不要在不可信网络中输入 API Key，长期使用建议配置 HTTPS。
- AI 识别和生成可能出错，重要内容请在审核台确认后再保存。

## 本地运行

需要 Node.js 20+ 和 npm：

```bash
git clone https://github.com/cskldjfhlfw/XingCe-GongZhuan-Chinese-Memory.git
cd XingCe-GongZhuan-Chinese-Memory
npm install
npm start
```

然后打开 `http://127.0.0.1:8765`。首次运行 AI 功能时，在“AI 整理台”的设置中填写自己的 DeepSeek API Key。

通过 npm 或源码启动的都是本地静态应用。每个访问地址使用各自独立的浏览器数据，不会自动同步到其他设备。

## 项目结构

项目采用轻量 Monorepo 结构。当前只有一个静态前端应用，同时把部署、测试和发布工具保留为清晰的独立边界，方便以后增加新的应用或共享包。

```text
apps/web/              @shiyi/web 浏览器端 workspace
deployment/docker/     Nginx 与 Docker 部署配置
scripts/               发布构建脚本
tests/                 单元测试与端到端测试
.github/workflows/     GitHub Actions CI、部署与 npm 发布
```

前端使用原生 HTML、CSS 和 JavaScript，数据由 IndexedDB 持久化；PDF.js 和 Mammoth.js 负责文档解析，Cytoscape.js、fCoSE、Graphology 与 Louvain 用于知识图谱和语义聚类。

## 测试

首次运行浏览器测试前安装 Chromium：

```bash
npx playwright install chromium
npm test
```

只执行发布前的语法、单元测试和包内容检查：

```bash
npm run prepublishOnly
```

## 自行部署

这个 npm 包提供可直接运行或部署的静态应用，不是用于 `import` 的 JavaScript SDK。Docker/Nginx 部署步骤见 [deployment/README.md](deployment/README.md)。部署到已有 Nginx 时，应使用独立端口或新增反向代理规则，避免影响服务器上的其他站点。

`main` 分支通过全部测试后会自动部署体验站；推送与 `package.json` 版本一致的 `v*.*.*` 标签会触发 npm 发布。维护者配置说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

首次 npm 发布、Trusted Publisher、GitHub Actions 和阿里云原子部署的完整操作记录及流程图见 [npm 发布与 CI/CD 配置记录](docs/PUBLISHING_AND_DEPLOYMENT.md)。

## 参与项目

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；发现安全问题请按 [SECURITY.md](SECURITY.md) 中的方式处理，不要把 API Key、个人错题或浏览器备份提交到仓库。

## 开源许可

本项目采用 [GNU GPL v3](LICENSE)。发布修改版本时，需要继续以 GPL v3 开源并提供相应源代码。`apps/web/src/vendor/` 中的第三方组件仍遵循各自附带的许可证。
