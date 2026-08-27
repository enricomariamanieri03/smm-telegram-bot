# Architecture Guide

## 1. Purpose and boundaries

The bot receives one Telegram photo or an album, generates a social-media caption, shows an editable preview, and publishes the approved content to Facebook, Instagram, or both.

The system is intentionally organized around three boundaries:

```text
Telegram handlers  →  application services  →  external APIs
```

- **Handlers** own Telegram updates, callback routing, and chat UX.
- **Services** own API-specific protocols, validation, retries, state, and cleanup.
- **External APIs** are never called directly from `main.ts`.

`main.ts` only loads configuration, authenticates Telegram users, starts the Cloudinary cleanup schedule, and registers grammY routes.

## 2. Main components

| Component | Responsibility |
| --- | --- |
| `photo.handler.ts` | Receives Telegram photos, groups albums, calls OpenAI, creates previews, and creates preview sessions. |
| `approve.handler.ts` | Publishes approved posts, prevents duplicate clicks, coordinates Facebook/Instagram, and manages cross-platform retry. |
| `edit.handler.ts` | Opens edit mode, consumes the next user text, regenerates copy, and replaces the preview. |
| `reject.handler.ts` | Removes rejected previews and source media with a deliberate UX delay. |
| `openai.service.ts` | Calls OpenAI Vision/copy generation and requires schema-conformant JSON responses. |
| `facebook.service.ts` | Publishes one photo or a multi-photo post to a Facebook Page. |
| `instagram.service.ts` | Creates Instagram media containers, polls their status, and calls `media_publish`. |
| `cloudinary.service.ts` | Temporarily hosts Instagram images as public HTTPS URLs and normalizes them to Instagram-compatible 4:5 JPEG assets. |
| `cloudinary-garbage-collector.service.ts` | Removes tagged temporary Cloudinary assets older than 24 hours. |
| `pending-post.service.ts` | Maintains preview, editing, expiration, and cross-platform state in memory. |
| `preview.service.ts` | Creates Telegram preview markup and consistent inline keyboards. |

## 3. Photo and album ingestion

Telegram sends every item in an album as a separate update. `photo.handler.ts` uses:

- `albumBuffers: Map<media_group_id, AlbumBuffer>`;
- one buffer per Telegram `media_group_id`;
- an 800 ms debounce reset for every incoming album item.

This prevents an album from generating one OpenAI request per photo. When the debounce expires, the buffer is removed and all collected file IDs are processed together.

For a single image, processing starts immediately. In both cases the handler:

1. obtains Telegram file paths;
2. downloads media in parallel;
3. converts them to data URLs for OpenAI Vision;
4. generates a structured social post;
5. sends the interactive preview.

## 4. Structured AI output

OpenAI is configured with `response_format: json_schema` and `strict: true`. The social post schema requires:

```ts
{
  destinazione: 'FB' | 'IG' | 'ENTRAMBI',
  luogo: string,
  testo_pulito: string,
}
```

The schema does not guarantee marketing quality, but it guarantees the shape and allowed destination values before the application consumes the response. A model safety refusal is handled explicitly and is never parsed as JSON.

The edit workflow uses a narrower schema with only `luogo` and `testo_pulito`, preserving the platform destination selected for the original preview.

## 5. Preview session state

`pending-post.service.ts` stores only the data needed after preview generation:

```text
mapPendingPosts
  key: postId from Telegram callback data
  value: preview caption, destination, location, Telegram file IDs,
         source/preview message IDs, optional edit state and publish state

editingPostIdsByChat
  key: chatId
  value: postId currently awaiting edit text
```

The second map is an index, not a duplicate copy of the post. It gives the normal `message:text` handler an O(1) way to find the one preview awaiting edit instructions for a chat.

### TTL and expiration

Every preview has a one-hour TTL. At expiry:

1. the service removes the post from `mapPendingPosts`;
2. it clears the optional editing index;
3. it invokes the handler-supplied `onExpire` callback.

The callback keeps Telegram-specific operations out of the state service. The photo handler removes the expired preview keyboard and sends a session-expired notice. Timers use `.unref()` so they do not keep the Node.js process alive by themselves.

### Editing state

