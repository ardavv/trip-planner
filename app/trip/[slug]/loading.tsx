/**
 * Streaming skeleton — rendered immediately while the Server Component
 * (page.tsx) awaits its Supabase data fetch. Matches the approximate
 * layout of the place board so the user sees useful structure right away.
 */
export default function TripLoading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 animate-pulse">
      {/* Trip header skeleton */}
      <div className="mb-6 space-y-3">
        <div className="h-8 w-2/3 rounded-md bg-gray-200 dark:bg-gray-700" />
        <div className="h-4 w-1/2 rounded-md bg-gray-200 dark:bg-gray-700" />
      </div>

      {/* Budget summary skeleton */}
      <div className="mb-6 flex gap-4">
        <div className="h-10 w-40 rounded-lg bg-gray-200 dark:bg-gray-700" />
        <div className="h-10 w-40 rounded-lg bg-gray-200 dark:bg-gray-700" />
      </div>

      {/* Place cards skeleton */}
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700"
          >
            {/* Thumbnail */}
            <div className="h-16 w-16 shrink-0 rounded-lg bg-gray-200 dark:bg-gray-700" />
            {/* Text lines */}
            <div className="flex-1 space-y-2">
              <div className="h-5 w-3/4 rounded bg-gray-200 dark:bg-gray-700" />
              <div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-700" />
            </div>
            {/* Status badge */}
            <div className="h-6 w-16 rounded-full bg-gray-200 dark:bg-gray-700" />
          </div>
        ))}
      </div>

      {/* Map skeleton */}
      <div className="mt-8 h-64 rounded-xl bg-gray-200 dark:bg-gray-700" />
    </div>
  )
}
