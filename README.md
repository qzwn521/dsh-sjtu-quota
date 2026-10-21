# DSH SJTU Quota

上交 API 的 DSH 请求排队与限流恢复插件。分钟额度不足时等待，临时 429 后自动恢复当前模型步骤。

[English](README.en.md) · [发布流程](docs/PUBLISHING.md) · [数据处理](SECURITY.md)

**当前为 `0.1.1-beta.1` 测试版，尚未被市场收录。** 不保证完全避免 429、恢复所有故障或读取学校真实余额。

## 功能

- 上交预设：300,000 Token/min、10 请求/min、本地七天 1,000,000,000 Token 预算。
- 按 `models.sjtu.edu.cn` 精确识别路由，也可手动指定路由和预算；选中路由共享额度。
- 请求前预留预计输入和输出上限，返回后用真实 `usage` 修正；缓存与推理不重复计数。
- 临时 429 优先采用服务端相对等待时间，其次合理的重置时间，否则等待 61 秒；原生模型步骤恢复没有默认五次上限。
- `/sjtu-quota` 显示受保护路由、分钟已用/预留、请求数、排队、冷却和本地统计。
- 等待可取消，统计跨重启保存；仅本地记账，不保存 API Key 或聊天正文。

## 安装

```sh
dsh plugin --profile web add github:qzwn521/dsh-sjtu-quota
```

Desktop 用户将 `web` 换为当前 `desktop` profile。发布前可安装本地 `.tgz` 包测试，也可从项目目录执行 `dsh plugin --profile desktop add .`。启用后运行 `/sjtu-quota`，先确认受保护路由正确。

卸载：

```sh
dsh plugin --profile web remove dsh-sjtu-quota
```

## 配置

新版 DSH 使用插件的原生 Config 设置表单，旧版使用 `sjtu-quota` 设置命名空间。profile patch 示例：

```yaml
- id: sjtu-quota
  config:
    enabled: true
    autoDetect: true
    endpointHosts: [models.sjtu.edu.cn]
    providers: []
    tokensPerMinute: 300000
    requestsPerMinute: 10
    weeklyTokens: 1000000000
    safetyRatio: 0.9
    maxConcurrent: 1
    estimateMultiplier: 1.15
    fallbackOutputTokens: 8192
    fallbackWaitMs: 61000
```

`providers` 填路由 ID，不是模型名称。非空时仅保护手动指定的路由；为空时按接口域名识别，不要求路由叫 `sjtu`，也不匹配域名后缀相似的其他站点。

`safetyRatio: 0.9` 将调度预算设为 270,000 Token，留出估算余量；调为 1 使用完整额度。`fallbackOutputTokens` 只用于请求未指定 `maxTokens` 时的预留，不会修改真实输出上限。

默认账本为 `DSH_HOME/storages/sjtu-quota/ledger.json`，未设置 DSH_HOME 时使用用户目录下的 `.dsh`。`stateFile` 可指定绝对路径，修改后重启插件。卸载会保留账本。

## 边界

- 请求前是估算，真实用量通常在请求返回后确认，不能保证完全不出现 429。
- 分钟统计包括进行中请求的预留；完成用量在本地保留一分钟，采用保守调度。
- 七天统计只覆盖本插件运行后的所选路由，不含其他程序、电脑和安装前用量，**不是学校账号真实周余额**。旧记录按小时合并，过期最多延后约一小时。
- 缺少 usage 或调用被中断时保留预估。单次请求超过预算，需要压缩上下文或调整输出上限，等待无法解决。
- 周额度、认证或余额耗尽等终态问题不会按临时分钟限流无限重试。
- 只覆盖官方 `llm/stream` 调用，自动恢复针对原生 agent 请求错误接口；直接发 HTTP 的第三方插件不在范围内。
- 一份账本仅允许一个 Host 持有；尚无多电脑协调或多 Key 独立分组。

## 兼容与验证

支持已验证的 Harness `0.1.5-rc.2`、`0.2.0-rc.2`。不使用宽泛版本范围掩盖未验证版本。

- Windows/Node 24 的 23 项自动测试已通过，包括发布包可复现、排除密钥与测试数据、缺少仓库身份时阻止发布。
- 已使用两个版本的真实 Cordis、LLM、Settings 和重试事件校验模块进行隔离验证，模型服务使用模拟适配器。
- 覆盖连续六次 429 后成功、插件加载/卸载、旧设置与新版 Config 表单更新。
- GitHub CI 已配置三种系统、Node 22/24，推送后才会实际运行。
- 已在独立 DSH_HOME 中通过真实 CLI 安装、配置合成与卸载验证，不修改已有用户配置。
- 真实上交 API 冒烟测试已通过：Qwen 单次固定测试输入共 22 Token，返回正文和用量。未主动制造线上 429；长期真实训练任务中的稳定性仍需 Beta 验收。

```sh
npm test
node scripts/check-release.mjs --draft
node scripts/pack.mjs
```

## 许可

MIT。社区第三方项目，与上海交通大学、DeepSeek 或插件市场无隶属或背书关系。
