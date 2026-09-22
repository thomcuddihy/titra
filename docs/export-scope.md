# Export the current page or all matching records

Details has a **CSV / Excel scope** control beside its file-export buttons:

- **Current page** (default): export the rows on the displayed page, as before.
- **All matching records**: export matching rows from every page, without changing
  the page, filters, or **Show row lines** setting on screen.

The control is available in Detailed, Daily, Total, and Working time. Each view
keeps its existing columns, grouping and units. “All” means all results matching
that view's selected scope, not every record in the database. Detailed exports
include the selected search and column filters. The toggle only affects CSV and
Excel; it does not expand billing, invoicing, or outbound-integration actions.

## Larger exports

All-matching exports retrieve at most 500 rows per request into a separate export
buffer; they do not load the entire result into the visible table. A progress
indicator and Cancel button are shown while preparing the file. Changing the
table query or leaving the view cancels preparation. A failed or cancelled fetch
does not download a partial file or mark any records exported. Excel compression
also checks cancellation immediately before initiating the download.

The safety limits are 100,000 result rows, 50 MiB of serialized rows and row keys,
and two minutes of collection time. These are explicit errors, not silent
truncation. Narrow the period or project/resource filters if a limit is reached.
The serialized-data limit is not a browser memory guarantee: Excel generation
uses additional memory. The server also enforces per-request size, duration,
concurrency, authorization and rate limits.

Selected filters and relative date boundaries are captured when the export
starts. Live data is read in bounded batches, **not in a database-wide
point-in-time snapshot**. Count changes, duplicate rows and incomplete pages
cause an error rather than an apparently complete file. Those checks cannot
detect every concurrent edit that keeps the count unchanged; avoid editing the
matching data during a consistency-critical export.

## Detailed record status

As with the existing Detailed export, successfully initiating the download is
followed by marking eligible records **Exported**. Only the exact exported IDs
are considered, in bounded batches, and only records still New (or lacking a
state) are changed. Records changed to Billed or Non-billable in the meantime are
not overwritten. An authorization or marking failure is reported separately:
the file may already have downloaded even if some statuses could not be updated.
Browser download initiation does not prove that a user saved the file to disk.

Daily, Total, and Working time exports are read-only.

## Permissions

All-matching reads recheck account and project access on every page. They do not
grant access to hidden fields or allow those fields to be inferred through
filters. If a filter requires membership in every selected project, remove it
or narrow the project selection. Customer lookups in the shared view queries
search all accessible projects, so customer filters conservatively require
membership in that whole scope. If rejected, remove the customer filter and
select the relevant member projects instead. Public-project access alone does not grant
permission to mark someone else's records Exported; the file can download while
the separate status update reports an authorization failure.

Working-time all-matching exports use the caller's own working-profile settings.
Other resources use global schedule defaults and only names allowed by the
existing project-user visibility rules; private profile settings are not read
or exposed by this new endpoint.

## Development verification

Run the Node test suite (`node --test`) from a clean source checkout. Relevant
regressions include export collection/pagination/cancellation, view serializers,
controller lifecycle, server authorization/privacy/limits, conditional status
updates, and real CSV/XLSX encoding. Browser acceptance should use a disposable
dataset larger than 500 rows and compare Current page versus All matching records,
including filters, errors, cancellation and an unchanged displayed page size.
