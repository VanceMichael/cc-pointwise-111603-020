# 来源与消费契约

## 来源

入口 `/ports/P1/windows`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

sourceWindowId 仅在 source 内唯一；vesselId 是来源明确的船舶身份，名称不能单独合并计划。窗口半开区间 [startsAt,endsAt)，同泊位重叠需要提示但不得自动排程。modifiedAt 是来源更新时间，接收时间决定当时已知范围，延迟来源不意味着取消；fixtures/identity.json 存放可复核的跨来源关联。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
