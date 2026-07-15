# Requirements Document

## Introduction

The **Realtime Trip Planner** is a reusable, collaborative travel-planning feature built on Next.js 16.2+ (App Router) and Supabase. Each trip is addressable via a human-readable slug (`/trip/[slug]`). Multiple users can simultaneously view and edit a trip's list of places, reorder them via drag-and-drop, track visit progress on an interactive map, share live location pings with a travel companion, and attach couple-style reviews and photos to each place.

The system stores durable data (trips, places, reviews, photos) in Supabase PostgreSQL and uses Supabase Realtime for instant cross-client synchronization. Ephemeral peer-to-peer events (emergency location pings) are delivered via Supabase Broadcast Channels without touching the database. Each place also carries cost fields (`estimated_cost`, `actual_cost`) that are aggregated client-side to display a live trip budget summary.

---

## Glossary

- **Trip_Router**: The Next.js App Router segment responsible for resolving `/trip/[slug]` and rendering the trip shell.
- **Trip_Page**: The async Server Component at `app/trip/[slug]/page.tsx` that fetches initial trip and places data server-side and streams it to the client.
- **Place_Board**: The client-side drag-and-drop board powered by `@dnd-kit`, displaying the ordered list of places for a trip.
- **Realtime_Channel**: A Supabase Realtime Postgres Changes subscription bound to a specific `trip_id`, broadcasting `places` table mutations to all connected clients.
- **Broadcast_Channel**: A Supabase Realtime Broadcast subscription scoped to a trip slug, carrying ephemeral peer-to-peer messages with no database writes.
- **Map_Viewer**: A client-only `react-leaflet` map component loaded exclusively via `next/dynamic` with `ssr: false` to prevent hydration errors.
- **Ping_Service**: The client-side subsystem that sends and receives emergency location pings over a Broadcast_Channel.
- **Review_Form**: The dual-input client component that accepts two user names and comments for a place.
- **Photo_Uploader**: The client component that accepts camera or file input and uploads images directly to the `trip-photos` Supabase Storage bucket.
- **Storage_Bucket**: The public Supabase Storage bucket named `trip-photos` used to store place photos.
- **visit_status**: A PostgreSQL enum with values `TODO`, `CURRENT`, and `DONE` representing a place's visit state.
- **order_index**: A `DOUBLE PRECISION` (float) column on the `places` table representing the sorted position of a place within its trip, enabling fractional indexing so reorders require only a single-row update.
- **estimated_cost**: A `NUMERIC(15,2)` column on the `places` table holding the projected cost for visiting a place, defaulting to `0.00`. Uses fixed-point arithmetic to avoid floating-point rounding errors for currency.
- **actual_cost**: A `NUMERIC(15,2)` column on the `places` table holding the real cost incurred for a place, defaulting to `0.00`. Uses fixed-point arithmetic to avoid floating-point rounding errors for currency.
- **Budget_Summary**: The sticky client-side component rendered by `TripShell` that displays the aggregated Total Estimated and Total Actual costs computed by a `.reduce()` over the live `places` state array.

---

## Requirements

### Requirement 1: Dynamic Trip Routing

**User Story:** As a traveler, I want to access a trip page via a memorable URL slug, so that I can share the link with my travel companion without exposing internal UUIDs.

#### Acceptance Criteria

1. THE Trip_Router SHALL resolve the URL pattern `/trip/[slug]` to a unique trip record by matching the `slug` column in the `trips` table.
2. WHEN a request arrives for `/trip/[slug]`, THE Trip_Page SHALL receive `params` as a `Promise<{ slug: string }>` and await it before querying Supabase, conforming to Next.js 16 async params convention.
3. IF no `trips` row matches the requested slug, THEN THE Trip_Router SHALL render the nearest `not-found.tsx` boundary and respond with HTTP 404.
4. THE Trip_Page SHALL fetch the trip record and its associated `places` rows (ordered ascending by `order_index`) in a single server-side data pass before streaming the initial HTML to the client.
5. WHILE the initial server-side data fetch is pending, THE Trip_Page SHALL stream a skeleton loading state via `loading.tsx` so the browser displays useful UI immediately.
6. THE Trip_Page SHALL export page-level metadata (title, description) derived from the trip's `title` and `description` fields using the Next.js 16 `generateMetadata` async function.

