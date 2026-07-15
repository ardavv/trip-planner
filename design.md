# Design Document: Realtime Trip Planner

## Overview

The Realtime Trip Planner is a collaborative travel-planning feature served at `/trip/[slug]`. It combines server-side initial data loading (Next.js 16 App Router Server Components) with client-side interactivity via Supabase Realtime, drag-and-drop reordering, live map rendering, peer-to-peer location pinging, dual-user reviews, and mobile photo uploads.

**Key architectural decisions:**
- Trip Page is a pure Server Component — fetches trip + places once on the server, streams HTML to the client.
- All client-side interactivity lives in colocated `_components/` Client Components that subscribe to Supabase Realtime after hydration.
- Leaflet (browser-only) is loaded exclusively via `next/dynamic({ ssr: false })` from a `'use client'` wrapper — never imported directly by any Server Component.
- `params` is always awaited (`await params`) before any Supabase query, per the Next.js 16 mandatory async params convention.
- The `middleware` file (session refresh) follows the new `proxy` naming convention from Next.js 16.

### Research Findings

**Next.js 16 breaking changes applied in this design:**
- `params` and `searchParams` are `Promise<…>` — synchronous access is fully removed; `await params` is mandatory.
- `middleware.ts` is renamed to `proxy.ts` with exported function renamed to `proxy`.
- Turbopack is default for `next dev` and `next build`; no webpack config needed for this project.
- `revalidateTag` now requires a second `cacheLife` argument. Not used in this feature (realtime replaces cache invalidation).
- `ssr: false` in `next/dynamic` must be used inside a Client Component (not a Server Component) — enforced by colocating the wrapper.

**Supabase Realtime patterns:**
- Postgres Changes: filter by `event = 'UPDATE'`, `schema = 'public'`, `table = 'places'`, `filter = trip_id=eq.[id]`.
- Broadcast: ephemeral, no DB persistence; channel name `trip-ping:[slug]`; cleanup via `supabase.removeChannel(channel)`.
- Browser client from `lib/client.ts` is created once via module-level singleton pattern inside the component to avoid recreating on every render.

**Fractional indexing:**
- `DOUBLE PRECISION` (64-bit IEEE 754) gives ~15 significant decimal digits of precision.
- Midpoint formula: `(a + b) / 2`. Precision exhaustion threshold: gap < `1e-9`.
- Rebalance: reassign `1.0, 2.0, 3.0, …` via a batched UPDATE, then broadcast a single `REBALANCE_TRIGGERED` event over the Broadcast Channel so all connected clients perform one full re-fetch instead of processing `n` individual Postgres Changes UPDATE events.

**react-leaflet + Next.js:**
- Leaflet accesses `window` and `document` at import time; SSR execution causes `ReferenceError`.
- Solution: `dynamic(() => import('./MapViewer'), { ssr: false })` inside a Client Component.
- Leaflet CSS must also be imported inside the client-only component to avoid server rendering it.


---

## Architecture

### Server / Client Boundary Map

```
Request: GET /trip/paris-2025
│
├── [Server] app/trip/[slug]/page.tsx  (async Server Component)
│   ├── await params  → { slug }
│   ├── _lib/fetchTrip(slug)           ← createClient() from lib/server.ts
│   ├── _lib/fetchPlaces(tripId)       ← createClient() from lib/server.ts
│   ├── notFound() if trip is null
│   └── renders → <TripShell trip={trip} initialPlaces={places} slug={slug} />
│
├── [Server] app/trip/[slug]/loading.tsx
│   └── Skeleton card grid (Suspense boundary, streamed immediately)
│
├── [Server] app/trip/[slug]/not-found.tsx
│   └── 404 UI
│
└── [Client] _components/TripShell.tsx  ('use client')
    ├── useState: places[], isSyncing
    ├── PlaceBoard  ← Realtime_Channel (Postgres Changes)
    ├── MapWrapper  ← dynamic(MapViewer, {ssr:false})
    └── PingService ← Broadcast_Channel (trip-ping:[slug])
```

### Data Flow

```
Server fetch (SSR)
     │
     ▼
initialPlaces ──► PlaceBoard state (useState)
                       │
          ┌────────────┼────────────────┐
          ▼            ▼                ▼
   DnD reorder    Status update    Realtime UPDATE
   (optimistic)   (RPC/direct)     (merge + re-sort)
          │
          ▼
   Supabase DB ──► Realtime ──► all other connected clients
```

### Component Hierarchy

```
app/trip/[slug]/page.tsx          [Server Component]
  └─ TripShell                    [Client Component, 'use client']
       ├─ BudgetSummary           [Client Component, 'use client'] ← sticky cost totals
       ├─ PlaceBoard              [Client Component, 'use client']
       │    ├─ PlaceCard (×n)     [Client Component, 'use client']
       │    │    ├─ StatusControl
       │    │    ├─ ReviewForm    [Client Component, 'use client']
       │    │    └─ PhotoUploader [Client Component, 'use client']
       │    └─ SyncButton
       ├─ MapWrapper              [Client Component, 'use client']
       │    └─ MapViewer          [Client Component, dynamic, ssr:false]
       └─ PingService             [Client Component, 'use client']
```


