/**
 * SQL for a canonical timestamp column: RFC 3339 UTC text with the column's full
 * microsecond precision, for example `2026-01-02T03:04:05.123456Z`. A driver
 * `Date` keeps only milliseconds, so a row serialized from one would not match
 * the same row's list cursor, and a millisecond cursor would skip rows that
 * share a millisecond. The fixed-width text sorts chronologically and
 * round-trips through `::timestamptz` exactly.
 */
export function utcTimestampSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