---

### Requirement 2: Collaborative Real-time Place Board

**User Story:** As a traveler collaborating on a trip, I want drag-and-drop reordering of places to propagate instantly to all other clients viewing the same trip, so that everyone sees the same up-to-date itinerary without manual refreshes.

#### Acceptance Criteria

1. THE Place_Board SHALL render the list of places as draggable items using the `@dnd-kit/core` and `@dnd-kit/sortable` libraries within a `'use client'` component.
2. WHEN a drag operation ends, THE Place_Board SHALL optimistically reorder the local place list in state before writing to the database, so the UI does not stutter.
3. WHEN a drag operation ends, THE Place_Board SHALL calculate a new `order_index` value as the arithmetic midpoint between the `order_index` values of the two adjacent places (i.e., `(prev.order_index + next.order_index) / 2`), then execute a single-row UPDATE to Supabase setting only the dragged place's `order_index` to this midpoint value. If the dragged place has no left neighbor, `order_index` SHALL be set to `prev.order_index / 2`; if it has no right neighbor, `order_index` SHALL be set to `prev.order_index + 1.0`.
4. THE Place_Board SHALL subscribe to a Realtime_Channel filtering Postgres Changes on the `places` table where `trip_id = [current trip id]` to receive `UPDATE` events from other clients.
5. WHEN a Realtime_Channel UPDATE event is received, THE Place_Board SHALL merge the incoming place data into local state, replacing stale entries by `id`, and re-sort the list by `order_index` (ascending float value) to maintain consistent ordering across all clients.
6. IF two clients submit a conflicting `order_index` update for the same place within the same database transaction window, THEN THE Place_Board SHALL resolve the conflict by re-fetching the authoritative order from Supabase after a debounce interval of 500 milliseconds, discarding intermediate optimistic states.
7. WHEN the Place_Board component unmounts, THE Place_Board SHALL unsubscribe from the Realtime_Channel to prevent memory leaks and orphaned subscriptions.
8. THE Place_Board SHALL display each place's `name`, `status` badge, and thumbnail `image_url` within its draggable card.

---

### Requirement 3: Visit Status Management

**User Story:** As a traveler on-the-go, I want to update the visit status of each place (TODO, CURRENT, DONE), so that my companion can see in real time which places we have visited, are visiting now, or plan to visit next.

#### Acceptance Criteria

1. THE Place_Board SHALL render a status control on each place card that allows selection among the three `visit_status` values: `TODO`, `CURRENT`, and `DONE`.
2. WHEN a status control selection changes to `CURRENT`, THE Place_Board SHALL invoke a Supabase RPC function (e.g., `set_place_current(place_id UUID, trip_id UUID)`) rather than issuing a direct table UPDATE, so that the constraint is enforced atomically at the database level.
3. THE database SHALL contain a PostgreSQL stored procedure or trigger that, within a single atomic transaction, sets the target place's `status` to `CURRENT` and sets the `status` of any other place in the same trip that previously held `CURRENT` to `DONE`, guaranteeing that at most one place per trip holds `CURRENT` at any point in time regardless of concurrent client writes.
4. WHEN a Realtime_Channel UPDATE event carrying a changed `status` field is received, THE Place_Board SHALL update the affected place card's status badge without disrupting ongoing drag operations.
5. WHEN a status control selection changes to `TODO` or `DONE`, THE Place_Board SHALL issue a direct UPDATE to the `places` table setting only the `status` column for the identified place row, since these transitions do not require the single-`CURRENT` constraint enforcement.

---

### Requirement 4: Geolocation Map with SSR Bypass

**User Story:** As a traveler, I want to see all places on an interactive map with color-coded pins matching their visit status, so that I can plan routes and track progress visually.

#### Acceptance Criteria

