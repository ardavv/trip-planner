'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useState, useRef, useEffect } from 'react'
import type { Place } from '@/lib/types'
import StatusControl from './StatusControl'
import ReviewForm from './ReviewForm'
import PhotoUploader from './PhotoUploader'
import { createClient } from '@/lib/client'

interface PlaceCardProps {
  place: Place
  tripId: string
  onDelete?: (id: string) => void
}

const STATUS_BADGE: Record<string, string> = {
  TODO: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  CURRENT:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  DONE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
}

/**
 * A single draggable place card rendered inside the PlaceBoard SortableContext.
 * Uses `@dnd-kit/sortable` for drag-and-drop capability.
 */
export default function PlaceCard({ place, tripId, onDelete }: PlaceCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: place.id })

  const supabase = createClient()
  
  // Cost tracking
  const committedCost = useRef({
    estimated: Number(place.estimated_cost || 0),
    actual: Number(place.actual_cost || 0)
  })

  const [estInput, setEstInput] = useState(String(committedCost.current.estimated))
  const [actInput, setActInput] = useState(String(committedCost.current.actual))
  const [error, setError] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [localImageUrl, setLocalImageUrl] = useState(place.image_url)

  const [isDeletingPhoto, setIsDeletingPhoto] = useState(false)
  const [isLightboxOpen, setIsLightboxOpen] = useState(false)

  // Maps URL tracking
  const committedMapsUrl = useRef(place.maps_url || '')
  const [mapsUrlInput, setMapsUrlInput] = useState(place.maps_url || '')

  // Sync inputs if prop changes externally (e.g. from Realtime sync)
  useEffect(() => {
    const est = Number(place.estimated_cost || 0)
    const act = Number(place.actual_cost || 0)
    committedCost.current = { estimated: est, actual: act }
    setEstInput(String(est))
    setActInput(String(act))
    setLocalImageUrl(place.image_url)
    
    const mUrl = place.maps_url || ''
    committedMapsUrl.current = mUrl
    setMapsUrlInput(mUrl)
  }, [place.estimated_cost, place.actual_cost, place.image_url, place.maps_url])

  const handleCostSubmit = async (field: 'estimated' | 'actual', rawValue: string) => {
    let num = parseFloat(rawValue)
    if (isNaN(num) || num < 0) num = 0
    num = Math.round(num * 100) / 100

    const strVal = String(num)
    if (field === 'estimated') setEstInput(strVal)
    else setActInput(strVal)

    if (num === committedCost.current[field]) return

    setIsUpdating(true)
    setError(null)
    const col = field === 'estimated' ? 'estimated_cost' : 'actual_cost'

    const { error: updateError } = await supabase
      .from('places')
      .update({ [col]: num })
      .eq('id', place.id)

    setIsUpdating(false)

    if (updateError) {
      setError(`Failed to save ${field} cost`)
      if (field === 'estimated') setEstInput(String(committedCost.current.estimated))
      else setActInput(String(committedCost.current.actual))
    } else {
      committedCost.current[field] = num
    }
  }

  const handleMapsUrlSubmit = async (rawValue: string) => {
    const url = rawValue.trim()
    
    // Validate URL (if not empty)
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
      setError('Maps URL must start with http:// or https://')
      setMapsUrlInput(committedMapsUrl.current)
      return
    }

    if (url === committedMapsUrl.current) return

    setIsUpdating(true)
    setError(null)

    try {
      let parsedLat: number | null = null
      let parsedLng: number | null = null

      if (url) {
        // Attempt to parse coordinates via our internal API
        const parseRes = await fetch('/api/parse-maps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        })
        
        if (parseRes.ok) {
          const data = await parseRes.json()
          if (typeof data.lat === 'number' && typeof data.lng === 'number') {
            parsedLat = data.lat
            parsedLng = data.lng
          }
        }
      }

      // Prepare payload
      const payload: any = { maps_url: url || null }
      if (parsedLat !== null && parsedLng !== null) {
        payload.lat = parsedLat
        payload.lng = parsedLng
      }

      const { error: updateError } = await supabase
        .from('places')
        .update(payload)
        .eq('id', place.id)

      if (updateError) throw updateError

      committedMapsUrl.current = url
    } catch (err) {
      console.error('Maps update error', err)
      setError('Failed to save Maps URL')
      setMapsUrlInput(committedMapsUrl.current)
    } finally {
      setIsUpdating(false)
    }
  }

  const handleDeletePlace = async () => {
    if (isUpdating) return
    const confirmed = window.confirm("Are you sure you want to delete this place?")
    if (!confirmed) return

    setIsUpdating(true)
    setError(null)
    try {
      // Clean up storage if photo exists
      if (localImageUrl) {
        const storagePath = localImageUrl.split('/trip-photos/')[1]
        if (storagePath) {
          await supabase.storage.from('trip-photos').remove([storagePath])
        }
      }

      const { error: dbError } = await supabase
        .from('places')
        .delete()
        .eq('id', place.id)

      if (dbError) throw dbError
      
      // If deleted successfully, the Realtime listener in PlaceBoard will remove it from the UI.
      // We also trigger onDelete immediately for an optimistic UI update.
      if (onDelete) {
        onDelete(place.id)
      }
    } catch (err) {
      console.error('Delete error', err)
      setError('Failed to delete place.')
      setIsUpdating(false)
    }
  }

  const handlePhotoDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!localImageUrl || isDeletingPhoto) return
    setIsDeletingPhoto(true)
    setError(null)
    try {
      const storagePath = localImageUrl.split('/trip-photos/')[1]
      if (storagePath) {
        await supabase.storage.from('trip-photos').remove([storagePath])
      }
      
      const { error: dbError } = await supabase
        .from('places')
        .update({ image_url: null })
        .eq('id', place.id)
      
      if (dbError) throw dbError
      
      setLocalImageUrl(null)
    } catch (err) {
      setError('Failed to delete photo.')
    } finally {
      setIsDeletingPhoto(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, field: 'estimated' | 'actual', val: string) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 'auto' as const,
  }

  return (
    <>
    <div
      ref={setNodeRef}
      style={style}
      className={`relative flex items-start gap-4 rounded-3xl border border-rose-100/60 p-4 transition-all ${
        isDragging
          ? 'border-rose-400 shadow-xl shadow-rose-200/50 dark:border-rose-500'
          : 'shadow-md shadow-rose-100/50 hover:shadow-lg hover:shadow-rose-100/60 dark:shadow-none dark:border-gray-800'
      } bg-white/90 backdrop-blur-sm dark:bg-gray-900/90`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="mt-1 shrink-0 cursor-grab touch-none rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 active:cursor-grabbing dark:hover:bg-gray-800 dark:hover:text-gray-300"
        aria-label="Drag to reorder"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="9" cy="5" r="1" />
          <circle cx="15" cy="5" r="1" />
          <circle cx="9" cy="12" r="1" />
          <circle cx="15" cy="12" r="1" />
          <circle cx="9" cy="19" r="1" />
          <circle cx="15" cy="19" r="1" />
        </svg>
      </button>

      {/* Thumbnail */}
      {localImageUrl && (
        <div className="relative shrink-0">
          <img
            src={localImageUrl}
            alt={place.name}
            className="h-16 w-16 cursor-pointer rounded-2xl object-cover transition-opacity hover:opacity-80"
            onClick={() => setIsLightboxOpen(true)}
          />
          <button
            onClick={handlePhotoDelete}
            disabled={isDeletingPhoto}
            className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow hover:bg-red-600 disabled:opacity-50"
            aria-label="Delete photo"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 justify-between">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h3 className="truncate font-medium text-gray-900 dark:text-gray-100">
              {place.name}
            </h3>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                STATUS_BADGE[place.status]
              }`}
            >
              {place.status}
            </span>
          </div>
          
          <button
            onClick={handleDeletePlace}
            disabled={isUpdating}
            className="shrink-0 p-1 text-rose-300 hover:text-rose-600 transition-colors disabled:opacity-50"
            aria-label="Delete place"
            title="Delete place"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18"/>
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            </svg>
          </button>
        </div>

        {/* Status control */}
        <div className="mt-2">
          <StatusControl
            place={place}
            tripId={tripId}
            onChange={() => {
              // Status changes propagate via Realtime subscription
            }}
          />
        </div>

        {/* Cost inputs */}
        <div className="mt-4 flex flex-wrap gap-4 border-t border-rose-100/60 pt-3 dark:border-gray-800">
          <div className="flex flex-col flex-1 min-w-[120px]">
            <label className="mb-1 text-xs font-medium text-rose-500 dark:text-rose-400">
              Est. Cost
            </label>
            <input
              type="number"
              value={estInput}
              onChange={(e) => setEstInput(e.target.value)}
              onBlur={(e) => handleCostSubmit('estimated', e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, 'estimated', estInput)}
              disabled={isUpdating}
              className="w-full rounded-xl border border-rose-100 bg-white/80 px-3 py-1.5 text-sm text-gray-900 shadow-sm focus:border-rose-400 focus:outline-none focus:ring-1 focus:ring-rose-400 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
          <div className="flex flex-col flex-1 min-w-[120px]">
            <label className="mb-1 text-xs font-medium text-rose-500 dark:text-rose-400">
              Act. Cost
            </label>
            <input
              type="number"
              value={actInput}
              onChange={(e) => setActInput(e.target.value)}
              onBlur={(e) => handleCostSubmit('actual', e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, 'actual', actInput)}
              disabled={isUpdating}
              className="w-full rounded-xl border border-rose-100 bg-white/80 px-3 py-1.5 text-sm text-gray-900 shadow-sm focus:border-rose-400 focus:outline-none focus:ring-1 focus:ring-rose-400 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
        </div>

        {/* Maps URL */}
        <div className="mt-4 flex flex-col md:flex-row items-stretch md:items-center gap-3 border-t border-rose-100/60 pt-3 dark:border-gray-800">
          <input
            type="text"
            placeholder="Paste Google Maps Link..."
            value={mapsUrlInput}
            onChange={(e) => setMapsUrlInput(e.target.value)}
            onBlur={(e) => handleMapsUrlSubmit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
            }}
            disabled={isUpdating}
            className="w-full md:flex-1 rounded-xl border border-rose-100 bg-white/80 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-rose-400 focus:outline-none focus:ring-1 focus:ring-rose-400 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
          {committedMapsUrl.current && (
            <a
              href={committedMapsUrl.current}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 shadow-sm transition-colors hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
              Open Maps
            </a>
          )}
        </div>
        
        {error && (
          <p className="mt-2 text-xs text-red-500">{error}</p>
        )}

        {/* Review form */}
        <ReviewForm placeId={place.id} initialReviews={[]} />

        {/* Photo uploader */}
        <PhotoUploader
          tripId={tripId}
          placeId={place.id}
          onImageUploaded={(url) => setLocalImageUrl(url)}
        />
      </div>
    </div>

    {/* Lightbox Overlay */}
    {isLightboxOpen && localImageUrl && (
      <div
        className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-4"
        onClick={() => setIsLightboxOpen(false)}
      >
        <button
          className="absolute right-6 top-6 text-white hover:text-gray-300 focus:outline-none"
          onClick={() => setIsLightboxOpen(false)}
          aria-label="Close lightbox"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <img
          src={localImageUrl}
          alt={place.name}
          className="max-h-[85vh] max-w-full rounded-lg object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    )}
    </>
  )
}
