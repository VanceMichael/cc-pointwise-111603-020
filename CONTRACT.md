# 来源与消费契约

## 来源

入口 `/ports/P1/windows`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。`fixtures/source.json` 的 opening、updated、restored、delayed 是四个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。代理页面位于 `/agents/windows`，返回 `{items, next}` JSON。

sourceWindowId 仅在 source 内唯一；vesselId 是来源明确的船舶身份，名称不能单独合并计划。窗口半开区间 [startsAt,endsAt)，同泊位重叠需要提示但不得自动排程。modifiedAt 是来源更新时间，接收时间决定当时已知范围，延迟来源不意味着取消；fixtures/identity.json 存放可复核的跨来源关联，代理页面的 vesselId 为空时须由人工决定补足。

## 采集语义

一次采集读完一个来源的所有 rel=next 页面后作为整批写入，任一页失败则不写入该批。每个版本按（来源、sourceWindowId、来源更新时间、内容摘要）去重；重复看到同一版本只更新最近收到时间，不改写版本内容或首次收到时间。来源 modifiedAt 只用于同一来源窗口内的版本先后，跨来源比较只用接收时间。旧版 `{records}` 文件仍可读取，并会在下次写入时迁移为一个观察。

## 业务消费

`readOperations(repository, {asOf, includeCancelled})` 返回 `product`、`rows`、`plans`、`manualReview`、`conflicts`、`coverage`。`rows` 保持原有逐来源窗口的 `sourceId/source/observedAt/attributes` 形状；`plans` 按明确身份分组，每行带各来源原始窗口、版本历史、身份依据与撤销/恢复/延迟证据。`asOf` 只使用接收时间：过去的查询不得出现之后才收到的版本或身份决定。

撤销（cancelled 等）、恢复（restored 或撤销后重新排定）、暂时延迟（delayed 等）都只作为来源证据呈现，状态矛盾时标为 disputed 并提示人工核查。同一泊位时间重叠、身份无法确认、同一来源重复窗口等一律只在 `manualReview`/`conflicts` 中提示，不得自动改泊位或合并计划。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
