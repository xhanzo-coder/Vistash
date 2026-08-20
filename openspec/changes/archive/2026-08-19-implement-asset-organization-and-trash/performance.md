# 性能基线

测量日期：2026-08-19
构建：Windows `--release`
fixture 位置：仓库 E 盘下的 `app/target/vistash-test-temp`，不含真实媒体文件。

| 场景 | 数据规模 | 结果 | 门禁与处理 |
| --- | ---: | ---: | --- |
| 文件夹 + 双标签 + Unicode 文件名组合查询 | 10,000 条索引记录 | 58.0585 ms | 低于 200 ms，通过 |
| 重命名影响文件夹内全部素材 | 1,000 个权威侧车 | 152.696314 s | 超过 2 s；Tauri 后台任务保持界面响应，并通过 typed `Channel` 持续呈现完成数、总数和当前文件名 |

10,000 条 fixture 最初暴露出逐素材 SQLite 事务问题。索引现改为一次批量事务，既缩短性能测试准备，也改善真实批量导入后的索引写入。

可重复命令（在 `app/` 下，并先把 `TEMP`、`TMP` 指向 E 盘测试目录）：

```powershell
cargo test --release -p vistash-core release_query_of_ten_thousand_index_rows_finishes_within_200_ms -- --ignored --nocapture
cargo test --release -p vistash-core release_rename_of_one_thousand_sidecars_records_baseline -- --ignored --nocapture
```
