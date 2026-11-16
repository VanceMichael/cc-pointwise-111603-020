const fields = ["sourceWindowId", "source", "vesselId", "vesselName", "berth", "startsAt", "endsAt", "state", "modifiedAt"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "港口窗口计划簿", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
