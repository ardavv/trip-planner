# Implementation Plan: Realtime Trip Planner

## Overview

Implement a collaborative, realtime travel-planning feature at `/trip/[slug]` on Next.js 16.2+ (App Router) with Supabase as the backend. The build is broken into eight phases: database initialisation, project setup, trip routing, collaborative place board, geolocation maps, ephemeral location pings, per-place budget tracking, and photo/review functionality. Each phase builds on the previous so nothing is left orphaned.

---

## Tasks

### Phase 1 — Database Initialisation & RPCs

- [ ] 1. Create Supabase schema migrations
  - [ ] 1.1 Create `visit_status` enum, `trips` table, and `places` table
    - Define `visit_status` enum: `TODO`, `CURRENT`, `DONE`
    - Create `trips` table with columns: `id UUID PK`, `slug TEXT UNIQUE NOT NULL`, `title TEXT NOT NULL`, `description TEXT`, `created_at TIMESTAMPTZ DEFAULT now()`, `updated_at TIMESTAMPTZ DEFAULT now()`; add `trips_slug_idx` index on `slug`
    - Create `places` table with columns: `id UUID PK`, `trip_id UUID FK → trips(id) ON DELETE CASCADE`, `name TEXT NOT NULL`, `status visit_status NOT NULL DEFAULT 'TODO'`, `order_index DOUBLE PRECISION NOT NULL DEFAULT 0.0`, `lat DOUBLE PRECISION`, `lng DOUBLE PRECISION`, `image_url TEXT`, `estimated_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00`, `actual_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00`, `created_at TIMESTAMPTZ DEFAULT now()`, `updated_at TIMESTAMPTZ DEFAULT now()`; add composite index `places_trip_id_order_idx ON places (trip_id, order_index ASC)`
    - _Requirements: 1.1, 9.1, 11.1_

  - [ ] 1.2 Create `reviews` table and `set_updated_at` trigger
    - Create `reviews` table with columns: `id UUID PK`, `place_id UUID FK → places(id) ON DELETE CASCADE`, `user_name TEXT NOT NULL`, `comment TEXT NOT NULL`, `created_at TIMESTAMPTZ DEFAULT now()`; add `reviews_place_id_idx` on `(place_id, created_at ASC)`
    - Implement `set_updated_at()` trigger function in `plpgsql`; attach `BEFORE UPDATE` triggers to both `trips` and `places`
    - _Requirements: 6.3_

  - [ ] 1.3 Implement `set_place_current` RPC
    - Write `CREATE OR REPLACE FUNCTION set_place_current(p_place_id UUID, p_trip_id UUID) RETURNS VOID` with `SECURITY DEFINER`
    - Within a single transaction: UPDATE all places in `p_trip_id` with `status = 'CURRENT'` AND `id <> p_place_id` → set `status = 'DONE'`; then UPDATE target place → set `status = 'CURRENT'`
    - _Requirements: 3.2, 3.3_

  - [ ]* 1.4 Write property test for `set_place_current` invariant
    - **Property 3: set_place_current invariant — at most one CURRENT per trip**
    - Model the RPC logic as a pure TypeScript function; use `fc.array(placeArb)` with arbitrary status combinations; assert exactly one `CURRENT` after each call
    - **Validates: Requirement 3.3**

  - [ ] 1.5 Apply RLS policies and create `trip-photos` Storage bucket
    - Enable RLS on `trips`, `places`, `reviews`
    - Add permissive SELECT policies on all three tables and a permissive ALL/INSERT policy on `places` and `reviews`
    - Create `trip-photos` Storage bucket with `public: true`
    - _Requirements: 7.4_


---

### Phase 2 — Project Setup & Supabase Connection