1. THE Map_Viewer SHALL be loaded exclusively via `next/dynamic(() => import('@/components/MapViewer'), { ssr: false })` inside a `'use client'` wrapper component, so that Leaflet's `window` and `document` references never execute on the server.
2. THE Map_Viewer SHALL render a `react-leaflet` `MapContainer` that initializes without throwing `ReferenceError: window is not defined` or hydration mismatch warnings in Next.js 16.
3. THE Map_Viewer SHALL render one `Marker` per place whose `lat` and `lng` are non-null, positioned at the place's geographic coordinates.
4. THE Map_Viewer SHALL apply a red pin icon to places with `status = 'TODO'`, a yellow pin icon to places with `status = 'CURRENT'`, and a green pin icon to places with `status = 'DONE'`.
5. WHEN a map `Marker` is clicked, THE Map_Viewer SHALL open a `Popup` displaying the place's `name` and current `status`.
6. WHEN the Place_Board receives a Realtime_Channel status update, THE Map_Viewer SHALL re-render the affected marker with the updated pin color without requiring a full page reload.
7. THE Map_Viewer SHALL auto-fit the map viewport to the bounding box of all non-null place coordinates when the component first mounts.
8. IF all places have null `lat` or `lng` values, THEN THE Map_Viewer SHALL display a fallback message indicating that no mappable locations are available.

---

### Requirement 5: Emergency Ping (Peer-to-Peer Location Sharing)

**User Story:** As a traveler separated from my companion, I want to broadcast my current GPS location instantly, so that my companion can see where I am in real time without that data being stored in the database.

#### Acceptance Criteria

1. THE Ping_Service SHALL subscribe to a Broadcast_Channel on the Supabase client scoped to the channel name `trip-ping:[slug]` upon mounting.
2. WHEN the user activates the emergency ping control, THE Ping_Service SHALL read the device's current position using the browser's `navigator.geolocation.getCurrentPosition` API with a timeout of 10 seconds.
3. WHEN a position is obtained, THE Ping_Service SHALL broadcast a message of type `location_ping` containing the fields `lat` (number), `lng` (number), `sender_label` (string), and `sent_at` (ISO 8601 timestamp string) over the Broadcast_Channel.
4. THE Ping_Service SHALL NOT write any location data to the Supabase database; all ping data is ephemeral.
5. WHEN a `location_ping` broadcast message is received, THE Ping_Service SHALL display the sender's location as a distinct animated marker on the Map_Viewer for a duration of 30 seconds, after which the marker SHALL be removed automatically.
6. IF `navigator.geolocation` is unavailable in the browser, THEN THE Ping_Service SHALL display an error message informing the user that location sharing is unsupported on this device.
7. IF `getCurrentPosition` returns an error or exceeds the 10-second timeout, THEN THE Ping_Service SHALL display a descriptive error message and allow the user to retry.
8. WHEN the Ping_Service component unmounts, THE Ping_Service SHALL unsubscribe from the Broadcast_Channel and cancel any pending geolocation requests.

---

### Requirement 6: Dual-Review Comment System

**User Story:** As a couple on a trip, I want each of us to leave a separate comment on a place, so that both perspectives are captured and visible to anyone viewing the trip.

#### Acceptance Criteria

1. THE Review_Form SHALL render two independent text input fields labeled with configurable user names (defaulting to "Person 1" and "Person 2") and one submit button per place.
2. WHEN the submit button is activated, THE Review_Form SHALL validate that at least one of the two comment fields contains a non-empty, non-whitespace string before writing to the database.
3. WHEN validation passes, THE Review_Form SHALL insert one `reviews` row per non-empty comment into the `reviews` table, each containing the corresponding `user_name`, `comment`, `place_id`, and a server-generated `created_at` timestamp.
4. IF the Supabase insert operation fails, THEN THE Review_Form SHALL display a descriptive error message and preserve the unsaved comment text in the input fields.
5. THE Review_Form SHALL display the list of existing reviews for a place ordered by `created_at` ascending, each showing `user_name`, `comment`, and a human-readable relative timestamp.
6. WHEN a new review is successfully inserted, THE Review_Form SHALL clear only the submitted comment fields and append the new review to the displayed list without a full page reload.

