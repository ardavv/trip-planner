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
    .from('trips')
    .select('title, description')
    .eq('slug', slug)
    .single()

  if (!trip) return { title: 'Trip Not Found' }

  return {
    title: trip.title,
    description: trip.description ?? undefined,
  }
}

export default async function TripPage({ params }: Props) {
  const { slug } = await params
  const supabase = await createClient()

  const trip = await fetchTrip(supabase, slug)
  if (!trip) notFound()

  const places = await fetchPlaces(supabase, trip.id)

  return <TripShell trip={trip} initialPlaces={places} slug={slug} />
}