- [ ] 2. Configure TypeScript types, dependencies, and test tooling
  - [ ] 2.1 Create `lib/types.ts` with all shared TypeScript types
    - Export `VisitStatus = 'TODO' | 'CURRENT' | 'DONE'`
    - Export `Trip`, `Place` (including `estimated_cost: number` and `actual_cost: number`), `Review`, and `PingMarker` interfaces exactly as specified in the design Data Models section
    - _Requirements: 8.5_

  - [ ] 2.2 Rename root `middleware.ts` → `proxy.ts` with exported function renamed to `proxy`
    - Move session-refresh logic from the Next.js convention file `middleware.ts` at project root to `proxy.ts`; rename the default or named export to `proxy` per the Next.js 16 breaking change
    - Verify `lib/middleware.ts` remains untouched (it is a utility module, not a convention file)
    - _Requirements: 8.1_

  - [ ] 2.3 Verify `lib/client.ts` and `lib/server.ts` Supabase client helpers
    - Confirm `lib/client.ts` exports a `createClient()` function using `createBrowserClient` (singleton pattern — not recreated on every render)
    - Confirm `lib/server.ts` exports an async `createClient()` function using `createServerClient` with Next.js `cookies()` from `next/headers`
    - _Requirements: 10.5_

  - [ ] 2.4 Install all required new dependencies
    - Run: `npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities react-leaflet leaflet`
    - Run: `npm install -D @types/leaflet fast-check vitest @vitest/coverage-v8 @testing-library/react @testing-library/user-event jsdom`
    - _Requirements: 2.1, 4.1_

  - [ ] 2.5 Configure `vitest.config.ts` and `vitest.setup.ts`
    - Create `vitest.config.ts` at project root: `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./vitest.setup.ts']`
    - Create `vitest.setup.ts`: mock `leaflet` and `react-leaflet` modules so Leaflet's browser-only globals do not break the jsdom test environment
    - _Requirements: 4.1, 4.2_


---

### Phase 3 — Core Trip Routing

- [ ] 3. Build the `app/trip/[slug]/` route segment
  - [ ] 3.1 Create `_lib/queries.ts` with `fetchTrip` and `fetchPlaces`
    - Implement `fetchTrip(supabase, slug: string): Promise<Trip | null>` — queries `trips` table WHERE `slug = slug`, returns single row or `null`
    - Implement `fetchPlaces(supabase, tripId: string): Promise<Place[]>` — queries `places` table WHERE `trip_id = tripId` ORDER BY `order_index ASC`
    - Both functions accept a Supabase server client instance (created by the caller via `lib/server.ts`)
    - _Requirements: 1.1, 1.4, 8.2_

  - [ ] 3.2 Create `page.tsx` as an async Server Component
    - Add `type Props = { params: Promise<{ slug: string }> }`; `await params` before any query (Next.js 16 mandatory async params)
    - Implement `generateMetadata({ params }: Props): Promise<Metadata>` — derive `title` and `description` from the trip row; return `{ title: 'Trip Not Found' }` if trip is null
    - In the default export: call `fetchTrip`; if null call `notFound()`; call `fetchPlaces`; render `<TripShell trip={trip} initialPlaces={places} slug={slug} />`
    - No `'use client'` directive — this must be a pure Server Component
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 8.6_

  - [ ] 3.3 Create `loading.tsx`, `error.tsx`, and `not-found.tsx`
    - `loading.tsx`: render a skeleton card grid that matches the approximate layout of the place board (streamed immediately while server fetch is in progress)
    - `error.tsx`: add `'use client'` directive; implement an error boundary component with a reset button
    - `not-found.tsx`: render a user-friendly 404 message for unmatched slugs
    - _Requirements: 1.3, 1.5, 8.1_


---

### Phase 4 — Collaborative Place Board