---

## Components and Interfaces

### Trip Page (`app/trip/[slug]/page.tsx`)

```typescript
// Server Component — NO 'use client' directive
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/server'
import { fetchTrip, fetchPlaces } from './_lib/queries'
import TripShell from './_components/TripShell'

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const supabase = await createClient()
  const { data: trip } = await supabase
    .from('trips').select('title, description').eq('slug', slug).single()
  if (!trip) return { title: 'Trip Not Found' }
  return { title: trip.title, description: trip.description ?? undefined }
}

export default async function TripPage({ params }: Props) {
  const { slug } = await params
  const supabase = await createClient()
  const trip = await fetchTrip(supabase, slug)   // returns null if not found
  if (!trip) notFound()
  const places = await fetchPlaces(supabase, trip.id)
  return <TripShell trip={trip} initialPlaces={places} slug={slug} />
}
```

### `_lib/queries.ts`

```typescript
// Private server-side helpers — NOT routable (underscore convention)
export async function fetchTrip(supabase, slug: string): Promise<Trip | null>
export async function fetchPlaces(supabase, tripId: string): Promise<Place[]>
  // ORDER BY order_index ASC
```

### `TripShell` (Client Component)

Props: `{ trip: Trip; initialPlaces: Place[]; slug: string }`

Owns the authoritative `places` state that both `PlaceBoard` and `MapWrapper` read from. Provides a `onPlacesChange(updater)` callback passed down to PlaceBoard.

Derives budget totals via `.reduce()` over `places`:
```typescript
const totalEstimated = places.reduce((sum, p) => sum + p.estimated_cost, 0)
const totalActual    = places.reduce((sum, p) => sum + p.actual_cost, 0)
```
Renders a sticky `BudgetSummary` component (below the page header) displaying these two aggregated values. The component re-renders automatically whenever `places` state changes.

### `BudgetSummary` (Client Component)

Props: `{ totalEstimated: number; totalActual: number }`

- Renders a sticky bar (e.g., `position: sticky; top: 0`) visible at all scroll depths.
- Displays "Estimated: [formatted value]" and "Actual: [formatted value]" using `Intl.NumberFormat` for locale-aware currency display.
- Receives pre-computed totals as props — performs no data fetching or `.reduce()` itself.
- Re-renders purely from prop changes driven by `TripShell` state updates.

### `PlaceBoard` (Client Component)

Props: `{ places: Place[]; tripId: string; onPlacesChange: Dispatcher }`

Responsibilities:
- Renders `@dnd-kit/core` `DndContext` + `SortableContext` with places as sortable items.
- Subscribes to Realtime_Channel in `useEffect([], [])` — exactly once on mount.
- On `dragEnd`: calculates new `order_index`, applies optimistic state update, writes to DB.
- On Realtime UPDATE: merges and re-sorts.
- Exposes "Sync" button that re-fetches all places from DB.
- Cleanup: `supabase.removeChannel(channel)` in useEffect return.

### `PlaceCard` (Client Component)

Props: `{ place: Place; tripId: string; isDragging?: boolean }`

Renders: name, status badge, thumbnail, status control (select), drag handle, editable `estimated_cost` input, editable `actual_cost` input.

On `onBlur` or Enter key press of either cost input: issues a single-row UPDATE to `places` setting only the changed cost column. Sanitises the raw input value — empty or non-numeric strings are coerced to `0.00` before the UPDATE. On failure: displays inline error and restores the input to the previously committed value.

### `StatusControl` (Client Component)

Props: `{ place: Place; tripId: string; onChange: (status: VisitStatus) => void }`

On CURRENT → calls `supabase.rpc('set_place_current', { p_place_id, p_trip_id })`.
On TODO/DONE → calls `supabase.from('places').update({ status }).eq('id', id)`.

### `MapWrapper` (Client Component)

```typescript
'use client'
import dynamic from 'next/dynamic'
const MapViewer = dynamic(() => import('./MapViewer'), { ssr: false })
export default function MapWrapper({ places }: { places: Place[] }) {
  return <MapViewer places={places} />
}
```

### `MapViewer` (Client Component, loaded via dynamic)

Props: `{ places: Place[]; pingMarkers?: PingMarker[] }`

- Imports `leaflet/dist/leaflet.css` inside this file (client-only).
- Renders `MapContainer`, one `Marker` per place with non-null lat/lng, `Popup` on click.
- Pin icons: red (TODO), yellow (CURRENT), green (DONE) — using Leaflet `DivIcon` or custom icon URLs.
- On mount: calls `map.fitBounds(bounds)` over all non-null coordinates.
- If all coordinates null: renders a `<p>No mappable locations available.</p>` fallback.
- Also renders `pingMarkers` as animated pulsing markers that auto-remove after 30s.

