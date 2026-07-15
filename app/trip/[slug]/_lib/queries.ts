import type { SupabaseClient } from '@supabase/supabase-js'
import type { Trip, Place } from '@/lib/types'

/**
 * Fetch a single trip by its human-readable slug.
 * Returns null when no matching row exists (triggers notFound() in the caller).
 */
export async function fetchTrip(
  supabase: SupabaseClient,
  slug: string
): Promise<Trip | null> {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .eq('slug', slug)
    .single()

  if (error || !data) return null
  return data as Trip
}

/**
 * Fetch all places belonging to a trip, sorted by order_index ascending.
 * Uses the composite index `places_trip_id_order_idx` for efficient retrieval.
 */
export async function fetchPlaces(
  supabase: SupabaseClient,
  tripId: string
): Promise<Place[]> {
  const { data, error } = await supabase
    .from('places')
    .select('*')
    .eq('trip_id', tripId)
    .order('order_index', { ascending: true })

  if (error) throw error
  return (data ?? []) as Place[]
}
