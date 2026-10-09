# Demo dataset

`sample-data.json` contains fictional people and tasks for consistent demos and
screenshots. It is a semantic fixture, not a database dump or an import archive.
It contains no credentials, sessions, account IDs, or database IDs.

Use the fixed clock anchor `2026-10-06T12:00:00Z` with the UTC timezone, English,
and the standard reading preset. Keep the people, task titles, workspace scopes,
priorities, and labels stable. Resolve `dueOffsetDays` relative to the clock
anchor. The source tag and SHA record the release used for the original capture;
they do not select a runtime automatically.

For a fresh demo, create a disposable instance, register fictional users through
ordinary signup, and generate new IDs when mapping these records to application
rows. Create separate personal scopes and the shared Maple household and Garden
club workspaces. Keep credentials and session state outside this dataset. Never
seed an existing instance containing user data.

Create the personal Weekly priorities view owned by Casey Lane using the JSON
filter and display configuration. Resolve each `personAlias` to its fresh user
ID, then add the fresh view ID to Casey Lane's `user_pref.pinned_views`. The
preference row ID is the user ID. This pin makes the view available in navigation;
the assignee filter includes parent tasks and keeps subtasks in Task Detail.

Capture real product UI without replacing its DOM or styles. The reference
layouts use Task Detail at 1440x1000 and 390x1000, and the cross-workspace priority
Board at 1440x1000. Remove only the disposable instance and its explicitly owned
synthetic data when finished; this versioned fixture remains reusable.
