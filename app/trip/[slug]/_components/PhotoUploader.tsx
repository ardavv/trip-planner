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
    <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
      <label className="flex w-max cursor-pointer items-center gap-2 rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
        {isUploading ? 'Uploading...' : 'Take/Add Photo'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          disabled={isUploading}
          className="hidden"
        />
      </label>
      
      {error && (
        <p className="mt-2 text-xs text-red-500 dark:text-red-400">{error}</p>
      )}
    </div>
  )
}
