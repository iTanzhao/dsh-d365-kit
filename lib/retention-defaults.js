/**
 * Defaults for retention and storage hygiene. Kept in their own module so both
 * `config.js` and `retention.js` can read them without a circular import.
 */
export const DEFAULT_RETENTION = {
  snapshotKeep: 2,
  snapshotMaxAgeDays: 30,
  reportKeep: 50,
  reportMaxAgeDays: 90,
  diffKeep: 20,
  diffMaxAgeDays: 30,
  queryKeep: 100,
  queryMaxAgeDays: 7,
  changeKeep: 200,
  changeMaxAgeDays: 180,
  warnMegabytes: 800,
}
