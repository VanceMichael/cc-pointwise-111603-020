# 港口窗口计划簿

Node.js 本地数据接入项目。采集港方（`/ports/P1/windows`）与代理（`/agents/windows`）两个来源的靠泊窗口，保留每次来源修订，按接收时间支持值班交接回放，并对身份不明和同泊位重叠给出人工核查提示。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行行为与本地接口测试；`npm run demo` 启动临时来源、读取两个来源的完整批次、演示撤销与交接回放，结束后清理临时数据，通常两秒内完成。`npm run acceptance` 在临时目录验证首批导入、重启回读、重放、完整批次、撤销/恢复与交接视图。

命令（`npm start -- --help` 查看）：

| 命令 | 说明 |
| --- | --- |
| `npm start -- ingest [文件]` | 导入 `fixtures/records.json` 或指定结构化记录 |
| `npm start -- query [来源]` | 只返回当前投影，保持原集合形状 |
| `npm start -- collect [--url 地址] [--received-at 时间]` | 读取两个来源的完整批次（含翻页）；不传 `--url` 时启动内置 fixture 来源 |
| `npm start -- board [--as-of 时间]` | 值班视图；`as-of` 按当时已接收的信息重建 |
| `npm start -- history [--as-of 时间]` | 保留的原始观察 |
| `npm start -- link [文件]` | 记录人工确认的跨来源身份依据，不改动计划 |

状态文件默认为 `var/records.json`，可用 `PORT_BOARD_STATE` 覆盖。状态目录属于运行产物。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口；`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()，支持 ETag/304 与范围请求。`src/source-client.js` 只接受同一回环来源。

`src/adapter.js` 解析港方 HTML 与代理 JSON 页面，保留原始来源字段；`src/collect.js` 跟随 `rel=next` / `next` 读取完整批次，失败即中止。`src/records.js` 负责观察规范化、内容指纹去重、按来源修订时间和接收时间选择最新修订，以及交接时点投影。`src/repository.js` 持久化 `observations`（全部历史）、`records`（当前投影，兼容旧消费）和 `identity`（人工关联）；`src/service.js` 是写入生命周期；`src/identity.js` 判定身份；`src/board.js` 生成值班视图与核查提示；`src/operations.js` 是业务读取入口。语义详见 [CONTRACT.md](CONTRACT.md)。

测试直接使用随机端口来源，不等待真实时间、不接入外网，也不需要浏览器或外部数据库。
