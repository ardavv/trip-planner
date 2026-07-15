'use client'

import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import { useEffect, useMemo } from 'react'
import type { Place, PingMarker, VisitStatus } from '@/lib/types'

// ---------------------------------------------------------------------------
// Status-colored DivIcon factory
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<VisitStatus, string> = {
  TODO: '#ef4444',    // red
  CURRENT: '#eab308', // yellow
  DONE: '#22c55e',    // green
}

function createStatusIcon(status: VisitStatus): L.DivIcon {
  const color = STATUS_COLORS[status] ?? '#6b7280'

  return L.divIcon({
    className: '',   // reset default leaflet-div-icon styling
    html: `
      <div style="
        width: 28px;
        height: 28px;
        background: ${color};
        border: 3px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      "></div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  })
}

// ---------------------------------------------------------------------------
// Ping marker icon — pulsing animated circle
// ---------------------------------------------------------------------------

function createPingIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `
      <div style="
        position: relative;
        width: 20px;
        height: 20px;
      ">
        <div style="
          position: absolute;
          inset: 0;
          background: #3b82f6;
          border-radius: 50%;
          animation: ping-pulse 1.5s ease-in-out infinite;
        "></div>
        <div style="
          position: absolute;
          inset: 4px;
          background: #60a5fa;
          border: 2px solid white;
          border-radius: 50%;
          box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        "></div>
      </div>
    `,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -12],
  })
}

// ---------------------------------------------------------------------------
// FitBounds helper — auto-fits map viewport on mount
// ---------------------------------------------------------------------------

function FitBounds({ places }: { places: Place[] }) {
  const map = useMap()

  useEffect(() => {
    const coords = places
      .filter((p): p is Place & { lat: number; lng: number } =>
        p.lat != null && p.lng != null
      )
      .map((p) => [p.lat, p.lng] as [number, number])

    if (coords.length === 0) return

    const bounds = L.latLngBounds(coords)
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only on mount — per Requirement 4.7

  return null
}

// ---------------------------------------------------------------------------
// MapViewer component
// ---------------------------------------------------------------------------

interface MapViewerProps {
  places: Place[]
  pingMarkers?: PingMarker[]
}

/**
 * Client-only react-leaflet map component.
 *
 * - Loaded exclusively via `next/dynamic({ ssr: false })` in MapWrapper.
 * - Never imported directly by any Server Component.
 * - Renders one Marker per place with non-null lat/lng.
 * - Color-codes markers by visit_status: red (TODO), yellow (CURRENT), green (DONE).
 * - Auto-fits viewport to all non-null coordinates on mount.
 * - Renders ephemeral pingMarkers as animated pulsing blue circles.
 * - Falls back to a message when no coordinates exist.
 */
export default function MapViewer({
  places,
  pingMarkers = [],
}: MapViewerProps) {
  // Filter to places with valid coordinates
  const mappablePlaces = useMemo(
    () =>
      places.filter(
        (p): p is Place & { lat: number; lng: number } =>
          p.lat != null && p.lng != null
      ),
    [places]
  )

  // Ping icon — stable across renders
  const pingIcon = useMemo(() => createPingIcon(), [])

  // Fallback when no mappable locations exist (Requirement 4.8)
  if (mappablePlaces.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 dark:border-gray-600 dark:bg-gray-800">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No mappable locations available.
        </p>
      </div>
    )
  }

  // Default center — first valid coordinate
  const defaultCenter: [number, number] = [
    mappablePlaces[0].lat,
    mappablePlaces[0].lng,
  ]

  return (
    <>
      {/* Inject keyframe animation for ping markers */}
      <style>{`
        @keyframes ping-pulse {
          0%, 100% { transform: scale(1); opacity: 0.6; }
          50% { transform: scale(2.2); opacity: 0; }
        }
      `}</style>

      <MapContainer
        center={defaultCenter}
        zoom={13}
        scrollWheelZoom
        className="h-80 w-full rounded-xl shadow-sm"
        style={{ minHeight: '320px' }}
      >
        {/* OpenStreetMap tile layer */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Auto-fit bounds on mount */}
        <FitBounds places={places} />

        {/* Place markers — color-coded by visit_status */}
        {mappablePlaces.map((place) => (
          <Marker
            key={place.id}
            position={[place.lat, place.lng]}
            icon={createStatusIcon(place.status)}
          >
            <Popup>
              <div className="text-sm">
                <strong className="block text-gray-900">{place.name}</strong>
                <span
                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                    place.status === 'TODO'
                      ? 'bg-red-100 text-red-700'
                      : place.status === 'CURRENT'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-green-100 text-green-700'
                  }`}
                >
                  {place.status}
                </span>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Ephemeral ping markers — animated pulsing blue circles */}
        {pingMarkers.map((ping) => (
          <Marker
            key={ping.id}
            position={[ping.lat, ping.lng]}
            icon={pingIcon}
          >
            <Popup>
              <div className="text-sm">
                <strong className="block text-blue-600">
                  📍 {ping.sender_label}
                </strong>
                <span className="text-xs text-gray-500">
                  {new Date(ping.sent_at).toLocaleTimeString()}
                </span>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </>
  )
}