- [ ] 4. Implement `TripShell`, `PlaceBoard`, `PlaceCard`, and `StatusControl`
  - [ ] 4.1 Create `TripShell.tsx` (Client Component — places state owner)
    - Add `'use client'` directive
    - Accept props `{ trip: Trip; initialPlaces: Place[]; slug: string }`
    - Own `places` state via `useState(initialPlaces)` and `isSyncing` state via `useState(false)`
    - Derive `totalEstimated` and `totalActual` via `.reduce()` on every render (not stored in state)
    - Render `<BudgetSummary totalEstimated={totalEstimated} totalActual={totalActual} />`, `<PlaceBoard>`, `<MapWrapper>`, and `<PingService>`; pass `onPlacesChange` callback to `PlaceBoard`
    - _Requirements: 11.5, 11.6, 8.3_

  - [ ]* 4.2 Write property test for budget total computation
    - **Property 13: Budget totals equal the sum of individual place costs**
    - Use `fc.array(fc.record({ estimated_cost: fc.float({ min: 0, max: 1e6 }), actual_cost: fc.float({ min: 0, max: 1e6 }) }))` to generate arbitrary place arrays; assert `totalEstimated` equals exact sum and `totalActual` equals exact sum; assert both are `0` for empty array
    - **Validates: Requirements 11.5, 11.6**

  - [ ] 4.3 Create `PlaceBoard.tsx` (Client Component — DnD + Realtime)
    - Add `'use client'` directive
    - Render `@dnd-kit/core` `DndContext` + `@dnd-kit/sortable` `SortableContext` wrapping a list of `PlaceCard` components
    - Implement `computeOrderIndex(prev, next)`: midpoint `(a+b)/2` for two neighbors; `next.order_index / 2` for no-left neighbor; `prev.order_index + 1.0` for no-right neighbor
    - On `dragEnd`: apply optimistic state update first, then issue single-row UPDATE to `places` setting only `order_index`
    - Implement conflict deferral with `pendingWriteRef` and `queuedUpdatesRef`: queue remote UPDATE events that arrive during a pending write; apply them post-resolve, discarding superseded `order_index` values for the same place `id`
    - Implement `needsRebalance`: check if any adjacent pair has a gap < `1e-9`; if yes, run batched UPDATE reassigning `1.0, 2.0, 3.0, …` then broadcast `REBALANCE_TRIGGERED` on `trip-board:[slug]` channel
    - Expose a "Sync" button that re-fetches all places from Supabase and replaces local state
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 4.4 Write property test for `computeOrderIndex` midpoint
    - **Property 1: Midpoint order_index is strictly between its neighbors**
    - Use `fc.float({ min: 0.001, max: 1000 })` pairs where `a < b`; assert `a < midpoint < b`; also test the no-left and no-right neighbor edge cases
    - **Validates: Requirements 2.3, 9.1**

  - [ ] 4.5 Implement Realtime_Channel subscription in `PlaceBoard`
    - Inside `useEffect` with empty dependency array: subscribe to Postgres Changes on `places` table filtered by `trip_id=eq.[tripId]`, event `UPDATE`
    - On UPDATE event: check `pendingWriteRef`; if active, push to `queuedUpdatesRef`; otherwise merge into state (replace by `id`, re-sort by `order_index` ascending)
    - Subscribe to `REBALANCE_TRIGGERED` broadcast on `trip-board:[slug]` channel; on receipt: if not the initiating client, re-fetch full ordered place list and replace state
    - Return cleanup: `supabase.removeChannel(channel)` for both channels
    - _Requirements: 2.4, 2.5, 2.7, 10.1, 10.2_

  - [ ]* 4.6 Write property test for Realtime merge
    - **Property 2: Realtime merge preserves uniqueness and sort order**
    - Use `fc.array(placeArb, { minLength: 1 })` and an arbitrary UPDATE payload; assert every `id` appears exactly once and list is sorted non-decreasing by `order_index`
    - **Validates: Requirement 2.5**

  - [ ]* 4.7 Write property test for rebalance produces evenly spaced values
    - **Property 11: Rebalanced order_index values are evenly spaced with gap ≥ 1.0**
    - Use `fc.array(placeArb, { minLength: 1 })` with arbitrary initial `order_index` values; after applying rebalance assignment, assert values are `1.0, 2.0, …, n.0` and every adjacent gap is exactly `1.0`
    - **Validates: Requirement 9.5**

  - [ ] 4.8 Create `PlaceCard.tsx` (Client Component)
    - Add `'use client'` directive
    - Accept `{ place: Place; tripId: string; isDragging?: boolean }`
    - Render: place `name`, status badge, thumbnail `<img>` (when `image_url` non-null), drag handle (via `@dnd-kit/sortable` `useSortable`), `StatusControl`, `ReviewForm`, `PhotoUploader`
    - _Requirements: 2.8_

  - [ ]* 4.9 Write property test for `PlaceCard` renders required fields
    - **Property 12: Place card renders all required fields from a place object**
    - Use `fc.record({ name: fc.string({ minLength: 1 }), status: fc.oneof(...), image_url: fc.option(fc.webUrl()) })` to generate arbitrary place props; assert rendered output contains the name text, a status badge element, and (when `image_url` non-null) a thumbnail `<img>` with the correct `src`
    - **Validates: Requirement 2.8**

  - [ ] 4.10 Create `StatusControl.tsx` (Client Component)
    - Add `'use client'` directive
    - Accept `{ place: Place; tripId: string; onChange: (status: VisitStatus) => void }`
    - When new selection is `CURRENT`: call `supabase.rpc('set_place_current', { p_place_id: place.id, p_trip_id: tripId })`; on failure roll back status badge and show inline error
    - When new selection is `TODO` or `DONE`: call `supabase.from('places').update({ status }).eq('id', place.id)`
    - _Requirements: 3.1, 3.2, 3.5_

