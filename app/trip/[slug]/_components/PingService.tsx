'use client'

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/client'
import type { PingMarker } from '@/lib/types'

interface PingServiceProps {
  slug: string
  onPingsChange: (pings: PingMarker[]) => void
}

/**
 * Ephemeral location ping service (Phase 6).
 * Handles Broadcast Channel subscription and geolocation pings.
 * No database writes occur here.
 */
export default function PingService({ slug, onPingsChange }: PingServiceProps) {
  const [isPinging, setIsPinging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // Local state for tracking active pings to manage timeouts
  const [activePings, setActivePings] = useState<PingMarker[]>([])
  
  // Keep a ref of activePings so we can accurately update it in the timeout callback
  const activePingsRef = useRef<PingMarker[]>([])
  activePingsRef.current = activePings

  const supabase = createClient()

  // -------------------------------------------------------------------------
  // 1. Broadcast Channel Subscription
  // -------------------------------------------------------------------------
  useEffect(() => {
    const channel = supabase
      .channel(`trip-ping:${slug}`)
      .on('broadcast', { event: 'location_ping' }, ({ payload }) => {
        // Construct the new ping marker with expiration
        const newPing: PingMarker = {
          id: crypto.randomUUID(),
          lat: payload.lat,
          lng: payload.lng,
          sender_label: payload.sender_label,
          sent_at: payload.sent_at,
          expiresAt: Date.now() + 30_000,
        }

        // Add to state
        setActivePings((prev) => {
          const updated = [...prev, newPing]
          onPingsChange(updated)
          return updated
        })

        // Schedule removal after 30 seconds
        setTimeout(() => {
          setActivePings((prev) => {
            const updated = prev.filter((p) => p.id !== newPing.id)
            onPingsChange(updated)
            return updated
          })
        }, 30_000)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  // -------------------------------------------------------------------------
  // 2. Geolocation and Broadcasting
  // -------------------------------------------------------------------------
  async function handleSendPing() {
    if (!navigator.geolocation) {
      setError('Location sharing is unsupported on this device.')
      return
    }

    setIsPinging(true)
    setError(null)

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const channel = supabase.channel(`trip-ping:${slug}`)
          
          await channel.send({
            type: 'broadcast',
            event: 'location_ping',
            payload: {
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              sender_label: 'Me', // We could make this configurable later
              sent_at: new Date().toISOString(),
            },
          })
          
          // Optionally, we could simulate receiving our own ping here,
          // but if we are subscribed to the same channel, we will receive it anyway.
        } catch (err) {
          setError('Failed to broadcast location.')
        } finally {
          setIsPinging(false)
        }
      },
      (geoError) => {
        let errMsg = 'Failed to get location.'
        if (geoError.code === geoError.PERMISSION_DENIED) {
          errMsg = 'Location permission denied.'
        } else if (geoError.code === geoError.TIMEOUT) {
          errMsg = 'Location request timed out.'
        }
        setError(errMsg)
        setIsPinging(false)
      },
      { timeout: 10000 }
    )
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="mt-6 flex flex-col items-start gap-2">
      <div className="flex items-center gap-3">
        <button
          onClick={handleSendPing}
          disabled={isPinging}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            isPinging
              ? 'cursor-wait bg-blue-400 text-white dark:bg-blue-600/60'
              : 'bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2'
          }`}
        >
          {isPinging ? '📍 Locating...' : '📍 Send Ping'}
        </button>

        {error && (
          <button
            onClick={handleSendPing}
            className="text-sm font-medium text-gray-600 underline hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Retry
          </button>
        )}
      </div>

      {error && (
        <span className="text-sm text-red-500 dark:text-red-400">{error}</span>
      )}
      
      {!navigator.geolocation && !error && (
        <span className="text-sm text-red-500 dark:text-red-400">
          Location sharing is unsupported on this device.
        </span>
      )}
    </div>
  )
}
