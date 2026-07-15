'use client'

import dynamic from 'next/dynamic'
import type { Place, PingMarker } from '@/lib/types'

/**
 * SSR-bypass wrapper for MapViewer.
 *
 * `next/dynamic` with `{ ssr: false }` ensures Leaflet's browser-only globals
 * (`window`, `document`) never execute on the server. This is the ONLY entry
 * point to MapViewer — no Server Component may import MapViewer directly.
 */
const MapViewer = dynamic(() => import('./MapViewer'), {
  ssr: false,
  loading: () => (
    <div className="flex h-80 items-center justify-center rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <svg
          className="h-4 w-4 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Loading map…
      </div>
    </div>
  ),
})

interface MapWrapperProps {
  places: Place[]
  pingMarkers?: PingMarker[]
}

export default function MapWrapper({
  places,
  pingMarkers,
}: MapWrapperProps) {
  return (
    <div className="mt-8">
      <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        Map
      </h2>
      <MapViewer places={places} pingMarkers={pingMarkers} />
    </div>
  )
}
