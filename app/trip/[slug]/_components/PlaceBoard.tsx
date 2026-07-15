'use client'

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/client'
import type { Place } from '@/lib/types'
import PlaceCard from './PlaceCard'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PlaceBoardProps {
  places: Place[]
  tripId: string
  slug: string
  onPlacesChange: Dispatch<SetStateAction<Place[]>>
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit/property testing)
// ---------------------------------------------------------------------------

/**
 * Compute a new `order_index` using fractional indexing.
 *
 * - Two neighbors: midpoint `(a + b) / 2`
 * - No left neighbor (prepend): `next / 2`
 * - No right neighbor (append): `prev + 1.0`
 * - Empty list: `1.0`
 */
export function computeOrderIndex(
  prev: Place | null,
  next: Place | null
): number {
  if (!prev && !next) return 1.0
  if (!prev) return next!.order_index / 2
  if (!next) return prev.order_index + 1.0
  return (prev.order_index + next.order_index) / 2
}

/**
 * Detect precision exhaustion — true when any adjacent pair has a gap < 1e-9.
 * Triggers a rebalance to restore integer-spaced order_index values.
 */
export function needsRebalance(places: Place[]): boolean {
  if (places.length < 2) return false
  const sorted = [...places].sort((a, b) => a.order_index - b.order_index)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].order_index - sorted[i - 1].order_index < 1e-9) return true
  }
  return false
}

/**
 * Merge incoming remote UPDATE(s) into the existing places array:
 * replace by `id`, then re-sort ascending by `order_index`.
 */
