# PR 提交与 CI 核查

## 提交前

1. 确认实际工作目录、分支和远端。执行 `git status --short`、`git remote -v`、`git fetch origin main`，用 `git diff origin/main...HEAD` 检查本 PR 范围；本地未提交改动还要单独检查。工作区有改动时不要直接拉取覆盖。
2. 按 `.github/workflows/ci.yml` 和其他相关 workflow 选择检查。单元/组件测试、类型检查、格式、lint、生成文件、多语言完整性是不同检查，不能互相替代。重放到新基线后检查上游是否影响已验证路径。
3. 前端至少核对 CI 使用的格式与 lint 命令，以及当前变更相关测试和类型检查。Rust、Agent、发布文件按实际影响范围执行对应检查，不为无关路径增加发布关卡。
4. 新增简中词条时，先检查 `.github/scripts/i18n-autofill.mjs` 的 `TARGET_LOCALES`。补齐其要求的语言并保持 `{count}` 等占位符；不要把“英文可回退”当作自动翻译 CI 会成功的保证。

### 多语言的本地检查

在仓库根目录执行：

```sh
node .github/scripts/i18n-autofill.mjs --dry-run --base-ref origin/main
```

该脚本只检查相对基线新增的简中键，不负责历史缺口或已有文案修改的同步。当前要求 en、es、it、ja、ko、pt-BR、ru、zh-TW；以脚本实际配置为准。

注意：`--dry-run` 只保证不写文件，有缺口且配置 API key 时仍会请求翻译服务。离线预检应在未配置 `DEEPSEEK_API_KEY` 且未开启 `I18N_MOCK_TRANSLATIONS` 的环境执行。PowerShell 可临时清空这两个进程环境变量，检查后恢复原值，不打印密钥。

通过标准是每种目标语言都输出 `all new keys already present`，最后输出 `No locale files needed changes`；没有新增键时则输出 `No new ... i18n keys`。缺失 API key 的错误说明仍有翻译缺口，应补齐后再提交。`--mock-translations` 仅用于复现/诊断，不能作为翻译完整性通过依据，更不能将 mock 文案写入提交。

## 推送与远端核查

```sh
git push -u fork <branch>
gh pr checks <number> --repo t8y2/dbx
gh pr view <number> --repo t8y2/dbx --json headRefOid,state,mergeable,statusCheckRollup
gh run view <run-id> --repo t8y2/dbx --log-failed
```

- push 成功只代表远端分支收到提交。PR 已创建、无合并冲突、CI 通过、已合并和已发布是不同状态。
- 创建或更新 PR 后查看对应提交 SHA 的检查结果。排队/运行中写明待完成，不能将本地测试通过写成远端全绿。
- 失败时保存任务名、run/job 链接、提交 SHA 和首个实际错误。先判断是代码、格式、翻译缺口、权限、在线服务还是 runner 环境，不能只根据红叉推测。
- 修复本分支可解决的问题，运行对应检查再正常提交推送。不要靠不断 rerun 掩盖确定性缺口，也不要为了绿灯跳过检查或改无关 workflow。
- 后续机器人提交会改变 SHA，应先 fetch 核实再更新，避免覆盖机器人的改动。最终报告列出最新提交通过、失败和仍在运行的检查。
- GitHub CLI 的 `repo`/`workflow` 授权问题与代码 CI 失败分开处理；只检查 scope，不输出 token。

## #10231 的实际遗漏

2026-09-24，提交 `8ab182140` 新增 22 个耗时词条，仅补齐简中、繁中和英文。I18n Autofill 尝试自动补齐其他语言，在日语阶段收到空响应：

```text
DeepSeek API returned no translation content for ja
Process completed with exit code 1
```

[失败任务](https://github.com/t8y2/dbx/actions/runs/35973804399/job/107549411291)。这是翻译服务失败叠加提交前遗漏多语言检查；不是从该日志得出的数据库逻辑失败。修复直接补齐 es、it、ja、ko、pt-BR、ru 的 132 条翻译，使本 PR 不再需要在线补译。本地 dry-run 已确认所有目标语言完整，无文件需要修改。

此前“234 项前端测试、405 项 Java 测试通过”只证明这些测试的覆盖范围。它们没有覆盖在线补译。此后交付必须同时报告远端 CI 状态，不以测试数量代替检查覆盖。
