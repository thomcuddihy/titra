# Time-entry date storage

Time-entry dates are calendar values, not instants in time. New records therefore
store the selected day as a `dateOnly` string in `YYYY-MM-DD` form. When start-time
tracking is enabled, the wall-clock value is stored separately as `startTime` in
`HH:mm` form.

The existing `date` BSON value remains as a UTC-midnight shadow of `dateOnly`.
This preserves compatibility with existing range queries and indexes without
asking browsers or servers to infer a timezone from a calendar day.

For example, a user selecting 5 September 2026 at 09:30 creates these fields:

```json
{
  "date": "2026-09-05T00:00:00.000Z",
  "dateOnly": "2026-09-05",
  "startTime": "09:30"
}
```

## Legacy compatibility

Existing records are not reinterpreted automatically. If `dateOnly` is absent,
titra continues to treat the UTC calendar portion of `date` as the recorded day.
For display, a start time encoded in a legacy `date` retains the old local-time
behavior. This avoids silently moving dates or times for installations whose users
already understood the historical values according to local convention.

Editing a legacy record in the day view writes the explicit calendar date and
start time shown to the user. Editing an aggregate week cell preserves the legacy
timestamp because a week total cannot safely infer the timezone of its component
record. A week cell containing multiple matching records must instead be edited in
the details view, where each record is unambiguous.

## Concurrent changes

New records include `dateRevision`. Date-bearing updates compare the complete date
state they originally read before writing and increment the revision on success;
deletes perform the same comparison before removal. This prevents a concurrent data
migration or edit from being silently overwritten; callers receive
`timecard-write-conflict` and can reload before retrying.

## Existing API compatibility

The original HTTP API accepts either a strict `YYYY-MM-DD` calendar date or an
RFC 3339 timestamp with an explicit timezone offset. Date-only writes use the new
fields. Timestamp writes remain legacy records because the API cannot safely infer
which calendar timezone the caller intended. An optional `startTime` may be supplied
only with a date-only value.
