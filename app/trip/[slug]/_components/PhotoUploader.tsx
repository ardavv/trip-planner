'use client'

import { useState } from 'react'
import { createClient } from '@/lib/client'

interface PhotoUploaderProps {
  tripId: string
  placeId: string
  onImageUploaded: (url: string) => void
}

/**
 * Camera/file upload with progress indicator.
 * - Uploads directly to Supabase storage 'trip-photos' bucket.
 * - Updates the `image_url` on the `places` table.
 * - Handles rollback (deleting orphaned file) if the DB update fails.
 */
export default function PhotoUploader({
  tripId,
  placeId,
  onImageUploaded,
}: PhotoUploaderProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supabase = createClient()

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Reset input immediately so the same file can be selected again if needed
    const inputElement = e.target
    const resetInput = () => { inputElement.value = '' }

    // Validation
    if (!file.type.startsWith('image/')) {
      setError('Selected file must be an image.')
      resetInput()
      return
    }
    if (file.size > 10 * 1024 * 1024) { // 10MB
      setError('Image size must be less than 10MB.')
      resetInput()
      return
    }

    setIsUploading(true)
    setError(null)
    
    let uploadedPath = ''

    try {
      const ext = file.name.split('.').pop() || 'jpg'
      const filePath = `${tripId}/${placeId}/${crypto.randomUUID()}.${ext}`

      // 1. Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('trip-photos')
        .upload(filePath, file)

      if (uploadError) throw uploadError
      uploadedPath = uploadData.path

      // 2. Get Public URL
      const { data: urlData } = supabase.storage
        .from('trip-photos')
        .getPublicUrl(uploadedPath)

      const publicUrl = urlData.publicUrl

      // 3. Update Places table
      const { error: dbError } = await supabase
        .from('places')
        .update({ image_url: publicUrl })
        .eq('id', placeId)

      if (dbError) throw dbError

      // 4. Success — propagate URL upward
      onImageUploaded(publicUrl)
      resetInput()
    } catch (err) {
      setError('Failed to upload photo.')
      
      // Cleanup orphaned file if the DB update failed
      if (uploadedPath) {
        await supabase.storage
          .from('trip-photos')
          .remove([uploadedPath])
          .catch(() => {}) // Ignore cleanup errors
      }
      resetInput()
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div className="mt-4 border-t border-rose-100/60 pt-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        {/* Visible Buttons */}
        <button
          type="button"
          onClick={() => document.getElementById(`camera-${placeId}`)?.click()}
          disabled={isUploading}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-rose-100 px-4 py-2.5 text-sm font-semibold text-rose-700 shadow-sm transition-all hover:bg-rose-200 active:scale-95 disabled:opacity-50 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50"
        >
          📸 Ambil Foto
        </button>
        <button
          type="button"
          onClick={() => document.getElementById(`gallery-${placeId}`)?.click()}
          disabled={isUploading}
          className="flex flex-1 items-center justify-center gap-2 rounded-full border border-rose-200 bg-white/80 px-4 py-2.5 text-sm font-semibold text-rose-600 shadow-sm transition-all hover:bg-rose-50 active:scale-95 disabled:opacity-50 dark:border-rose-800 dark:bg-gray-800 dark:text-rose-400 dark:hover:bg-gray-700"
        >
          🖼️ Dari Galeri
        </button>

        {isUploading && (
          <span className="w-full text-center text-xs font-medium text-rose-500 animate-pulse mt-1">
            Uploading...
          </span>
        )}

        {/* Hidden Inputs */}
        <input
          type="file"
          id={`camera-${placeId}`}
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          disabled={isUploading}
          className="hidden"
        />
        <input
          type="file"
          id={`gallery-${placeId}`}
          accept="image/*"
          onChange={handleFileChange}
          disabled={isUploading}
          className="hidden"
        />
      </div>
      
      {error && (
        <p className="mt-2 text-xs text-red-500 dark:text-red-400">{error}</p>
      )}
    </div>
  )
}