Editing uses two explicit states:

- `AWAITING_INPUT`: the next valid text message in that chat is an edit instruction;
- `PROCESSING`: OpenAI regeneration is running, so additional text is ignored.

After the new preview is sent, `updatePendingPostPreview` updates the existing session and releases the `chatId → postId` index.

## 6. Publishing workflows

### Facebook

For one image, the service sends a multipart request to the Page photos endpoint.

For a multi-photo post, it:

1. uploads each photo as an unpublished Page photo (`published=false`);
2. collects the returned photo IDs;
3. creates one Page feed post with `attached_media`.

If an upload fails before the final post is created, already uploaded unpublished photos are deleted with a best-effort `Promise.allSettled` rollback.

### Instagram

Instagram requires Meta to download media from a public HTTPS URL. The flow is therefore:

```text
Telegram Blob → Cloudinary temporary HTTPS URL → Instagram media container → media_publish
```

Cloudinary uploads are normalized to 1080×1350 JPEG (4:5) and tagged `temp_instagram`. This gives Instagram-compliant assets and allows targeted cleanup.

For a carousel, child containers are created first, then assembled in a parent carousel container. The service polls `status_code` until it reaches `FINISHED` before calling `media_publish`.

`ERROR` and `EXPIRED` are valid asynchronous container states returned by a successful polling HTTP response; they are not necessarily HTTP errors. They are classified as safe for immediate Cloudinary cleanup. Network errors, timeouts, and server-side failures remain ambiguous to avoid deleting assets while Meta could still be processing them.

### Cross-platform publication and retry

The `ENTRAMBI` flow runs eligible Facebook and Instagram operations in parallel with `Promise.allSettled`.

Each platform is stored as one of:

- `PENDING`
- `PUBLISHED`
- `FAILED` — deterministic failure, eligible for one retry
- `UNKNOWN` — ambiguous result, deliberately not retried automatically

If exactly one or both platforms fail deterministically on the first attempt, the preview receives one `Riprova` action. A retry runs only platforms still marked `FAILED`, preserving any successful publication and preventing duplicates. After a successful retry or after retry eligibility ends, the pending session is removed.

## 7. Reliability and cleanup

| Concern | Mechanism |
| --- | --- |
| Duplicate Approve callbacks | `publicationInProgress: Set<postId>` lock in `approve.handler.ts` |
| Slow/unresponsive Meta calls | `AbortController` with a 15-second request timeout |
| Instagram media availability | Container status polling before `media_publish` |
| Invalid external payloads | Runtime validation and Graph API error extraction with `fbtrace_id`/subcodes |
| Failed Facebook album creation | Best-effort deletion of unpublished photos |
| Failed Instagram processing | Immediate cleanup only when the error is definitive/safe |
| Orphaned Cloudinary files | Daily Search API cleanup for `temp_instagram` assets older than 24 hours |
| Stale Telegram previews | One-hour TTL and keyboard removal |
| Reject/Edit chat noise | Delayed, best-effort message deletion |

## 8. Testing strategy

The project uses Vitest with a separate `tests/tsconfig.json`. Production compilation remains scoped to `src`, while test files receive Node and Vitest type definitions.

### Unit tests

- Facebook service: successful publishing, Graph API errors, multi-photo rollback.
- Instagram service: HTTP classification, `ERROR`/`EXPIRED`, polling, and timeouts.
- Cloudinary garbage collector: pagination, batch deletion, and non-blocking failure handling.
- Pending-post service: defensive copies, edit index transitions, state updates, and TTL expiration.

### Integration tests

- Approve handler: duplicate-click protection and retrying only the failed platform.
- Edit handler: callback-to-regeneration workflow, preview replacement, session release, and delayed input cleanup.
- Reject handler: state removal and timed deletion of preview, source media, and temporary notification.

All network-facing dependencies are mocked in tests. This makes failures deterministic and prevents tests from publishing real social posts or using real Cloudinary assets.

## 9. Deployment consideration

The current `Map`-based session store is intentionally local to one Node.js process. For horizontal scaling or restarts that must preserve active previews, replace `pending-post.service.ts` with a shared store such as Redis and use distributed locking for publication callbacks.
