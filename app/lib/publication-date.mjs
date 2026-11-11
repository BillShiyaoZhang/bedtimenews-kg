/** Publication-date presence, shared by search indexing and year filtering. */
export function hasKnownPublicationDate(event) {
  return event.datePrecision !== "unknown" && event.date !== "1900-01-01" && /^\d{4}-\d{2}-\d{2}$/u.test(event.date ?? "");
}

export function eventWithinYears(event, fromYear = "", toYear = "") {
  if (!fromYear && !toYear) return true;
  if (!hasKnownPublicationDate(event)) return false;
  const year = event.date.slice(0, 4);
  return (!fromYear || year >= fromYear) && (!toYear || year <= toYear);
}
