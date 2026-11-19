export const schema = Object.freeze({
  "product": "港口窗口计划簿",
  "entity": "靠泊计划",
  // A source window id is only unique inside its own source; the collector key
  // is therefore (raw source, sourceWindowId), never the id alone.
  "identity": ["source", "sourceWindowId"],
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "港口靠泊窗口采集、来源状态与冲突提示；仅提示人工核查，不自动排程或合并"
});
