export const schema = Object.freeze({
  "product": "港口窗口计划簿",
  "entity": "靠泊计划",
  "identity": "sourceId",
  "identityScope": "source",
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "港口靠泊窗口采集与冲突提示：保留各来源原始窗口、按接收时间还原历史、身份不明与同泊位重叠只提示人工核查"
});
