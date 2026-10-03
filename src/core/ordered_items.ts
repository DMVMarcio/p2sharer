export function moveOrderedItem(ids: string[], id: string, target: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0 || target < 0 || target >= ids.length || target === from) return ids;
  const result = [...ids];
  result.splice(from, 1);
  result.splice(target, 0, id);
  return result;
}
