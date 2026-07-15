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
}

const STATUS_BADGE: Record<string, string> = {
  TODO: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  CURRENT:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  DONE: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
}

/**
 * A single draggable place card rendered inside the PlaceBoard SortableContext.
 * Uses `@dnd-kit/sortable` for drag-and-drop capability.
 */
export default function PlaceCard({ place, tripId }: PlaceCardProps) {
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

  // Sync inputs if prop changes externally (e.g. from Realtime sync)
  useEffect(() => {
    const est = Number(place.estimated_cost || 0)
    const act = Number(place.actual_cost || 0)
    committedCost.current = { estimated: est, actual: act }
    setEstInput(String(est))
    setActInput(String(act))
    setLocalImageUrl(place.image_url)
  }, [place.estimated_cost, place.actual_cost, place.image_url])

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
      className={`relative flex items-start gap-4 rounded-xl border p-4 transition-shadow ${
        isDragging
          ? 'border-blue-400 shadow-lg dark:border-blue-500'
          : 'border-gray-200 shadow-sm hover:shadow-md dark:border-gray-700'
      } bg-white dark:bg-gray-900`}
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
            className="h-16 w-16 cursor-pointer rounded-lg object-cover transition-opacity hover:opacity-80"
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
        <div className="flex items-center gap-2">
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
        <div className="mt-4 flex flex-wrap gap-4 border-t border-gray-100 pt-3 dark:border-gray-800">
          <div className="flex flex-col">
            <label className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
              Est. Cost
            </label>
            <input
              type="number"
              value={estInput}
              onChange={(e) => setEstInput(e.target.value)}
              onBlur={(e) => handleCostSubmit('estimated', e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, 'estimated', estInput)}
              disabled={isUpdating}
              className="w-28 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
          <div className="flex flex-col">
            <label className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
              Act. Cost
            </label>
            <input
              type="number"
              value={actInput}
              onChange={(e) => setActInput(e.target.value)}
              onBlur={(e) => handleCostSubmit('actual', e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, 'actual', actInput)}
              disabled={isUpdating}
              className="w-28 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
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
