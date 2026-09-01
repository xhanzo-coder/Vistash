## 1. 新用户 README

- [x] 1.1 编写根目录 `README.md`，覆盖产品定位、适用人群、图片库与提示词库、图片—提示词多图关联、安装入口、首次使用、本地数据与隐私、明确不支持范围、开发命令和反馈入口
- [x] 1.2 对照当前主规格、`v0.1.1` Release 资产和实际界面复核 README，删除未实现承诺，确认链接、命令、版本号和 UTF-8 无 BOM

## 2. 公开发布说明

- [x] 2.1 更新 `docs/releasing.md`，补充公开预览版的草稿转公开步骤、资产/哈希复核、未签名 SmartScreen 警告、正式签名前置条件和失败撤回策略
- [ ] 2.2 在当前 change 的 validation 记录中保存公开前检查结果、tag 指向、三个资产摘要、README 检查和签名边界

## 3. 公开 v0.1.1 预览

- [ ] 3.1 在清洁 `main` 和已合并文档变更上串行通过 OpenSpec strict、版本发布契约及现有前端/Rust 门禁
- [ ] 3.2 将 `v0.1.1` 草稿 Release 转为公开预览，保留一个 NSIS、一个 MSI 和一个 `SHA256SUMS.txt`，不移动或覆盖任何 tag
- [ ] 3.3 复核公开 Release 的 `isDraft=false`、正文首屏的未签名风险、资产 SHA-256、README 下载链接和旧 `v0.1.0` 隔离

## 4. 终审与归档

- [ ] 4.1 运行 Standards/Spec 双轴 code review，修复阻断项并记录结论
- [ ] 4.2 通过 OpenSpec 全量 strict validate，同步 `windows-release-management` 主规格
- [ ] 4.3 归档 `publish-vistash-public-release`，合并 PR 并清理临时发布分支，最终只保留 `main`