### `PingService` (Client Component)

Props: `{ slug: string; mapRef?: RefObject<LeafletMap> }`

- Subscribes to `trip-ping:[slug]` Broadcast_Channel in `useEffect([slug])`.
- On ping button click: calls `navigator.geolocation.getCurrentPosition` (timeout: 10000ms).
- On success: broadcasts `{ type: 'location_ping', lat, lng, sender_label, sent_at: new Date().toISOString() }`.
- On received ping: adds animated marker to map for 30s via `setTimeout`.
- Error handling: shows inline error for missing geolocation API or failed/timed-out position.
- Cleanup: `supabase.removeChannel(channel)` + cancel pending geolocation on unmount or slug change.

### `ReviewForm` (Client Component)

Props: `{ placeId: string; initialReviews: Review[] }`

- Two labeled text inputs (configurable names, default "Person 1" / "Person 2").
- Submit validates: at least one non-whitespace comment.
- Inserts one `reviews` row per non-empty comment.
- Displays existing reviews sorted by `created_at` ASC, with relative timestamps.
- On success: clears submitted inputs, appends new review to list.
- On error: preserves input text, shows error message.

### `PhotoUploader` (Client Component)

Props: `{ tripId: string; placeId: string; onImageUploaded: (url: string) => void }`

- File input: `accept="image/*"` `capture="environment"`.
- Validation: `file.type.startsWith('image/')` AND `file.size <= 10 * 1024 * 1024`.
- Upload path: `${tripId}/${placeId}/${crypto.randomUUID()}.${ext}`.
- On success: calls `supabase.storage.from('trip-photos').getPublicUrl(path)`, then updates `places.image_url`.
- On failure: removes partial upload via `supabase.storage.from('trip-photos').remove([path])`.
- Shows progress indicator; disables input during upload.


---

## Data Models

### TypeScript Types

```typescript
// lib/types.ts  (shared across server and client)

export type VisitStatus = 'TODO' | 'CURRENT' | 'DONE'

export interface Trip {
  id: string            // uuid
  slug: string          // text, unique
  title: string
  description: string | null
  created_at: string    // ISO 8601
  updated_at: string
}

export interface Place {
  id: string            // uuid
  trip_id: string       // uuid, FK → trips.id
  name: string
  status: VisitStatus
  order_index: number   // DOUBLE PRECISION
  lat: number | null
  lng: number | null
  image_url: string | null
  estimated_cost: number  // NUMERIC(15,2), stored as JS number; default 0
  actual_cost: number     // NUMERIC(15,2), stored as JS number; default 0
  created_at: string
  updated_at: string
}

export interface Review {
  id: string            // uuid
  place_id: string      // uuid, FK → places.id
  user_name: string
  comment: string
  created_at: string
}

export interface PingMarker {
  id: string            // generated client-side
  lat: number
  lng: number
  sender_label: string
  sent_at: string       // ISO 8601
  expiresAt: number     // Date.now() + 30_000
}
```

### Database Schema (SQL)