---

### Requirement 7: Mobile Camera Photo Upload

**User Story:** As a traveler at a location, I want to take a photo with my mobile camera and attach it to a place, so that we have visual memories associated with each stop on our trip.

#### Acceptance Criteria

1. THE Photo_Uploader SHALL render a file input element with `accept="image/*"` and `capture="environment"` attributes to invoke the rear camera on mobile devices.
2. WHEN a file is selected, THE Photo_Uploader SHALL validate that the file's MIME type begins with `image/` and that the file size does not exceed 10 megabytes before initiating an upload.
3. IF the file fails MIME type or size validation, THEN THE Photo_Uploader SHALL display a descriptive error message and clear the file input without uploading.
4. WHEN validation passes, THE Photo_Uploader SHALL upload the image file to the `trip-photos` Storage_Bucket using the Supabase Storage client, storing it under the path `[trip_id]/[place_id]/[uuid].[ext]`.
5. WHEN the upload completes successfully, THE Photo_Uploader SHALL retrieve the public URL of the uploaded file from Supabase Storage and update the corresponding `places` row's `image_url` column with that URL.
6. WHILE an upload is in progress, THE Photo_Uploader SHALL display a progress indicator and disable the file input to prevent concurrent uploads to the same place.
7. IF the Supabase Storage upload operation fails, THEN THE Photo_Uploader SHALL display a descriptive error message, remove any partially uploaded object from the Storage_Bucket, and restore the file input to its ready state.
8. WHEN a place's `image_url` is updated via the Realtime_Channel, THE Place_Board SHALL refresh the place card thumbnail without requiring a full page reload.

---

### Requirement 8: App Router Folder Structure

**User Story:** As a developer building the trip planner, I want a well-defined Next.js 16 App Router folder structure, so that routing, colocation, and server/client boundaries are enforced by the file system and easy to maintain.

#### Acceptance Criteria

1. THE Trip_Router SHALL be implemented as the directory `app/trip/[slug]/` containing `page.tsx`, `loading.tsx`, `error.tsx`, and `not-found.tsx` convention files.
2. THE Trip_Page SHALL colocate trip-scoped Server Component data-fetching helpers in `app/trip/[slug]/_lib/` using the Next.js private folder convention so they are not inadvertently routable.
3. THE Place_Board, Map_Viewer, Review_Form, and Photo_Uploader client components SHALL be colocated in `app/trip/[slug]/_components/` as `'use client'` modules.
4. THE Map_Viewer SHALL reside in a dedicated file `app/trip/[slug]/_components/MapViewer.tsx` and SHALL NOT be imported directly by any Server Component; it SHALL only be referenced through a `next/dynamic` wrapper with `{ ssr: false }`.
5. Shared Supabase client utilities SHALL remain in the existing `lib/client.ts` (browser) and `lib/server.ts` (server) files at the project root.
6. THE Trip_Page SHALL be a Server Component by default (no `'use client'` directive) so that the initial trip and places data fetch executes on the server and is not included in the client JavaScript bundle.

---

### Requirement 9: Concurrent Drag-and-Drop Conflict Mitigation

**User Story:** As a developer, I want a defined strategy for resolving concurrent drag-and-drop `order_index` conflicts between multiple clients, so that the displayed order is always eventually consistent with the database state.

#### Acceptance Criteria

