'use client'

import { useState, type Dispatch, type SetStateAction } from 'react'
import type { Trip, Place } from '@/lib/types'
import BudgetSummary from './BudgetSummary'
import PlaceBoard from './PlaceBoard'
import MapWrapper from './MapWrapper'
import PingService from './PingService'

interface TripShellProps {
  trip: Trip
  initialPlaces: Place[]
  slug: string
}

/**
 * Top-level client component — owns the authoritative `places` state.
 * Derives budget totals via .reduce() on every render (not stored in state).
 * Composes PlaceBoard, BudgetSummary, MapWrapper, and PingService.
 */
export default function TripShell({
  trip,
  initialPlaces,
  slug,
}: TripShellProps) {
  const [places, setPlaces] = useState<Place[]>(initialPlaces)
  const [isSyncing, setIsSyncing] = useState(false)
  const [pingMarkers, setPingMarkers] = useState<import('@/lib/types').PingMarker[]>([])

  // Derive budget totals on every render — Number() guards against
  // Supabase returning NUMERIC(15,2) as a string.
  const totalEstimated = places.reduce(
    (sum, p) => sum + Number(p.estimated_cost),
    0
  )
  const totalActual = places.reduce(
    (sum, p) => sum + Number(p.actual_cost),
    0
  )

  return (
    <div className="min-h-screen bg-rose-50/30">
      <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Trip header */}
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {trip.title}
        </h1>
        {trip.description && (
          <p className="mt-1 text-gray-600 dark:text-gray-400">
            {trip.description}
          </p>
        )}
      </header>

      {/* Sticky budget bar */}
      <BudgetSummary
        totalEstimated={totalEstimated}
        totalActual={totalActual}
      />

      {/* Drag-and-drop place board with Realtime */}
      <PlaceBoard
        places={places}
        tripId={trip.id}
        slug={slug}
        onPlacesChange={setPlaces}
      />

      {/* Interactive map (Leaflet, loaded client-only) */}
      <MapWrapper places={places} pingMarkers={pingMarkers} />

      {/* Ephemeral location ping service */}
      <PingService slug={slug} onPingsChange={setPingMarkers} />
      </div>
    </div>
  )
}
