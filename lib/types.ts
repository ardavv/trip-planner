// lib/types.ts — Shared across Server Components, Client Components, and API routes

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
