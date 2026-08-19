// 发布构建不附带控制台窗口；debug 构建保留控制台，使 panic 与后端日志可见。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vistash_lib::run()
}