- [ ] 5. Checkpoint — Ensure all Phase 1–4 tests pass, ask the user if questions arise.


---

### Phase 5 — Client-Side Geolocation & Leaflet Maps

- [ ] 6. Build `MapWrapper` and `MapViewer`
  - [ ] 6.1 Create `MapWrapper.tsx` (Client Component — SSR bypass)
    - Add `'use client'` directive
    - Use `next/dynamic(() => import('./MapViewer'), { ssr: false })` to produce a `MapViewer` constant
    - Accept `{ places: Place[]; pingMarkers?: PingMarker[] }` and forward all props to the dynamic `MapViewer`
    - This wrapper is the only entry point to `MapViewer`; no Server Component may import `MapViewer` directly
    - _Requirements: 4.1, 4.2, 8.4_

  - [ ] 6.2 Create `MapViewer.tsx` (Client Component — react-leaflet)
    - Add `'use client'` directive; import `leaflet/dist/leaflet.css` at the top of this file
    - Accept `{ places: Place[]; pingMarkers?: PingMarker[] }`
    - Render a `MapContainer`; for each place where both `lat` and `lng` are non-null, render a `Marker` with a `DivIcon` colored red (`TODO`), yellow (`CURRENT`), or green (`DONE`)
    - Attach a `Popup` to each marker displaying `place.name` and `place.status`
    - On mount: call `map.fitBounds(bounds)` over all non-null coordinates using a `ref` callback or `useMap` hook
    - If all places have null coordinates, render `<p>No mappable locations available.</p>` instead of the map
    - Render `pingMarkers` as animated pulsing markers; remove each automatically after 30 seconds via `setTimeout`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [ ]* 6.3 Write property test for map marker count
    - **Property 4: Map marker count equals non-null coordinate place count**
    - Use `fc.array(placeArb)` with `fc.option(fc.float(-90, 90))` for `lat`/`lng`; assert rendered marker count equals count of places where both `lat` and `lng` are non-null
    - **Validates: Requirement 4.3**

  - [ ]* 6.4 Write property test for map marker color by status
    - **Property 5: Map marker color is determined solely by visit status**
    - For each place with non-null lat/lng and arbitrary status, assert the rendered `DivIcon` class/color matches the status-to-color mapping: `TODO → red`, `CURRENT → yellow`, `DONE → green`
    - **Validates: Requirement 4.4**


---

### Phase 6 — Ephemeral Location Ping

- [ ] 7. Create `PingService.tsx` (Client Component)
  - [ ] 7.1 Implement Broadcast_Channel subscription and ping sending
    - Add `'use client'` directive
    - Accept `{ slug: string }`; initialise `useState<PingMarker[]>` for active ping markers
    - In `useEffect([slug])`: create Supabase browser client; subscribe to `trip-ping:[slug]` Broadcast_Channel, listening for `location_ping` events
    - On received ping: generate a client-side `id`, compute `expiresAt = Date.now() + 30_000`, append `PingMarker` to state; schedule `setTimeout` to remove it after 30 seconds
    - Return cleanup: `supabase.removeChannel(channel)` and cancel any pending geolocation watch
    - _Requirements: 5.1, 5.5, 5.8, 10.3, 10.4_

  - [ ] 7.2 Implement ping button and geolocation broadcast
    - On ping button click: call `navigator.geolocation.getCurrentPosition(onSuccess, onError, { timeout: 10000 })`
    - `onSuccess`: broadcast `{ type: 'broadcast', event: 'location_ping', payload: { lat, lng, sender_label, sent_at: new Date().toISOString() } }` — NO database writes
    - `onError` / timeout: display descriptive inline error message and show a Retry button
    - If `navigator.geolocation` is undefined: display "Location sharing is unsupported on this device" and disable the ping button
    - _Requirements: 5.2, 5.3, 5.4, 5.6, 5.7_

  - [ ]* 7.3 Write property test for ping broadcast payload shape
    - **Property 6: Ping broadcast message contains all required fields with valid types**
    - Use `fc.float(-90, 90)`, `fc.float(-180, 180)`, `fc.string()` arbitraries; assert constructed payload has numeric `lat`, numeric `lng`, string `sender_label`, and `sent_at` parseable by `new Date()` without producing `NaN`
    - **Validates: Requirement 5.3**