1. THE `places` table's `order_index` column SHALL be typed as `DOUBLE PRECISION` (float), enabling fractional midpoint values so that any reorder operation requires only a single-row UPDATE for the dragged item, never a batch rewrite of sibling rows.
2. WHEN submitting a reorder to Supabase, THE Place_Board SHALL issue a single UPDATE targeting only the dragged place's `order_index` column with the calculated midpoint value, so the write is scoped to one row and cannot clobber concurrent `status` updates on other rows.
3. WHEN a Realtime_Channel UPDATE event arrives within 500 milliseconds of a locally initiated reorder write, THE Place_Board SHALL defer re-sorting from the incoming event until the local write's Promise resolves, to avoid flickering caused by stale remote data.
4. WHEN the local write resolves, THE Place_Board SHALL apply any queued remote updates in arrival order, discarding any that carry an `order_index` value superseded by the locally written value for the same place `id`.
5. IF the fractional precision of `order_index` values for adjacent places falls below `1e-9` (indicating repeated reordering in the same gap), THEN THE Place_Board SHALL trigger a background rebalance operation that reassigns evenly spaced `order_index` float values (e.g., `1.0`, `2.0`, `3.0`, …) across all places in the trip via a batched UPDATE, restoring precision headroom.
6. THE Place_Board SHALL expose a manual "Sync" action that re-fetches the full ordered places list from Supabase and replaces local state, providing a user-accessible escape hatch when the board appears out of sync.

---

### Requirement 10: Supabase Realtime Subscription Lifecycle

**User Story:** As a developer, I want all Supabase Realtime and Broadcast subscriptions to be correctly initialized and torn down with component lifecycle, so that there are no memory leaks, duplicate event handlers, or orphaned WebSocket connections.

#### Acceptance Criteria

1. THE Place_Board SHALL initialize its Realtime_Channel subscription inside a `useEffect` hook with an empty dependency array, so that the subscription is created exactly once per component mount.
2. THE Place_Board SHALL return a cleanup function from the `useEffect` that calls `supabase.removeChannel(channel)` to tear down the Postgres Changes subscription on unmount.
3. THE Ping_Service SHALL initialize its Broadcast_Channel subscription inside a `useEffect` hook scoped to the trip `slug`, so that a new subscription is created if the slug changes.
4. THE Ping_Service SHALL return a cleanup function from the `useEffect` that calls `supabase.removeChannel(channel)` on unmount or when the slug dependency changes.
5. THE Place_Board and Ping_Service SHALL use the Supabase browser client from `lib/client.ts` (created via `createBrowserClient`) and SHALL NOT create a new Supabase client instance on every render.

---

### Requirement 11: Per-Place Budget Tracking

**User Story:** As a couple planning a trip, I want to record an estimated and actual cost for each place we visit, and see the running totals for the whole trip, so that we can manage our travel budget in real time alongside our itinerary.

#### Acceptance Criteria

1. THE `places` table SHALL contain two additional columns: `estimated_cost` of type `NUMERIC(15,2)` with a default of `0.00`, and `actual_cost` of type `NUMERIC(15,2)` with a default of `0.00`. Both columns SHALL use fixed-point arithmetic to prevent floating-point rounding errors for currency values.
2. THE Place_Board SHALL display editable input fields for `estimated_cost` and `actual_cost` on each `PlaceCard`, pre-populated with the place's current values.
3. WHEN a cost input field loses focus (`onBlur`) or the Enter key is pressed while a cost input field is focused, THE PlaceCard SHALL issue a single-row UPDATE to the `places` table setting only the changed cost column (`estimated_cost` or `actual_cost`) for the identified place row.
4. WHEN a Realtime_Channel UPDATE event carrying a changed `estimated_cost` or `actual_cost` field is received, THE Place_Board SHALL update the affected place card's cost inputs without disrupting ongoing drag operations or other in-progress cost edits.
5. THE TripShell SHALL compute the total estimated cost and total actual cost for the trip by applying a `.reduce()` function over the live `places` state array, summing `estimated_cost` and `actual_cost` respectively.
6. THE TripShell SHALL render a sticky Budget_Summary component that displays the computed Total Estimated Cost and Total Actual Cost, updating reactively whenever the `places` state changes.
7. WHEN a cost UPDATE to the `places` table fails, THE PlaceCard SHALL display a descriptive inline error message and restore the input to its previously committed value, leaving no partial update in local state.
8. THE cost input fields SHALL accept only numeric input and SHALL treat empty or non-numeric input as `0.00` before issuing the database UPDATE, preventing `NaN` or invalid values from being stored.
