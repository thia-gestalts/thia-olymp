# Idea: manifest compaction

Status: idea, not scheduled. It would need a protocol 1.2, because every client must understand the compaction horizon.

## Problem

Every sync publishes the whole encrypted manifest (`PUT /base`). The manifest grows with the number of edits ever made, not with the number of records:

- `removed` holds every superseded head ID and is never pruned (`merge` in `web/client.js`). Each `put` adds the IDs of the heads it replaced.
- Deletions remain as `deleted: true` heads forever.

A tombstone costs about 39 bytes of JSON. A 4 MiB body limit on `PUT /base` therefore allowed roughly 80,000 edits before the service answered 413, which the client reports as "Storage limit reached". An app that saves on every keystroke reaches that point with only a handful of notes.

## Why the server cannot simply drop history

The service keeps the current state, because new devices, reinstalls and lost devices can only recover from it. Tombstones are different. They exist so that an older replica merging into the base cannot resurrect superseded or deleted versions.

"Every logged-in device is fully synced" is not a safe condition for dropping tombstones:

- Logout and session expiry (30 days) remove only the session. The local replica under `[origin, accountId]` survives and is reused on the next sign-in.
- When that stale replica merges without the tombstones, its superseded heads come back as concurrent versions and its deleted records reappear.
- The manifest is end-to-end encrypted. Only a client can compact it.

## Proposal

1. **Record when IDs were superseded.** `removed` becomes `[[id, revision]]`, where `revision` is the base revision that first published the tombstone.
2. **Compaction horizon `H`.** A client may publish a manifest that sets `horizon: H` and drops:
   - tombstones with `revision < H`
   - `deleted` heads without files that were published before `H`

   `H` must not exceed the lowest `confirmed` revision of live sessions (`GET /devices`). Clients should also apply an age margin, for example only compacting history older than 30 days, so that recently expired sessions are covered.
3. **Stale replicas rebase and do not merge.** A replica whose last synced revision is below the remote `horizon` does not merge its base. It adopts the remote base, then replays only its own pending, never-published operations as new writes against what they observed. A pending write whose observed head is gone becomes a concurrent version for the user to resolve, as today.
4. **Attachments.** Chunk references disappear together with the dropped heads. The existing server staging already collects dereferenced chunks after 24 hours.

With step 3, correctness does not depend on knowing every device that ever existed. The manifest then scales with live records and the base body limit stops mattering for normal use.

## Open questions

- Which client compacts, and how often? Any client after a successful confirmation once the droppable history passes a size threshold would be simple, but concurrent compactions then race through the CAS.
- Should the horizon be shown in the device list, so that a user can see that a long-offline device will rebase?
- Splitting the manifest into per-record or per-segment objects would remove the whole-manifest upload as well. That is a larger change and separate from this idea.
