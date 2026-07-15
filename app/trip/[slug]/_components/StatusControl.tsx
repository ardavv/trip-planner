'use client'

import { useState } from 'react'
import { createClient } from '@/lib/client'
import type { Place, VisitStatus } from '@/lib/types'

interface StatusControlProps {
  place: Place
  tripId: string
  onChange: (status: VisitStatus) => void
}

const STATUS_STYLES: Record<VisitStatus, string> = {
  TODO: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  CURRENT:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  DONE: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
}

/**
 * Status select for a single place.
 *
 * - CURRENT → calls `supabase.rpc('set_place_current')` for atomic
 *   enforcement of the "at most one CURRENT per trip" invariant.
 * - TODO / DONE → calls a direct single-row UPDATE on the `places` table.
 *
 * The authoritative state update comes back through the Realtime subscription
 * in PlaceBoard. This component does NOT optimistically update the parent —
 * it relies on Realtime for consistency.
 */
export default function StatusControl({
  place,
  tripId,
  onChange,
}: StatusControlProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supabase = createClient()

  async function handleChange(newStatus: VisitStatus) {
    if (newStatus === place.status || pending) return

    setPending(true)
    setError(null)

    try {
      if (newStatus === 'CURRENT') {
        // Atomic RPC — demotes any existing CURRENT to DONE in the same trip
        const { error: rpcError } = await supabase.rpc('set_place_current', {
          p_place_id: place.id,
          p_trip_id: tripId,
        })
        if (rpcError) throw rpcError
      } else {
        // Direct single-row UPDATE — no constraint enforcement needed
        const { error: updateError } = await supabase
          .from('places')
          .update({ status: newStatus })
          .eq('id', place.id)
        if (updateError) throw updateError
      }

      onChange(newStatus)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to update status'
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={place.status}
        onChange={(e) => handleChange(e.target.value as VisitStatus)}
        disabled={pending}
        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
          STATUS_STYLES[place.status]
        } ${pending ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
      >
        <option value="TODO">TODO</option>
        <option value="CURRENT">CURRENT</option>
        <option value="DONE">DONE</option>
      </select>

      {error && (
        <span className="text-xs text-red-500 dark:text-red-400">{error}</span>
      )}
    </div>
  )
}
