'use client'

import { useEffect } from 'react'

/**
 * Error boundary for the /trip/[slug] route segment.
 * Catches unexpected runtime errors (network failures, Supabase SDK errors)
 * during Server Component execution and provides a reset action.
 */
export default function TripError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[TripError]', error)
  }, [error])

  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-24 text-center">
      <div className="mb-4 text-5xl">⚠️</div>
      <h2 className="mb-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
        Something went wrong
      </h2>
      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
        {error.message || 'An unexpected error occurred while loading this trip.'}
      </p>
      <button
        onClick={reset}
        className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Try again
      </button>
    </div>
  )
}
