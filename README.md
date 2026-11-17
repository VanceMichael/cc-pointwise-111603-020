# 港口窗口计划簿

Node.js 本地数据接入项目。来源服务和业务存储独立，来源变化不会自动刷新本地集合。计划采集保留各来源的原始窗口与身份依据，按收到时间还原“当时已知”的计划，并把来源明确的撤销、恢复与暂时延迟分别表达出来；无法确认身份或同泊位时间重叠时只提示人工核查，不自动挪动泊位或合并计划。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为、采集生命周期与计划比较测试；`npm run demo` 启动临时来源，依次读取港方与代理页面、记录一次身份决定、再读港方更新，展示当前计划视图，结束时自动关闭监听并清理临时数据。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。source.json 的 opening、updated、restored、delayed 四个阶段分别表示排定、撤销、恢复与暂时延迟。

`src/source-client.js` 只接受同一回环来源，并把 ETag 交给来源做条件读取。`src/adapter.js` 解析港方 HTML 页面与代理 JSON 页面（都带 rel=next），保留来源原样的 `attributes`，并记录页面 ETag 与正文摘要。`src/service.js` 逐页读完一个来源后才把整批作为一个接收观察写入；`src/repository.js` 持久化：

- `records`：每个来源窗口的最新版本（原集合视图，兼容旧文件）；
- `observations`：按来源窗口逐版本追加，含来源 `modifiedAt`、接收时间 `receivedAt` 与首次/最近收到时间；
- `ingests`：真正改变已知内容的接收批次（含页面路径与 ETag）；
- `identityDecisions`：人工记录的跨来源身份依据，只在查询中作为证据使用。

`src/plans.js` 把观察还原为计划：同一来源窗口内按 `modifiedAt` 排序版本（迟到旧页面不能回滚），跨来源只按 `receivedAt` 排序。窗口按明确的 `vesselId` 或已记录的人工身份决定归并；船名相同仅作为提示，绝不据此合并。`src/operations.js` 是业务读取入口，返回 `rows`（原逐窗视图）、`plans`（含各来源窗口、版本历史与撤销/恢复/延迟证据）、`manualReview`、`conflicts` 与 `coverage`。

## 命令

`npm start` 或 `npm start -- --help` 查看命令；原导入和查询使用显式的 ingest、query 动作。

```sh
npm start -- ingest --source http://127.0.0.1:PORT --source-key port --as-of 2026-11-16T10:00:00Z
npm start -- ingest --source http://127.0.0.1:PORT --source-key agent --as-of 2026-11-16T10:01:00Z
npm start -- ingest --identity fixtures/identity.json --as-of 2026-11-16T10:02:00Z
npm start -- query --as-of 2026-11-16T10:30:00Z
npm start -- query --history --coverage
```

`--as-of` 使用接收时间截断：查询只看到该时刻之前已收到的版本，不会用今天的最新页面替换过去所见。已取消的计划默认保留在结果中（`--hide-cancelled` 可隐藏），恢复与暂时延迟各带来源证据。`manualReview` 包含：缺少 vesselId 且无身份决定、同一泊位时间重叠、同一计划来源互相矛盾（一个撤销、另一个仍排定）、同一来源重复窗口、无法识别的来源状态、窗口内 vesselId 变化等；`conflicts` 单独列出泊位重叠。所有提示都不会改写来源窗口。

状态目录属于运行产物。扩展导入时保留现有 CLI 和集合查询能力；测试可直接使用随机端口来源，不需要等待真实时间或接入外网。`npm run acceptance` 在临时目录中验证来源读取、重启回读、重放、身份决定、撤销/恢复/延迟以及按时点回放，完成后清理临时状态。
