# 发布与市场收录

当前版本为 `0.1.1-beta.1`。公开仓库身份未确定时，发布检查会阻止正式发布。

## 验证

```sh
npm test
node scripts/check-release.mjs --draft
node scripts/pack.mjs
node scripts/verify-host.mjs /path/to/dsh/resources/app
node scripts/verify-modern.mjs
node scripts/verify-install.mjs /path/to/dsh/resources/app
```

安装验收使用项目内独立的 DSH_HOME，默认离线；缺少依赖缓存时使用 `--online`。`verify-modern.mjs` 需要预先准备对应版本的 `.compat` 测试依赖。

可选真实 API 冒烟测试为 `node scripts/verify-sjtu-api.mjs`，仅从环境变量 `SJTU_API_KEY` 读取密钥，发送一个固定的短生成请求，不保存密钥或原始错误正文。此测试脚本不会放入插件安装包，实际插件不自行联网。

GitHub CI 配置了 Windows/macOS/Linux × Node 22/24；推送后才会实际运行，不能把“配置了 CI”当成“所有平台已验证”。

## 仓库身份

确定真实的 `GitHub账号/仓库` 后执行：

```sh
node scripts/prepare-release.mjs owner/dsh-sjtu-quota
node scripts/check-release.mjs
node scripts/pack.mjs
```

该脚本只修改本地发布元数据并生成市场 YAML，不会创建账号、推送或提交 PR。公开仓库包含源码、测试、README、许可证和工作流；不要上传 `.test-state`、`.compat`、`node_modules`、`.env`、账本或用户配置。添加 `dsh-plugin`、`deepseek-harness` 和 `dsh` topics。首版建议 GitHub Release 分发 Beta 包，npm 发布可选。

## 主目录提交

DSH Market（dshmarket）使用的目录是：

https://github.com/awesome-dsh-plugin/awesome-dsh-plugin

按当前规则提交一个 `data/plugins/<owner>__<repo>.yml` 文件；生成的本地文件位于 `release/`。不要手改目录仓库生成的 README，也不要向市场应用仓库提交条目。

仓库必须公开、创建满一天、包含真实可安装代码、声明 `dsh.bundle`、附 `cordis.patch.yml`、添加 `dsh-plugin` topic。描述只能写已验证的功能。CI 通过后仍需维护者审阅，不能承诺收录时间或结果。

规则：

- https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
- https://github.com/dsh-market/dsh-market/blob/main/README.zh.md

其他社区目录另有流程，不应混为统一的官方审核：

- https://github.com/2BingLing/dsh-market/blob/master/CONTRIBUTING.md
- https://github.com/bradeGithub/DSH-Plugins-Marketplace/blob/main/STANDARD.md
