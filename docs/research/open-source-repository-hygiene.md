# Vistash 开源仓库文件与目录治理调研

日期：2026-09-01  
范围：公开 GitHub 仓库在什么条件下可以称为“开源”，以及 `LICENSE`、`README`、`CONTRIBUTING`、`CODE_OF_CONDUCT`、`SECURITY`、`NOTICE` 和 Vistash 的 Agent/OpenSpec 目录应如何处理。

> 本文是工程与仓库治理调研，不替代律师意见。许可证必须由实际著作权人作最终选择。文中的“当前仓库盘点”记录的是本次开源治理变更实施前的基线；实施后的文件状态和验收结果以对应 change 的 validation 记录为准。

## 结论摘要

1. **公开可见不等于开源。** GitHub 明确说明：没有许可证时适用默认著作权规则，其他人虽然可按 GitHub 服务条款查看和 fork 公开仓库，但通常没有复制、分发或创作衍生作品的许可；要让仓库真正成为开源项目，需要授予使用、修改和分发权利的许可证。[GitHub：Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
2. **Vistash 在本次变更实施前不能准确宣称“开源”。** 基线仓库没有 `LICENSE`，GitHub License API 也未检测到许可证；当前 README 的旧表述“公开可见不等同于已经授予开源、再分发或商用许可”只描述基线状态。实施标准 MIT 后，README 与 GitHub License 检测应同步更新。
3. **能够称为开源的核心条件是许可证，而不是文件数量。** OSI 强调开源不只是能够看到源代码，许可条款还必须允许自由再分发、源代码获取、修改和衍生作品，并且不得歧视个人、群体或使用领域。[OSI：The Open Source Definition](https://opensource.org/osd)；[OSI Approved Licenses](https://opensource.org/licenses)
4. `README`、`CONTRIBUTING`、`CODE_OF_CONDUCT` 和 `SECURITY` 会显著改善使用、贡献和安全报告体验，但它们不是“开源”这一法律许可状态的替代品。GitHub 将前四类中的 README、行为准则、许可证和贡献指南列为推荐的 community health files。[GitHub：About community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)
5. `NOTICE` **不是所有开源项目的必需文件**。它是否需要存在取决于所选许可证、上游组件的通知义务和实际分发内容；不能为了“看起来完整”而生成空 NOTICE，也不能用 NOTICE 替代 LICENSE。
6. `.agents/`、`.claude/` 和 `openspec/` 与开源资格无直接关系。Vistash 已把它们定义为开发流程和规格事实来源，**不应为了仓库看起来简洁而整体删除**。本机 junction 和外部 Skill 则应继续忽略，不应提交。

## 一、各文件的必要性

| 文件 | 是否为称作开源的必要条件 | Vistash 当前状态 | 建议 |
| --- | --- | --- | --- |
| `LICENSE` | **是，实质必要** | 缺失；GitHub 未检测到许可证 | 由著作权人选择 OSI 批准的许可证，在仓库根目录加入未经随意改写的标准全文 |
| `README.md` | 否，但对可用性几乎必需 | 已有，且覆盖定位、安装、隐私、边界、反馈 | 保留；选定许可证后更新“许可证”章节并链接根 `LICENSE` |
| `CONTRIBUTING.md` | 否；公开接受贡献时强烈建议 | 缺失 | 新增，写清 OpenSpec 流程、工作目录、门禁、PR 规则、语言与测试要求 |
| `CODE_OF_CONDUCT.md` | 否；形成公开社区时建议 | 缺失 | 只有维护者愿意并能够执行时采用；使用公认模板并提供真实可用的事件报告渠道 |
| `SECURITY.md` | 否；发布可执行文件的项目强烈建议 | 缺失 | 优先新增，说明受支持版本、私下报告漏洞的方法、响应预期；安全问题不要要求提交公开 Issue |
| `NOTICE` | 条件性 | 缺失 | 先确定项目许可证并完成依赖/素材归属审计；只有存在通知义务时创建 |

GitHub 会自动展示位于 `.github/`、仓库根目录或 `docs/` 的 README；存在多份时优先级为 `.github`、根目录、`docs`。Vistash 继续使用当前根 `README.md` 最清晰。[GitHub：About the repository README file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)

GitHub 支持把 `CONTRIBUTING` 放在 `.github/`、根目录或 `docs/`，并会在创建 Issue/PR 时主动显示入口；若存在多份，优先级同样是 `.github`、根目录、`docs`。[GitHub：Setting guidelines for repository contributors](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors)

GitHub 支持把 `CODE_OF_CONDUCT` 放在 `.github/`、根目录或 `docs/`。官方同时提醒：采用前应确认维护者愿意且有能力执行它；从别处采用时要遵守原模板的署名要求。[GitHub：Adding a code of conduct](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-code-of-conduct-to-your-project)

`SECURITY.md` 应至少列出受支持版本和漏洞报告方式；GitHub 会在 Security 页面展示安全政策，也支持为公共仓库启用 private vulnerability reporting。[GitHub：Adding a security policy](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/add-security-policy)；[GitHub：Configure vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting)

## 二、LICENSE 的选择与落地

### 2.1 不应自行发明“开源但禁止某些用途”的许可证

OSI 的定义禁止按个人、群体或使用领域进行歧视。因此，“禁止商用”“禁止 AI 使用”“仅限个人学习”等限制通常使许可证不再符合 OSI 的开放源代码定义。若 Vistash 希望保留这些限制，应准确称为 source-available，而不是开源。[OSI：The Open Source Definition，第 5、6 条](https://opensource.org/osd)

稳妥做法是从 [OSI 批准许可证列表](https://opensource.org/licenses) 选择标准许可证，并使用 [SPDX License List](https://spdx.org/licenses/) 的精确标识符。SPDX 为许可证提供标准短 ID、标准文本和永久链接，也支持 `AND`、`OR`、`WITH` 表达式。[SPDX：Handling License Info](https://spdx.dev/learn/handling-license-info/)

### 2.2 适合进一步决策的候选方向

| 目标 | 可评估的标准许可证 | 关键取舍 |
| --- | --- | --- |
| 尽量宽松、文本简短 | `MIT` | 主要要求保留版权和许可证通知；没有 Apache-2.0 那样展开的专利授权条款 |
| 宽松复用，同时希望有明确专利授权 | `Apache-2.0` | 要保留许可证/版权通知并标注修改；包含明确专利授权与终止条款 |
| 希望对 Vistash 文件本身的修改保持开源，但允许与其他许可证代码组合 | `MPL-2.0` | 文件级 copyleft，合规复杂度高于 MIT/Apache-2.0 |
| 希望分发的衍生整体继续保持同许可证开源 | `GPL-3.0-only` 或 `GPL-3.0-or-later` | 强 copyleft；对二次分发和组合工程影响最大 |

候选的权限与条件可从 GitHub 维护的 [Choose a License：许可证列表](https://choosealicense.com/licenses/) 比较；最终应结合商业化、插件生态、贡献者专利和衍生作品策略决定，而不是由自动化工具替著作权人选择。

### 2.3 推荐落地方式

1. 在仓库根目录添加单一、标准、完整的 `LICENSE` 文本。GitHub 建议把许可证放在根目录，且其 Licensee 检测器更容易识别未被混入自定义条件的标准文本。[GitHub：许可证位置与检测](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository#determining-the-location-of-your-license)
2. 在 `README.md` 的许可证章节写明 SPDX ID，并链接 `LICENSE`。不要在 README 追加会改变标准许可证权利的限制。
3. 在 `app/package.json` 和 Cargo workspace/成员包中补一致的机器可读许可证元数据。Cargo 的 `license` 字段使用 SPDX 表达式；若使用非标准许可证才改用 `license-file`，二者不能混用。[Cargo Book：The license and license-file fields](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields)
4. 若整个仓库并非同一许可证（例如代码与文档/图像资产不同），应明确每一范围，使用 `LICENSES/`、SPDX 文件头或清楚的目录级说明；不能让根 LICENSE 模糊覆盖无权授权的第三方内容。SPDX 文件头可以逐步采用，不必为了首个 LICENSE 一次性机械修改所有源码。[SPDX：SPDX License IDs](https://spdx.dev/learn/handling-license-info/#spdx-license-ids)
5. 检查 Windows 安装器和源码归档是否带上适用的许可证与第三方通知；“GitHub 仓库有 LICENSE”不自动证明安装包已经满足所有再分发义务。

**重要区分：** Authenticode 证明 Windows 安装包的发布者身份和完整性；开源许可证授予使用、修改和分发代码的法律权利。Vistash 当前“未签名公开预览”的状态不阻止采用开源许可证，反之加入 LICENSE 也不会让安装包获得 Windows 信任签名。

## 三、NOTICE 什么时候需要

`NOTICE` 的义务必须从实际许可证文本判断。以 Apache-2.0 为例：若所分发的上游作品包含 NOTICE，分发其衍生作品时必须以许可证允许的方式保留相关署名通知；Apache 官方同时建议在应用 Apache-2.0 时随作品包含 LICENSE，并考虑加入 NOTICE。[Apache License 2.0，第 4(d) 条](https://www.apache.org/licenses/LICENSE-2.0.html)

因此 Vistash 当前应采取以下顺序：

1. 先选定 Vistash 自身许可证；
2. 盘点实际打进 NSIS/MSI 的 Rust、npm、Tauri/WebView2 组件、字体、图标和图像资产；
3. 识别必须随二进制保留的许可证全文、版权声明或 NOTICE；
4. 有实际通知内容时再创建根 `NOTICE` 或 `THIRD_PARTY_NOTICES.md`，并确保安装包内也能取得它。

不要创建内容为“本项目使用若干开源依赖”的空泛 NOTICE；它既不能满足具体上游义务，也可能让使用者误以为第三方合规已经完成。

## 四、Vistash 当前仓库盘点

本次只读检查得到：

- 仓库为 public，默认分支为 `main`；根 `README.md` 已存在。
- 未找到 `LICENSE*`/`COPYING*`、`CONTRIBUTING*`、`CODE_OF_CONDUCT*`、`SECURITY*`、`NOTICE*`。
- `.github/` 当前只有 `ci.yml` 和 `release.yml`，没有 Issue/PR 模板。
- `app/package.json`、Cargo workspace 和两个 Rust package 未声明项目许可证元数据。
- GitHub community profile API 当前为 **14%**，只识别到 README；license、contributing、code of conduct、issue template 和 pull request template 均为空。该百分比是 GitHub 的社区文件清单，不是法律上的“开源程度”。API 字段含义见 [GitHub REST：Get community profile metrics](https://docs.github.com/en/rest/metrics/community#get-community-profile-metrics)。
- GitHub 仓库设置显示 secret scanning、push protection 和 Dependabot security updates 当前关闭。它们不是开源必要条件，但公开分发 Windows 可执行文件后，建议评估开启。
- 当前 README 第 151—153 行明确说明没有 LICENSE，因而没有授予开源、再分发或商用许可；加入许可证时必须同步改写，避免自相矛盾。

### 建议优先级

**P0：在宣称开源前完成**

1. 由著作权人选择 OSI 批准许可证；确认现有代码、文档、图标、截图和生成文件均有权按该许可证发布。
2. 添加根 `LICENSE`，更新 README 和 package/Cargo SPDX 元数据。
3. 复核 GitHub 能正确检测许可证，并验证源码归档与安装器的许可证/第三方通知边界。

**P1：公开接受使用与漏洞反馈前尽快完成**

1. 添加 `.github/SECURITY.md`，并启用 private vulnerability reporting；视风险开启 secret scanning、push protection 和 Dependabot。
2. 添加 `.github/CONTRIBUTING.md`，把当前实际的 OpenSpec、两工作目录、串行门禁、简体中文规范和 PR 流程压缩成外部贡献者可执行的说明。
3. 添加 Issue templates 与 PR template，分别收集 Windows 版本、安装器格式、复现步骤、日志脱敏和验收证据。

**P2：开始经营公开贡献社区时完成**

1. 在能够执行的前提下采用 `.github/CODE_OF_CONDUCT.md`，明确事件报告和处理责任人。
2. 视支持渠道复杂度决定是否增加 `.github/SUPPORT.md`。GitHub 会在新建 Issue 时展示 SUPPORT 入口。[GitHub：Adding support resources](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-support-resources-to-your-project)
3. 根据第三方归属审计结果决定 NOTICE/THIRD_PARTY_NOTICES，而不是把它当固定模板文件。

## 五、`.agents`、`.claude`、`.codex` 与 `openspec` 的取舍

| 路径 | 当前事实 | 建议 |
| --- | --- | --- |
| `.agents/skills/openspec-*` | 4 个项目自有、已跟踪的 OpenSpec Skill | **保留。** 它们是当前仓库工作流的一部分；选择项目许可证时要确认这些生成内容的授权来源和适用范围 |
| `.agents/skills/*` 的其他入口 | 来自外部中央库，已由 `.gitignore` 排除 | **不要提交复制件或 junction。** 保持忽略，通过安装/链接步骤让贡献者自行取得 |
| `.claude/commands/opsx/` | 4 个已跟踪的项目命令 | 如果继续支持 Claude/OpenSpec 工作流则**保留**；它们不是运行时依赖，也不是开源必需文件 |
| `.claude/skills`、`.codex/skills` | 指向 `.agents/skills` 的本机 Windows junction，已忽略 | **不要提交。** 本机可保留供开发使用；公开仓库应提供可复现的 bootstrap，而不是依赖某台机器的绝对 junction |
| `AGENTS.md`、`CLAUDE.md` | 定义代理开发规则、Skill 顺序和 OpenSpec 入口 | **保留并做可移植性清理。** 对使用 Agent 的贡献者有价值；不使用 Agent 的贡献者也不受其影响 |
| `openspec/` | 118 个已跟踪文件，是已批准需求、设计、任务和归档历史的事实来源 | **保留，不要整体删除或只保留最终代码。** 删除会破坏项目规定的变更追溯、strict validate 和后续规格同步 |

GitHub/OSI 不要求上述目录存在，也不会因它们存在而降低“开源程度”。判断标准应是：它们是否属于项目的 preferred form for modification、是否帮助贡献者复现决策、是否包含可公开的信息，而不是目录名是否看起来“像 AI”。

### 需要定向清理，而不是整目录删除

当前跟踪内容中存在本机绝对路径和历史环境证据，例如：

- `AGENTS.md` 中的中央 Skill 绝对路径；
- OpenSpec archive 中的 `E:\vistash-release-e2e\...`、个人媒体库路径和历史测试路径；
- `app/artifacts/merge-blockers/native-report.json` 中含 Windows 用户目录名。

这些内容不等同于密钥，但会暴露机器/用户名信息并降低外部贡献者可复现性。建议在独立、审计过的文档治理变更中：

1. 把仍在执行的说明改为环境变量或仓库相对路径；
2. 对历史验证只保留复现所需的匿名路径，不批量删除整个 OpenSpec archive；
3. 对真正的凭据或高度敏感个人信息，注意仅从当前分支删除并不会从 Git 历史消失，需单独评估历史清理和凭据轮换；
4. 测试代码中明显虚构的 `E:\素材` 一类 fixture 可保留，它们用于验证 Windows 路径语义，不属于个人数据。

## 六、建议的最小文件布局

在许可证决策完成后，推荐布局如下：

```text
LICENSE                         # 标准许可证全文；开源法律基础
README.md                       # 用户入口与许可证摘要
.github/
  CONTRIBUTING.md              # 贡献流程
  CODE_OF_CONDUCT.md           # 社区行为规则（确认可执行后添加）
  SECURITY.md                  # 受支持版本与私下漏洞报告
  ISSUE_TEMPLATE/              # 缺陷/功能请求表单
  PULL_REQUEST_TEMPLATE.md     # PR 验收清单
  workflows/                   # 现有 CI 与发布工作流
NOTICE 或 THIRD_PARTY_NOTICES.md # 仅在实际通知义务存在时
.agents/                       # 项目自有 Agent/OpenSpec 工作流，保留
.claude/commands/              # 项目自有命令，保留
openspec/                      # 规格事实与变更历史，保留
```

建议避免在根目录、`.github/` 和 `docs/` 各放一份同名社区文件。GitHub 对多份文件存在位置优先级，重复副本容易漂移；选择一个权威位置并从 README 链接即可。[GitHub：Default community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)

## 七、验收清单

- [ ] 著作权人已明确选择许可证及适用范围；许可证位于 OSI 批准列表，SPDX ID 精确。
- [ ] 根 `LICENSE` 是标准全文，README 与 Cargo/package 元数据一致。
- [ ] README 不再写“未授予开源许可”，且未加入与许可证冲突的额外限制。
- [ ] GitHub 仓库页和 Licenses API 能识别预期许可证。
- [ ] 安装器和源码归档包含所需许可证/第三方通知；NOTICE 决策有依赖审计依据。
- [ ] `SECURITY.md` 提供私下报告渠道并标明受支持版本。
- [ ] `CONTRIBUTING.md` 能让外部贡献者执行真实 OpenSpec 与测试门禁。
- [ ] 行为准则包含可执行的联系人与处理流程，而不是未维护的模板。
- [ ] `.agents`、`.claude`、`openspec` 保留；junction、外部 Skill、本机产物和凭据继续忽略。
- [ ] 已审计绝对路径、用户名、截图、日志和历史产物；敏感信息按 Git 历史风险处理。

## 主要一手资料

- [GitHub Docs：Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
- [GitHub Docs：About community profiles for public repositories](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)
- [GitHub Docs：About the repository README file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [GitHub Docs：Setting guidelines for repository contributors](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors)
- [GitHub Docs：Adding a code of conduct](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-code-of-conduct-to-your-project)
- [GitHub Docs：Adding a security policy](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/add-security-policy)
- [GitHub REST：Community profile metrics](https://docs.github.com/en/rest/metrics/community#get-community-profile-metrics)
- [OSI：The Open Source Definition](https://opensource.org/osd)
- [OSI：Approved Licenses](https://opensource.org/licenses)
- [SPDX：Handling License Info](https://spdx.dev/learn/handling-license-info/)
- [Cargo Book：Manifest license fields](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields)
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.html)
