# 来源与消费契约

## 来源

入口 `/ports/P1/windows`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。代理来源 `/agents/windows` 返回 JSON `items` 与 `next`。`fixtures/source.json` 的 opening / updated / restored / delayed / mixed / paged 是可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

sourceWindowId 仅在 source 内唯一；vesselId 是来源明确的船舶身份，名称不能单独合并计划。窗口半开区间 [startsAt,endsAt)，同泊位重叠需要提示但不得自动排程。modifiedAt 是来源更新时间，接收时间决定当时已知范围，延迟来源不意味着取消；fixtures/identity.json 存放可复核的跨来源关联。

## 采集

一次采集是完整批次：两个来源各自的全部页面（跟随 rel=next / next）在同一 `receivedAt` 下写入。任一页面失败即整批中止，避免把不完整页面当作完整批次。来源重放不会重复保存。

每条观察同时保留来源修订时间 `observedAt`（modifiedAt）与接收时间 `receivedAt`：

- 同一来源、同一 sourceWindowId 的多次观察全部保留，构成可审计的历史；
- 当前投影取 `observedAt` 最新的一条，若相同再按 `receivedAt` 比较；迟到的旧修订不能覆盖已收到的新修订，也不会让已撤销窗口复活；
- `receivedAt <= asOf` 的观察构成“当时已知范围”，用于交接回放，而不是用今天最新页面替换过去所见。

原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。

## 身份

只在以下情况把窗口视为“同一条计划”：来源自身给出 `vesselId`；或 `fixtures/identity.json` / `link` 命令记录了人工复核的跨来源关联。名称仅作为 `identity.basis` 中的证据保留。无法确认时 `identity.status = "unconfirmed"` 并提示人工核查，绝不按名称合并。

## 状态

状态按来源独立判定，来源的最新修订决定：

| state | 含义 | 值班视图 |
| --- | --- | --- |
| scheduled | 正常靠泊窗口 | `active: true` |
| delayed | 来源暂时延迟 | `active: true`、`temporaryDelay: true`，附说明 |
| cancelled | 来源明确撤销 | `withdrawn: true`，保留在历史与视图但不占用泊位 |

撤销、恢复都是来源的修订。恢复以上一条新的 `scheduled` 修订表示，不改写先前撤销记录。

## 冲突

同一泊位、半开区间内重叠且双方都仍有效的窗口，各打 `berth-overlap` 标记并列入 `reviews`；触端点不算重叠。同一来源同一已确认船舶存在多条有效窗口时打 `multiple-windows`。身份不明确且未撤销的窗口打 `identity-unconfirmed`。

所有提示均为 `review-only`：不移动泊位、不合并计划、不删除来源窗口。

## 业务消费

`readOperations(repository)` 返回 `product`、`rows`、`reviews`；每行带 sourceId/source/observedAt/receivedAt/attributes 及 `active`/`withdrawn`/`temporaryDelay`/`identity`/`review`。`readOperations(repository, { asOf })` 按当时已接收的观察重建同一视图，`asOf` 回显在结果中。

`query` 与仓储中的 `records` 字段仍只保存当前投影，形状与字段保持兼容；完整历史在 `observations` 中，通过 `history` 命令或 `service.history()` 读取。身份关联存于 `identity`，只记录决策，不合并计划。

来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
