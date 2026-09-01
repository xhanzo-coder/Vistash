## 1. 许可证与包元数据

- [x] 1.1 在仓库根目录加入标准 MIT `LICENSE`，使用项目所有者确认的著作权标识，不添加自定义使用限制
- [x] 1.2 在 `README.md`、`app/package.json`、Cargo workspace 和两个成员 crate manifest 中声明 `MIT` SPDX 标识，并明确第三方依赖/资产不被根许可证覆盖

## 2. 社区贡献与安全入口

- [ ] 2.1 新增 `.github/CONTRIBUTING.md`，说明仓库与 `app/` 工作目录、OpenSpec、串行门禁、中文文档、截图/资产来源和 PR 流程
- [ ] 2.2 新增 `.github/SECURITY.md`，提供 GitHub 私下安全报告入口、受支持版本和不公开漏洞细节的要求
- [ ] 2.3 新增缺陷/功能 Issue 模板与 `PULL_REQUEST_TEMPLATE.md`，收集 Windows 版本、安装器、复现步骤、测试和敏感信息脱敏确认

## 3. README 产品展示

- [ ] 3.1 从匿名生产验收证据中精选欢迎页、图片工作区、提示词工作区和多图关联截图，复制到 `docs/assets/screenshots/`，并复制产品图标到 `docs/assets/`
- [ ] 3.2 更新 README 顶部产品图标、界面截图、中文 alt/说明、MIT 许可证链接、贡献/安全链接和截图匿名数据声明
- [ ] 3.3 复核 README 的安装、功能、路径、命令、Release/Issues 链接和当前不支持范围，不把测试原型或未来反推能力写成已实现功能

## 4. 公开路径与第三方归属治理

- [ ] 4.1 定向匿名化 `AGENTS.md`、OpenSpec 历史说明和公开诊断 JSON 中的个人媒体库路径、中央 Skill 绝对路径和 Windows 用户目录，保留通用测试根路径与审计语义
- [ ] 4.2 使用 pnpm/Cargo 许可证信息和实际自有资产清单完成第三方依赖、图标、字体、截图归属审计，记录是否需要 `NOTICE`/`THIRD_PARTY_NOTICES.md`，不创建空通知文件
- [ ] 4.3 检查 Git 历史中是否存在凭据或高敏感个人数据；若发现只记录风险并停止，不在本变更中擅自重写历史

## 5. GitHub 仓库规范化

- [ ] 5.1 更新 GitHub 仓库 description 与 topics，使公开仓库首页能说明 Vistash、Windows、Tauri、React、Rust、SQLite 和本地图片管理定位
- [ ] 5.2 评估并启用适合公开仓库的 secret scanning、push protection、Dependabot security updates 和 private vulnerability reporting，不改变不可变 tag ruleset

## 6. 验证、审查与归档

- [ ] 6.1 通过 UTF-8 无 BOM、绝对路径/凭据扫描、README/Markdown 链接、许可证元数据、截图隐私和 `git diff --check`
- [ ] 6.2 串行通过 `pnpm lint`、`pnpm typecheck`、`pnpm test`、Rust Clippy、Rust 测试和 `openspec validate --all --strict --no-interactive`
- [ ] 6.3 运行 Standards/Spec 双轴 code review，修复阻断项并记录结论
- [ ] 6.4 归档 `prepare-open-source-repository`，同步主规格，合并 PR，清理临时分支并确认最终只保留 `main`