---

### Phase 7 — Per-Place Budget Tracking

- [ ] 8. Add cost inputs to `PlaceCard` and create `BudgetSummary`
  - [ ] 8.1 Add `estimated_cost` and `actual_cost` inputs to `PlaceCard`
    - Add two labeled number inputs to the `PlaceCard` render output, pre-populated with `place.estimated_cost` and `place.actual_cost`
    - Store a `committedCost` ref (`useRef<{ estimated: number; actual: number }>`) initialised from the place prop
    - On `onBlur` or Enter key press: sanitise the raw input value (empty string or non-numeric → `0.00`; negative → `0.00`; otherwise round to 2 decimal places); issue a single-row UPDATE to `places` setting only the changed column
    - On UPDATE failure: display inline error below the affected input; restore input value from `committedCost` ref
    - On UPDATE success: update `committedCost` ref with the new value
    - _Requirements: 11.2, 11.3, 11.7, 11.8_

  - [ ]* 8.2 Write property test for cost input sanitisation
    - **Property 14: Cost input sanitisation rejects non-numeric and produces 0.00 for empty/NaN**
    - Use `fc.oneof(fc.string(), fc.float({ noNaN: false }), fc.constant(''), fc.constant('-5'))` as arbitrary inputs; assert sanitise function returns `0.00` for empty/NaN/negative and the parsed 2-decimal value otherwise; assert return value is never `NaN`, `Infinity`, or negative
    - **Validates: Requirement 11.8**

  - [ ] 8.3 Create `BudgetSummary.tsx` (Client Component)
    - Add `'use client'` directive
    - Accept `{ totalEstimated: number; totalActual: number }`; render a sticky bar (`position: sticky; top: 0`)
    - Display "Estimated: [value]" and "Actual: [value]" using `Intl.NumberFormat` for locale-aware currency formatting
    - Component is purely props-driven — no `useState`, no `useEffect`, no data fetching
    - _Requirements: 11.6_

  - [ ] 8.4 Wire `BudgetSummary` into `TripShell` and confirm Realtime cost propagation
    - Confirm `TripShell` passes `totalEstimated` and `totalActual` (derived from `.reduce()`) to `BudgetSummary`
    - Confirm that when the Realtime_Channel delivers a cost UPDATE for a place, `PlaceBoard` calls `onPlacesChange` which updates `TripShell` state, causing `BudgetSummary` to recompute without disrupting active drag operations or cost edits
    - _Requirements: 11.4, 11.5, 11.6_

- [ ] 9. Checkpoint — Ensure all Phase 5–8 tests pass, ask the user if questions arise.


---

### Phase 8 — Photo Uploads & Dual-Reviews

- [ ] 10. Create `PhotoUploader.tsx` (Client Component)
  - [ ] 10.1 Implement file validation and upload logic
    - Add `'use client'` directive
    - Accept `{ tripId: string; placeId: string; onImageUploaded: (url: string) => void }`
    - Render `<input type="file" accept="image/*" capture="environment" />`
    - On file selection: validate `file.type.startsWith('image/')` AND `file.size <= 10 * 1024 * 1024`; if invalid, display descriptive error and clear the input without uploading
    - If valid: disable the input, show progress indicator, upload to `trip-photos` bucket at path `${tripId}/${placeId}/${crypto.randomUUID()}.${ext}`
    - On success: call `supabase.storage.from('trip-photos').getPublicUrl(path)`, then UPDATE `places.image_url` with the returned public URL; call `onImageUploaded(url)`; restore input
    - On failure: call `supabase.storage.from('trip-photos').remove([path])` to clean up the partial object; display error; restore input
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [ ]* 10.2 Write property test for photo file validation
    - **Property 9: Photo file validation accepts `image/*` files under 10 MB and rejects all others**
    - Use `fc.record({ type: fc.string(), size: fc.nat({ max: 20 * 1024 * 1024 }) })` to generate arbitrary file-like objects; assert the pure validation function returns `true` iff `type.startsWith('image/')` AND `size <= 10485760`, and `false` otherwise
    - **Validates: Requirement 7.2**

  - [ ]* 10.3 Write property test for storage upload path pattern
    - **Property 10: Storage upload path matches the prescribed pattern**
    - Use `fc.uuid()` for `tripId` and `placeId`, and `fc.string({ minLength: 1 })` for `ext`; assert the constructed path matches `^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$`
    - **Validates: Requirement 7.4**

