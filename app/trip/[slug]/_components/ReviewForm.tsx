'use client'

import { useState } from 'react'
import type { Review } from '@/lib/types'
import { createClient } from '@/lib/client'

interface ReviewFormProps {
  placeId: string
  initialReviews: Review[]
}

/**
 * Dual-input review form with review list display.
 * Submits non-empty inputs for Person 1 and Person 2 in a single batch.
 */
export default function ReviewForm({ placeId, initialReviews }: ReviewFormProps) {
  const [reviews, setReviews] = useState<Review[]>(initialReviews)
  const [reviewTexts, setReviewTexts] = useState<[string, string]>(['', ''])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const t1 = reviewTexts[0].trim()
    const t2 = reviewTexts[1].trim()

    if (!t1 && !t2) return

    setIsSubmitting(true)
    setError(null)

    try {
      const payloads = []
      if (t1) payloads.push({ place_id: placeId, user_name: 'Person 1', comment: t1 })
      if (t2) payloads.push({ place_id: placeId, user_name: 'Person 2', comment: t2 })

      const { data, error: insertError } = await supabase
        .from('reviews')
        .insert(payloads)
        .select()

      if (insertError) throw insertError

      if (data) {
        setReviews((prev) => {
          const combined = [...prev, ...(data as Review[])]
          return combined.sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          )
        })
      }

      // Clear only successfully submitted inputs
      setReviewTexts([t1 ? '' : reviewTexts[0], t2 ? '' : reviewTexts[1]])
    } catch (err) {
      setError('Failed to submit review(s).')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Helper for cleaner timestamps
  const getRelativeTime = (isoStr: string) => {
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
    const diffDays = Math.round((new Date(isoStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    if (diffDays === 0) return 'Today'
    return rtf.format(diffDays, 'day')
  }

  return (
    <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
      
      {/* Existing Reviews */}
      {reviews.length > 0 && (
        <div className="mb-4 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Reviews
          </h4>
          {reviews.map((rev) => (
            <div key={rev.id} className="rounded-md bg-gray-50 p-3 dark:bg-gray-800/50">
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {rev.user_name}
                </span>
                <span>{getRelativeTime(rev.created_at)}</span>
              </div>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                {rev.comment}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Person 1
          </label>
          <input
            type="text"
            placeholder="Add your review..."
            value={reviewTexts[0]}
            onChange={(e) => setReviewTexts([e.target.value, reviewTexts[1]])}
            disabled={isSubmitting}
            className="rounded-md border border-gray-300 px-3 py-1.5 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Person 2
          </label>
          <input
            type="text"
            placeholder="Add your review..."
            value={reviewTexts[1]}
            onChange={(e) => setReviewTexts([reviewTexts[0], e.target.value])}
            disabled={isSubmitting}
            className="rounded-md border border-gray-300 px-3 py-1.5 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>

        {error && <span className="text-xs text-red-500 dark:text-red-400">{error}</span>}

        <button
          type="submit"
          disabled={isSubmitting || (!reviewTexts[0].trim() && !reviewTexts[1].trim())}
          className="mt-1 self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {isSubmitting ? 'Submitting...' : 'Submit Reviews'}
        </button>
      </form>
    </div>
  )
}