function applyMerge(existing: Place[], updates: Place[]): Place[] {
  const map = new Map(existing.map((p) => [p.id, p]))
  for (const u of updates) {
    map.set(u.id, u)
  }
  return [...map.values()].sort((a, b) => a.order_index - b.order_index)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PlaceBoard({
  places,
  tripId,
  slug,
  onPlacesChange,
}: PlaceBoardProps) {
  const [isSyncing, setIsSyncing] = useState(false)

  // Refs for conflict deferral (Requirement 9.3–9.4)
  const pendingWriteRef = useRef<Promise<void> | null>(null)
  const queuedUpdatesRef = useRef<Place[]>([])

  // Ref to suppress own re-fetch after a self-initiated rebalance
  const isInitiatingRebalanceRef = useRef(false)

  // Ref to the broadcast channel so rebalancePlaces() can send on it
  const boardChannelRef = useRef<RealtimeChannel | null>(null)

  // Ref that always holds the latest places for async callbacks
  const placesRef = useRef(places)
  placesRef.current = places

  const supabase = createClient()

  // DnD sensors — 5px distance activation to distinguish clicks from drags
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const [newPlaceName, setNewPlaceName] = useState('')
  const [isAdding, setIsAdding] = useState(false)

  // -------------------------------------------------------------------------
  // Realtime subscription — exactly once per mount (Requirement 10.1, 10.2)
  // -------------------------------------------------------------------------
  useEffect(() => {
    // 1. Postgres Changes — place UPDATE & INSERT events filtered by trip_id
    const handlePgChange = (payload: any) => {
      const changed = payload.new as Place

      // Conflict deferral: if a local write is in-flight, queue the event
      if (pendingWriteRef.current) {
        queuedUpdatesRef.current.push(changed)
      } else {
        onPlacesChange((prev) => applyMerge(prev, [changed]))
      }
    }

    const pgChannel = supabase
      .channel(`places:${tripId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'places', filter: `trip_id=eq.${tripId}` },
        handlePgChange
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'places', filter: `trip_id=eq.${tripId}` },
        handlePgChange
      )
      .subscribe()

    // 2. Broadcast — listen for REBALANCE_TRIGGERED from other clients
    const boardChannel = supabase
      .channel(`trip-board:${slug}`)
      .on('broadcast', { event: 'REBALANCE_TRIGGERED' }, async () => {
        // If this client initiated the rebalance, its local state is already
        // correct — skip the re-fetch.
        if (isInitiatingRebalanceRef.current) {
          isInitiatingRebalanceRef.current = false
          return
        }

        // Full re-fetch replaces stale local state (one fetch instead of n
        // individual Postgres Changes events from the batched UPDATE).
        const { data } = await supabase
          .from('places')
          .select('*')
          .eq('trip_id', tripId)
          .order('order_index', { ascending: true })
        if (data) onPlacesChange(data as Place[])
      })
      .subscribe()

    boardChannelRef.current = boardChannel

    // Cleanup — tear down both channels on unmount
    return () => {
      supabase.removeChannel(pgChannel)
      supabase.removeChannel(boardChannel)
      boardChannelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------------------------------------------------------------
  // Drag-end handler — optimistic reorder + single-row DB write
  // -------------------------------------------------------------------------
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = places.findIndex((p) => p.id === active.id)
    const newIndex = places.findIndex((p) => p.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    // Build the reordered array to compute neighbors
    const reordered = [...places]
    const [moved] = reordered.splice(oldIndex, 1)
    reordered.splice(newIndex, 0, moved)

    const prev = newIndex > 0 ? reordered[newIndex - 1] : null
    const next =
      newIndex < reordered.length - 1 ? reordered[newIndex + 1] : null
    const newOrderIndex = computeOrderIndex(prev, next)
    const draggedId = active.id as string

    // 1. Optimistic update
    onPlacesChange((current) => {
      const updated = current.map((p) =>
        p.id === draggedId ? { ...p, order_index: newOrderIndex } : p
      )
      return [...updated].sort((a, b) => a.order_index - b.order_index)
    })

    // 2. Write to DB, track the promise for conflict deferral
    const writePromise = (async () => {
      try {
        const { error } = await supabase
          .from('places')
          .update({ order_index: newOrderIndex })
          .eq('id', draggedId)

        if (error) throw error

        // 3. Apply queued remote updates, discard superseded order_index
        const toApply = queuedUpdatesRef.current.filter(
          (u) => !(u.id === draggedId && u.order_index !== newOrderIndex)
        )
        if (toApply.length > 0) {
          onPlacesChange((prev) => applyMerge(prev, toApply))
        }
        queuedUpdatesRef.current = []
        pendingWriteRef.current = null

        // 4. Check for precision exhaustion after the write settles
        if (needsRebalance(placesRef.current)) {
          await rebalancePlaces(placesRef.current)
        }
      } catch {
        // Rollback: re-fetch authoritative state from DB
        pendingWriteRef.current = null
        queuedUpdatesRef.current = []
        await handleSync()
      }
    })()

    pendingWriteRef.current = writePromise
  }

  // -------------------------------------------------------------------------
  // Rebalance — reassign integer order_index values + broadcast signal
  // -------------------------------------------------------------------------
  async function rebalancePlaces(currentPlaces: Place[]) {
    isInitiatingRebalanceRef.current = true

    const sorted = [...currentPlaces].sort(
      (a, b) => a.order_index - b.order_index
    )

    // Batched UPDATE — each place gets an integer order_index
    await Promise.all(
      sorted.map((p, i) =>
        supabase
          .from('places')
          .update({ order_index: i + 1.0 })
          .eq('id', p.id)
      )
    )

    // Signal all connected clients to perform a single full re-fetch
    // instead of processing n individual Postgres Changes UPDATE events
    if (boardChannelRef.current) {
      await boardChannelRef.current.send({
        type: 'broadcast',
        event: 'REBALANCE_TRIGGERED',
        payload: { trip_id: tripId },
      })
    }

    // Update local state with the new evenly-spaced values
    onPlacesChange((prev) =>
      prev
        .map((p, _i, _arr) => {
          const sortedIdx = sorted.findIndex((s) => s.id === p.id)
          return sortedIdx !== -1
            ? { ...p, order_index: sortedIdx + 1.0 }
            : p
        })
        .sort((a, b) => a.order_index - b.order_index)
    )
  }

  // -------------------------------------------------------------------------
  // Add Place feature
  // -------------------------------------------------------------------------
  async function handleAddPlace(e: React.FormEvent) {
    e.preventDefault()
    const name = newPlaceName.trim()
    if (!name) return

    setIsAdding(true)
    try {
      const maxOrderIndex =
        placesRef.current.length > 0
          ? Math.max(...placesRef.current.map((p) => p.order_index))
          : 0

      const { error } = await supabase
        .from('places')
        .insert({
          trip_id: tripId,
          name: name,
          order_index: maxOrderIndex + 1.0,
          status: 'TODO',
        })

      if (error) throw error
      setNewPlaceName('')
    } catch (err) {
      console.error('Failed to add place', err)
    } finally {
      setIsAdding(false)
    }
  }

  // -------------------------------------------------------------------------
  // Manual Sync — user-accessible escape hatch (Requirement 9.6)
  // -------------------------------------------------------------------------
  async function handleSync() {
    setIsSyncing(true)
    try {
      const { data } = await supabase
        .from('places')
        .select('*')
        .eq('trip_id', tripId)
        .order('order_index', { ascending: true })
      if (data) onPlacesChange(data as Place[])
    } finally {
      setIsSyncing(false)
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4">
      {/* Header with Sync button */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Places
        </h2>
        <button
          onClick={handleSync}
          disabled={isSyncing}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            isSyncing
              ? 'cursor-wait bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500'
              : 'bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2'
          }`}
        >
          {isSyncing ? 'Syncing…' : '🔄 Sync'}
        </button>
      </div>

      {/* Add Place Form */}
      <form onSubmit={handleAddPlace} className="flex gap-2">
        <input
          type="text"
          placeholder="New place name..."
          value={newPlaceName}
          onChange={(e) => setNewPlaceName(e.target.value)}
          disabled={isAdding}
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
        <button
          type="submit"
          disabled={isAdding || !newPlaceName.trim()}
          className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
        >
          {isAdding ? 'Adding...' : 'Add'}
        </button>
      </form>

      {/* DnD context wrapping sortable place cards */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={places.map((p) => p.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-3">
            {places.map((place) => (
              <PlaceCard key={place.id} place={place} tripId={tripId} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Empty state */}
      {places.length === 0 && (
        <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
          No places added to this trip yet.
        </p>
      )}
    </div>
  )
}
