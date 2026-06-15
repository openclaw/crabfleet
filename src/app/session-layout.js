const sessionLayoutStorageKey = "crabbox-session-layout-v1";
const sessionLayoutColumns = new Set(["auto", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

export function orderedSessionItems(items, layout) {
  const currentIds = new Set(items.map((item) => item.id));
  if (!layout.manualOrder) return items;
  const order = [
    ...layout.order.filter((id) => currentIds.has(id)),
    ...items.map((item) => item.id).filter((id) => !layout.order.includes(id)),
  ];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort(
    (left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function moveSessionLayoutItem(layout, items, sourceId, targetId) {
  const ids = orderedSessionItems(items, layout).map((item) => item.id);
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) return layout;
  ids.splice(sourceIndex, 1);
  ids.splice(targetIndex, 0, sourceId);
  return { ...layout, manualOrder: true, order: ids };
}

export function defaultSessionLayout(edit = false) {
  return { columns: "auto", edit, manualOrder: false, order: [], sizes: {} };
}

export function normalizeSessionLayout(value) {
  return {
    columns: sessionLayoutColumns.has(String(value?.columns)) ? String(value.columns) : "auto",
    edit: false,
    manualOrder: Boolean(value?.manualOrder),
    order: Array.isArray(value?.order) ? value.order.map(String).slice(0, 200) : [],
    sizes: typeof value?.sizes === "object" && value.sizes ? value.sizes : {},
  };
}

export function loadSessionLayout(storage = localStorage) {
  try {
    return normalizeSessionLayout(
      JSON.parse(storage.getItem(sessionLayoutStorageKey) || "null") || defaultSessionLayout(),
    );
  } catch {
    return defaultSessionLayout();
  }
}

export function saveSessionLayout(layout, storage = localStorage) {
  try {
    storage.setItem(
      sessionLayoutStorageKey,
      JSON.stringify({
        columns: layout.columns,
        manualOrder: layout.manualOrder,
        order: layout.order,
        sizes: layout.sizes,
      }),
    );
  } catch {}
}
