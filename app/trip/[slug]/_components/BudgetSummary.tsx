'use client'

interface BudgetSummaryProps {
  totalEstimated: number
  totalActual: number
}

/**
 * Renders a sticky bar with aggregated trip cost totals.
 * Formats values in Indonesian Rupiah (IDR).
 */
export default function BudgetSummary({
  totalEstimated,
  totalActual,
}: BudgetSummaryProps) {
  const formatter = new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })

  return (
    <div className="sticky top-0 z-40 mb-4 flex flex-wrap items-center gap-6 rounded-xl border border-gray-200 bg-white/85 px-5 py-3 shadow-sm backdrop-blur dark:border-gray-700 dark:bg-gray-900/85">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
          Estimated:
        </span>
        <span className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {formatter.format(totalEstimated)}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
          Actual:
        </span>
        <span className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {formatter.format(totalActual)}
        </span>
      </div>
    </div>
  )
}