- [ ] 11. Create `ReviewForm.tsx` (Client Component)
  - [ ] 11.1 Implement dual-input review form and submission logic
    - Add `'use client'` directive
    - Accept `{ placeId: string; initialReviews: Review[] }`
    - Render two labeled text inputs (labels default to "Person 1" / "Person 2"); maintain local `reviewText` state `['', '']`
    - On submit: trim both values; if both are empty, block submission (show validation message); otherwise insert one `reviews` row per non-empty comment containing `user_name`, `comment`, `place_id` (server generates `created_at`)
    - On success: clear only the submitted fields; append new review(s) to displayed list
    - On failure: preserve input text; show descriptive error message
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6_

  - [ ] 11.2 Implement reviews display sorted by `created_at` ascending
    - Display existing reviews sorted by `created_at` ASC; show `user_name`, `comment`, and a human-readable relative timestamp (e.g. "2 hours ago")
    - Newly inserted reviews are appended to the list immediately without a full page reload
    - _Requirements: 6.5, 6.6_

  - [ ]* 11.3 Write property test for review submission count
    - **Property 7: Review submission inserts exactly the non-empty comments**
    - Use `fc.tuple(fc.string(), fc.string())` to generate arbitrary `[c1, c2]` pairs; assert the number of `reviews` rows that would be inserted equals the count of comments where `c.trim().length > 0`; assert that when both are whitespace-only, `k = 0` and insertion is blocked
    - **Validates: Requirements 6.2, 6.3**

  - [ ]* 11.4 Write property test for reviews display order
    - **Property 8: Reviews are displayed in ascending `created_at` order**
    - Use `fc.array(fc.record({ created_at: fc.date().map(d => d.toISOString()), ...otherFields }))` with arbitrary timestamp arrays; assert that for any adjacent pair of displayed reviews `r_i` and `r_{i+1}`, `r_i.created_at <= r_{i+1}.created_at`
    - **Validates: Requirement 6.5**

- [ ] 12. Final checkpoint — Ensure all tests pass, ask the user if questions arise.


---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP, but each maps to a named Correctness Property in the design document
- Every top-level task (1–12) is a required implementation milestone; only sub-tasks carry the `*` marker
- All Supabase client usage in Client Components MUST use the browser singleton from `lib/client.ts` — never `createServerClient` on the client, never instantiate a new client on every render
- The `MapViewer` component MUST only be referenced through `MapWrapper`'s `dynamic()` call — importing it directly from any Server Component will cause a `ReferenceError: window is not defined` build failure
- `params` in `page.tsx` and `generateMetadata` MUST be awaited — synchronous access is removed in Next.js 16 and will throw at runtime
- The root `proxy.ts` (renamed from `middleware.ts`) is the Next.js convention file; `lib/middleware.ts` is a utility module and must NOT be renamed
- All 14 design Correctness Properties are covered by property-based test sub-tasks (Properties 1–14); the `fast-check` library is used for all PBT tasks

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["1.3", "2.2", "2.3", "2.4"] },
    { "id": 2, "tasks": ["1.4", "1.5", "2.5", "3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3"] },
    { "id": 6, "tasks": ["4.4", "4.5", "4.8"] },
    { "id": 7, "tasks": ["4.6", "4.7", "4.9", "4.10", "6.1"] },
    { "id": 8, "tasks": ["6.2", "7.1"] },
    { "id": 9, "tasks": ["6.3", "6.4", "7.2", "7.3", "8.1"] },
    { "id": 10, "tasks": ["8.2", "8.3"] },
    { "id": 11, "tasks": ["8.4", "10.1", "11.1"] },
    { "id": 12, "tasks": ["10.2", "10.3", "11.2"] },
    { "id": 13, "tasks": ["11.3", "11.4"] }
  ]
}
```
