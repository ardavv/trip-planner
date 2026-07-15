import Link from 'next/link'

/**
 * 404 boundary — rendered when notFound() is called from page.tsx
 * because no trip row matches the requested slug.
 */
export default function TripNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-24 text-center">
      <div className="mb-4 text-6xl">🗺️</div>
      <h2 className="mb-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
        Trip not found
      </h2>
      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
        The trip you&apos;re looking for doesn&apos;t exist or may have been removed.
        Double-check the URL and try again.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Go home
      </Link>
    </div>
  )
}