```sql
-- Enum
CREATE TYPE visit_status AS ENUM ('TODO', 'CURRENT', 'DONE');

-- trips
CREATE TABLE trips (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trips_slug_idx ON trips (slug);

-- places
CREATE TABLE places (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      visit_status NOT NULL DEFAULT 'TODO',
  order_index DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  image_url   TEXT,
  estimated_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  actual_cost    NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX places_trip_id_order_idx ON places (trip_id, order_index ASC);

-- reviews
CREATE TABLE reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id    UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_name   TEXT NOT NULL,
  comment     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reviews_place_id_idx ON reviews (place_id, created_at ASC);

-- updated_at trigger (applied to trips and places)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER trips_updated_at BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER places_updated_at BEFORE UPDATE ON places
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### RPC: `set_place_current`

```sql
CREATE OR REPLACE FUNCTION set_place_current(p_place_id UUID, p_trip_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Atomically demote any existing CURRENT to DONE in the same trip
  UPDATE places
  SET status = 'DONE', updated_at = now()
  WHERE trip_id = p_trip_id
    AND status = 'CURRENT'
    AND id <> p_place_id;
  -- Promote the target place to CURRENT
  UPDATE places
  SET status = 'CURRENT', updated_at = now()
  WHERE id = p_place_id
    AND trip_id = p_trip_id;
END;
$$;
```

The two UPDATEs run in a single transaction inside the plpgsql block. This guarantees the "at most one CURRENT per trip" invariant regardless of concurrent client writes.

### Row-Level Security (RLS)

```sql
-- Enable RLS (authentication is out of scope; policies below allow public access
-- for a shareable trip link. Tighten with auth.uid() checks as needed.)
ALTER TABLE trips    ENABLE ROW LEVEL SECURITY;
ALTER TABLE places   ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews  ENABLE ROW LEVEL SECURITY;

-- Permissive policies (adjust for production auth)
CREATE POLICY "public read trips"   ON trips   FOR SELECT USING (true);
CREATE POLICY "public read places"  ON places  FOR SELECT USING (true);
CREATE POLICY "public write places" ON places  FOR ALL    USING (true);
CREATE POLICY "public read reviews" ON reviews FOR SELECT USING (true);
CREATE POLICY "public write reviews"ON reviews FOR INSERT WITH CHECK (true);
```

### Storage Bucket

```
Bucket: trip-photos   (public: true)
Path convention: {trip_id}/{place_id}/{uuid}.{ext}
```


---

## File / Folder Structure

```
app/
└── trip/
    └── [slug]/
        ├── page.tsx           # Async Server Component — trip data fetch, generateMetadata
        ├── loading.tsx        # Skeleton UI (Suspense boundary for streaming)
        ├── error.tsx          # Error boundary for runtime errors
        ├── not-found.tsx      # 404 boundary; rendered when notFound() is called
        ├── _lib/
        │   └── queries.ts     # fetchTrip, fetchPlaces — server-only helpers (not routable)
        └── _components/
            ├── TripShell.tsx  # 'use client' — owns places state; composes board + map + ping
            ├── BudgetSummary.tsx # 'use client' — sticky trip cost totals (derived from places state)
            ├── PlaceBoard.tsx # 'use client' — DnD board, Realtime subscription, Sync
            ├── PlaceCard.tsx  # 'use client' — single place card (draggable)
            ├── StatusControl.tsx # 'use client' — status select, RPC/direct update
            ├── MapWrapper.tsx # 'use client' — dynamic() wrapper for MapViewer
            ├── MapViewer.tsx  # 'use client' — react-leaflet map (never imported by Server)
            ├── PingService.tsx# 'use client' — Broadcast, geolocation, ping UI
            ├── ReviewForm.tsx # 'use client' — dual-review form + review list
            └── PhotoUploader.tsx # 'use client' — camera/file upload + progress

lib/
├── client.ts      # createBrowserClient (unchanged)
├── server.ts      # createServerClient with cookies (unchanged)
├── middleware.ts  # kept for ssr cookie refresh (renamed convention: see note below)
├── types.ts       # Trip, Place, Review, PingMarker, VisitStatus (NEW)
└── utils.ts       # cn() etc. (unchanged)

proxy.ts           # [NEW] Next.js 16 — renamed from middleware.ts per breaking change
                   # (session-refresh logic moved here)
```

> **Note on `middleware` → `proxy`:** Next.js 16 deprecates `middleware.ts` in favour of `proxy.ts` with a renamed export `proxy`. The existing `lib/middleware.ts` helper remains as a utility module (it's not a Next.js convention file). The root `middleware.ts` convention file should be renamed to `proxy.ts` with its exported function renamed accordingly.

### Folder Conventions Rationale

| Convention | Reason |
|---|---|
| `_lib/` private folder | Server helpers are not inadvertently exposed as routes |
| `_components/` private folder | Client components colocated with route, not globally addressable |
| `MapViewer.tsx` in `_components/` | Never imported directly by any Server Component — only via `MapWrapper`'s `dynamic()` call |
| `lib/types.ts` at root | Shared between Server Components (SSR), Client Components, and future API routes |


---

## Supabase Realtime Subscription Patterns

### Postgres Changes (PlaceBoard)

```typescript
// Inside PlaceBoard — useEffect with empty deps array
useEffect(() => {
  const supabase = createClient()  // browser client from lib/client.ts — singleton in module scope

  const channel = supabase
    .channel(`places:${tripId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'places',
        filter: `trip_id=eq.${tripId}`,
      },
      (payload) => {
        const updated = payload.new as Place
        setPlaces((prev) => {
          const merged = prev.map((p) => (p.id === updated.id ? updated : p))
          return [...merged].sort((a, b) => a.order_index - b.order_index)
        })
      }
    )
    .subscribe()

  return () => { supabase.removeChannel(channel) }
}, [])   // empty — subscribe exactly once per mount
```

**Conflict deferral (Requirement 9.3–9.4):**

A `pendingLocalWrite` ref tracks the Promise of the in-flight UPDATE. When a remote UPDATE event arrives within 500ms of a local write, it is queued. Once the local Promise resolves, queued events are applied in arrival order; any event whose `order_index` for the locally-written place is superseded by the local value is discarded.

```typescript
// Simplified conflict deferral sketch
const pendingWriteRef = useRef<Promise<void> | null>(null)
const queuedUpdatesRef = useRef<Place[]>([])

async function handleDragEnd(event: DragEndEvent) {
  const newOrderIndex = computeMidpoint(prev, next)
  // 1. Optimistic update
  setPlaces(applyReorder(places, draggedId, newOrderIndex))
  // 2. Write to DB, track the promise
  const writePromise = supabase.from('places')
    .update({ order_index: newOrderIndex })
    .eq('id', draggedId)
    .then(() => {
      // 3. Apply queued remote updates, discard superseded ones
      const toApply = queuedUpdatesRef.current.filter(
        (u) => !(u.id === draggedId && u.order_index !== newOrderIndex)
      )
      if (toApply.length > 0) {
        setPlaces((prev) => applyMerge(prev, toApply))
      }
      queuedUpdatesRef.current = []
      pendingWriteRef.current = null
    })
  pendingWriteRef.current = writePromise
}

// In the Realtime handler:
if (pendingWriteRef.current) {
  queuedUpdatesRef.current.push(payload.new as Place)
} else {
  setPlaces(/* normal merge + sort */)
}
```

### Broadcast Channel (PingService)

```typescript
useEffect(() => {
  const supabase = createClient()
  const channel = supabase
    .channel(`trip-ping:${slug}`)
    .on('broadcast', { event: 'location_ping' }, ({ payload }) => {
      // Add temporary ping marker to map state
      addPingMarker(payload)
      setTimeout(() => removePingMarker(payload.id), 30_000)
    })
    .subscribe()

  return () => { supabase.removeChannel(channel) }
}, [slug])   // re-subscribe if slug changes
```

Sending a ping:
```typescript
await channel.send({
  type: 'broadcast',
  event: 'location_ping',
  payload: { lat, lng, sender_label, sent_at: new Date().toISOString() },
})
```

No DB writes — all ping data is ephemeral.

### Fractional Indexing Strategy

**Normal reorder** — midpoint between neighbors:
```typescript
function computeOrderIndex(prev: Place | null, next: Place | null): number {
  if (!prev && !next) return 1.0
  if (!prev) return next!.order_index / 2
  if (!next) return prev.order_index + 1.0
  return (prev.order_index + next.order_index) / 2
}
```

**Precision exhaustion detection:**
```typescript
function needsRebalance(places: Place[]): boolean {
  const sorted = [...places].sort((a, b) => a.order_index - b.order_index)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].order_index - sorted[i - 1].order_index < 1e-9) return true
  }
  return false
}
```

**Broadcast-driven rebalance** — when precision exhaustion is detected after a drag operation, the initiating client:

1. Runs the batched UPDATE that reassigns `1.0, 2.0, 3.0, …` across all places in the trip.
2. Immediately broadcasts a single `REBALANCE_TRIGGERED` event over the existing Broadcast Channel (`trip-ping:[slug]` channel is reused, or a dedicated `trip-board:[slug]` channel is used if the ping and board channels are kept separate — see note below).

```typescript
async function rebalancePlaces(
  supabase: SupabaseClient,
  tripId: string,
  slug: string,
  places: Place[],
  boardChannel: RealtimeChannel,
) {
  const sorted = [...places].sort((a, b) => a.order_index - b.order_index)
  const updates = sorted.map((p, i) => ({ id: p.id, order_index: i + 1.0 }))

  // 1. Batched DB write
  await supabase.from('places').upsert(updates)

  // 2. Signal all connected clients to re-fetch — one broadcast, not n Postgres Changes events
  await boardChannel.send({
    type: 'broadcast',
    event: 'REBALANCE_TRIGGERED',
    payload: { trip_id: tripId },
  })
}
```

**Receiving the rebalance signal** — all connected clients (including the initiator itself) listen for `REBALANCE_TRIGGERED` on the same Broadcast Channel and respond with a single full re-fetch instead of processing `n` individual Postgres Changes UPDATE events:

```typescript
// Inside PlaceBoard — additional broadcast listener on the board channel
boardChannel.on('broadcast', { event: 'REBALANCE_TRIGGERED' }, async () => {
  // Ignore if this client is the one that just executed the rebalance
  // (its local state is already correct from the optimistic upsert)
  if (isInitiatingRebalanceRef.current) {
    isInitiatingRebalanceRef.current = false
    return
  }
  // Re-fetch the full ordered list to replace stale local state
  const { data } = await supabase
    .from('places')
    .select('*')
    .eq('trip_id', tripId)
    .order('order_index', { ascending: true })
  if (data) setPlaces(data as Place[])
})
```

> **Channel note:** `PlaceBoard` subscribes to a dedicated `trip-board:[slug]` Broadcast Channel for board-level signals (`REBALANCE_TRIGGERED`). `PingService` subscribes to `trip-ping:[slug]`. Keeping them separate avoids event-type collisions and makes cleanup boundaries explicit. Both channels are torn down on unmount via `supabase.removeChannel(channel)`.

**Why this avoids the update storm:** Without this mechanism, a rebalance of `n` places would produce `n` Postgres Changes UPDATE events that every connected client processes individually — potentially triggering `n` state merges and re-renders per client. With the broadcast signal, each remote client performs exactly one re-fetch and one state replacement, regardless of how many rows were rebalanced.


---

## State Management Approach

There is no global state library. State is local React state (`useState`, `useRef`) organized at the `TripShell` level, with prop drilling one level down to children.

| State | Owner | Mechanism |
|---|---|---|
| `places: Place[]` | `TripShell` | `useState(initialPlaces)` — source of truth |
| `totalEstimated: number` | `TripShell` | derived via `.reduce()` on each render — not stored in state |
| `totalActual: number` | `TripShell` | derived via `.reduce()` on each render — not stored in state |
| `pingMarkers: PingMarker[]` | `PingService` | `useState([])` — local, ephemeral |
| `isSyncing: boolean` | `TripShell` | `useState(false)` — manual sync state |
| `pendingLocalWrite` | `PlaceBoard` | `useRef<Promise | null>` — not rendered |
| `queuedRemoteUpdates` | `PlaceBoard` | `useRef<Place[]>` — not rendered |
| `isInitiatingRebalance` | `PlaceBoard` | `useRef<boolean>` — suppresses own re-fetch after rebalance broadcast |
| `uploadProgress` | `PhotoUploader` | `useState(0)` — local, per-component |
| `reviewText[0,1]` | `ReviewForm` | `useState(['',''])` — local form state |
| `committedCost` | `PlaceCard` | `useRef<{estimated: number, actual: number}>` — last successfully saved values; used for rollback on UPDATE failure |

**Realtime merging:**
Remote UPDATE events merge into `TripShell`'s `places` state via the `onPlacesChange` callback passed from `TripShell → PlaceBoard`. The merge function: replace the matching `id`, then sort ascending by `order_index`.

**Optimistic updates:**
Drag reorders apply to local `places` state immediately before the DB write resolves. If the DB write fails, the state is rolled back by re-fetching from the server (same as the manual Sync action).

**No useReducer / Zustand needed:** the state shape is simple (an ordered array of places), and mutations are well-defined (merge-by-id + sort). A dedicated store would add complexity without benefit for this feature scope.

---

## Error Handling

| Scenario | Handling |
|---|---|
| Trip slug not found | `notFound()` in Server Component → HTTP 404 + `not-found.tsx` UI |
| Supabase DB error on fetch | Re-throw from `_lib/queries.ts` → caught by `error.tsx` boundary |
| Drag reorder DB write failure | Rollback optimistic state; show toast; Sync button remains visible |
| `set_place_current` RPC failure | Rollback status badge to previous; show inline error |
| Realtime subscription drop | Supabase SDK auto-reconnects; Sync button allows manual recovery |
| Geolocation unavailable | Inline error: "Location sharing is unsupported on this device" |
| `getCurrentPosition` timeout/error | Inline error with descriptive message + Retry button |
| Photo MIME/size validation failure | Inline error + clear file input; upload never initiated |
| Storage upload failure | Error message + call `storage.remove([path])` to clean up partial object |
| Review insert failure | Error message; preserve both input field values |
| All map coordinates null | Fallback `<p>` message in `MapViewer` |
| Cost UPDATE failure | Inline error on `PlaceCard`; restore input to last committed value from `committedCost` ref |

**Error boundary (`error.tsx`)** — a `'use client'` component wrapping the page-level suspense boundary. Catches unexpected runtime errors (network failures during initial render, Supabase SDK errors thrown during Server Component execution).


---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Midpoint order_index is strictly between its neighbors

*For any* two adjacent places with `order_index` values `a` and `b` where `a < b`, the computed midpoint `(a + b) / 2` SHALL satisfy `a < midpoint < b`. For the no-left-neighbor case (`prev = null`), the result SHALL be `next.order_index / 2 < next.order_index`. For the no-right-neighbor case (`next = null`), the result SHALL be `prev.order_index + 1.0 > prev.order_index`.

**Validates: Requirements 2.3, 9.1**

### Property 2: Realtime merge preserves uniqueness and sort order

*For any* existing place list and any incoming UPDATE payload (with a valid `id` and `order_index`), merging the update into the list SHALL result in a list where every `id` appears exactly once and the list is sorted in strictly non-decreasing order by `order_index`.

**Validates: Requirements 2.5**

### Property 3: set_place_current invariant — at most one CURRENT per trip

*For any* trip containing any number of places with any combination of statuses, after `set_place_current(p_place_id, p_trip_id)` completes, exactly one place in that trip SHALL have `status = 'CURRENT'` (the targeted place), and no other place in that trip SHALL have `status = 'CURRENT'`.

**Validates: Requirements 3.3**

### Property 4: Map marker count equals non-null coordinate place count

*For any* list of places (with a mix of null and non-null `lat`/`lng` values), the `MapViewer` SHALL render exactly as many `Marker` elements as there are places for which both `lat` and `lng` are non-null.

**Validates: Requirements 4.3**

### Property 5: Map marker color is determined solely by visit status

*For any* place with a non-null location, the marker icon color rendered by `MapViewer` SHALL be red if `status = 'TODO'`, yellow if `status = 'CURRENT'`, and green if `status = 'DONE'`.

**Validates: Requirements 4.4**

### Property 6: Ping broadcast message contains all required fields with valid types

*For any* latitude, longitude, and sender label values, the `location_ping` broadcast payload constructed by `PingService` SHALL contain a numeric `lat` field, a numeric `lng` field, a string `sender_label` field, and a `sent_at` field whose value is a valid ISO 8601 timestamp string (parseable by `new Date()` without producing `NaN`).

**Validates: Requirements 5.3**

### Property 7: Review submission inserts exactly the non-empty comments

*For any* pair of comment strings `[c1, c2]`, submitting the `ReviewForm` SHALL insert exactly `k` rows into the `reviews` table, where `k` is the count of comments in `[c1, c2]` that are non-empty after whitespace trimming. If `k = 0` (both whitespace-only), submission SHALL be blocked and no rows inserted.

**Validates: Requirements 6.2, 6.3**

### Property 8: Reviews are displayed in ascending created_at order

*For any* list of existing reviews with arbitrary `created_at` timestamps, the `ReviewForm` SHALL display them ordered such that for any two adjacent displayed reviews `r_i` and `r_{i+1}`, `r_i.created_at <= r_{i+1}.created_at`.

**Validates: Requirements 6.5**

### Property 9: Photo file validation accepts image/* files under 10 MB and rejects all others

*For any* file object, the `PhotoUploader` validation function SHALL accept the file (return `true`) if and only if `file.type.startsWith('image/')` AND `file.size <= 10 * 1024 * 1024` (10,485,760 bytes). All other files SHALL be rejected (return `false`).

**Validates: Requirements 7.2**

### Property 10: Storage upload path matches the prescribed pattern

*For any* `trip_id`, `place_id`, and file with extension `ext`, the storage path constructed by `PhotoUploader` SHALL match the regular expression `^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$` (i.e., `{uuid}/{uuid}/{uuid}.{ext}`).

**Validates: Requirements 7.4**

### Property 11: Rebalanced order_index values are evenly spaced with gap ≥ 1.0

*For any* list of `n` places in a trip after a rebalance operation, the places SHALL be assigned `order_index` values `1.0, 2.0, ..., n.0` in their sorted order, such that every adjacent pair has a gap of exactly `1.0`, which is well above the `1e-9` precision threshold.

**Validates: Requirements 9.5**

### Property 12: Place card renders all required fields from a place object

*For any* `Place` object with a non-empty `name`, a valid `status`, and any `image_url` (including `null`), the rendered `PlaceCard` SHALL display the `name` text, a status badge reflecting `status`, and — when `image_url` is non-null — a thumbnail image element with that URL as its source.

**Validates: Requirements 2.8**

### Property 13: Budget totals equal the sum of individual place costs

*For any* array of `Place` objects with arbitrary non-negative `estimated_cost` and `actual_cost` values, the `totalEstimated` value computed by `TripShell`'s `.reduce()` SHALL equal the exact arithmetic sum of all `estimated_cost` values in the array, and `totalActual` SHALL equal the exact arithmetic sum of all `actual_cost` values. An empty array SHALL yield `0` for both totals.

**Validates: Requirements 11.5, 11.6**

### Property 14: Cost input sanitisation rejects non-numeric and produces 0.00 for empty/NaN

*For any* string value entered into a cost input field, the sanitisation function SHALL return `0.00` if the parsed value is `NaN`, negative, or the empty string, and SHALL return the parsed `number` rounded to two decimal places otherwise. No `NaN`, `Infinity`, or negative value SHALL ever be passed to the Supabase UPDATE.

**Validates: Requirements 11.8**


---

## Testing Strategy

### PBT Library Selection

**[fast-check](https://fast-check.dev/)** — TypeScript-native, integrates with Vitest, supports arbitrary generators for strings, numbers, arrays, and objects. Minimum 100 runs per property (fast-check default is 100, configurable via `numRuns`).

Install: `npm install -D fast-check vitest @testing-library/react @testing-library/user-event jsdom`

### Property-Based Tests

Each property below maps to one `fc.assert(fc.property(…))` test. Tags reference the design properties above.

```typescript
// Feature: realtime-trip-planner, Property 1: Midpoint order_index
// Feature: realtime-trip-planner, Property 2: Realtime merge preserves uniqueness and sort order
// Feature: realtime-trip-planner, Property 3: set_place_current invariant
// Feature: realtime-trip-planner, Property 4: Map marker count
// Feature: realtime-trip-planner, Property 5: Map marker color
// Feature: realtime-trip-planner, Property 6: Ping broadcast message fields
// Feature: realtime-trip-planner, Property 7: Review submission inserts correct count
// Feature: realtime-trip-planner, Property 8: Reviews sorted by created_at
// Feature: realtime-trip-planner, Property 9: Photo file validation
// Feature: realtime-trip-planner, Property 10: Storage path pattern
// Feature: realtime-trip-planner, Property 11: Rebalanced values evenly spaced
// Feature: realtime-trip-planner, Property 12: PlaceCard renders required fields
```

**Arbitraries needed:**
- `fc.float({ min: 0.001, max: 1000 })` for `order_index` values
- `fc.array(placeArb)` for place lists
- `fc.oneof(fc.constant('TODO'), fc.constant('CURRENT'), fc.constant('DONE'))` for status
- `fc.option(fc.float(-90, 90))` and `fc.option(fc.float(-180, 180))` for lat/lng
- `fc.string()` for comment/sender_label
- `fc.date()` for `created_at`

**Property 3 note:** The stored procedure runs in PostgreSQL. The property is best tested using an in-process pure function that models the procedure's logic (keeping the same invariant), plus one integration test against a real Supabase instance or `pg` test database.

### Unit Tests (Example-based)

| Area | Key examples to cover |
|---|---|
| `TripPage` | `generateMetadata` returns correct title + description |
| `TripPage` | `notFound()` called when `fetchTrip` returns null |
| `PlaceBoard` | Drag-end triggers single-row UPDATE with only `order_index` |
| `PlaceBoard` | Remote UPDATE during pending write is queued, applied post-resolve |
| `PlaceBoard` | Unmount calls `supabase.removeChannel` |
| `StatusControl` | CURRENT selection calls RPC; TODO/DONE call direct UPDATE |
| `MapViewer` | Renders fallback message when all coordinates are null |
| `MapViewer` | `fitBounds` called on mount with non-null coordinates |
| `MapViewer` | Popup renders place name and status on marker click |
| `PingService` | `getCurrentPosition` called with `{timeout: 10000}` |
| `PingService` | No DB insert/update called during ping |
| `PingService` | Error shown when geolocation unavailable |
| `PingService` | Marker removed after 30s (fake timers) |
| `PingService` | Unmount removes channel and cancels geolocation |
| `ReviewForm` | Success: inputs cleared, review appended to list |
| `ReviewForm` | Failure: error shown, input text preserved |
| `PhotoUploader` | Success: `getPublicUrl` called, `places.image_url` updated |
| `PhotoUploader` | Failure: `storage.remove` called with the partial path |
| `PhotoUploader` | Input disabled during upload |
| Conflict resolution | Re-fetch triggered after 500ms debounce on conflicting updates |
| Manual Sync | Re-fetch replaces local state with DB data |
| `PlaceCard` | Cost input blur triggers single-row UPDATE with only the changed cost column |
| `PlaceCard` | Empty/non-numeric cost input is coerced to `0.00` before UPDATE |
| `PlaceCard` | Cost UPDATE failure shows inline error and restores input to committed value |
| `BudgetSummary` | Displays correct totals for a given `places` array |
| `BudgetSummary` | Displays `0` totals when `places` is empty |
| `TripShell` | Budget totals recompute when a Realtime cost UPDATE is received |

### Integration Tests (1–3 examples)

| Scope | What to verify |
|---|---|
| Trip routing | `GET /trip/valid-slug` returns 200 with place data |
| Trip routing | `GET /trip/nonexistent` returns 404 |
| Realtime subscription | Place UPDATE event reaches all connected clients |
| `set_place_current` | Only one CURRENT per trip after concurrent calls |
| Storage upload | File lands in correct bucket path, public URL resolves |

### Test Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
})
```

```typescript
// vitest.setup.ts — mock Leaflet (browser-only)
vi.mock('leaflet', () => ({ ... }))
vi.mock('react-leaflet', () => ({ MapContainer: vi.fn(), ... }))
```

---

## New Dependencies to Install

```bash
# Drag-and-drop
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities

# Map
npm install react-leaflet leaflet
npm install -D @types/leaflet

# Property-based testing
npm install -D fast-check

# Testing utilities (if not already present)
npm install -D vitest @vitest/coverage-v8 @testing-library/react @testing-library/user-event jsdom
```

| Package | Version constraint | Purpose |
|---|---|---|
| `@dnd-kit/core` | `^6` | Drag-and-drop primitives for PlaceBoard |
| `@dnd-kit/sortable` | `^8` | Sortable list abstraction |
| `@dnd-kit/utilities` | `^3` | CSS transform utilities |
| `react-leaflet` | `^5` | React bindings for Leaflet maps |
| `leaflet` | `^1.9` | Core map library (loaded client-only) |
| `@types/leaflet` | `^1.9` | TypeScript types for Leaflet |
| `fast-check` | `^3` | Property-based testing framework |
| `vitest` | `^3` | Test runner (Turbopack-compatible) |
| `@testing-library/react` | `^16` | Component testing utilities |
| `@testing-library/user-event` | `^14` | User interaction simulation |
| `jsdom` | `^26` | Browser environment for tests |

> All existing dependencies (`@supabase/supabase-js`, `@supabase/ssr`, `@base-ui/react`, `tailwindcss`, `shadcn`, `lucide-react`) remain unchanged. No new UI component libraries are introduced.

