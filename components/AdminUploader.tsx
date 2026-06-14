'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function AdminUploader() {
  const [uploading, setUploading] = useState(false)

  async function uploadFile(file: File) {
    setUploading(true)

    const safeName = file.name.toLowerCase().replaceAll(' ', '-')
    const storagePath = `uploads/${Date.now()}-${safeName}`

    const { error: uploadError } = await supabase.storage
      .from('photos')
      .upload(storagePath, file)

    if (uploadError) {
      console.error('Storage upload failed:', uploadError.message)
      setUploading(false)
      return
    }

    const { error: insertError } = await supabase
      .from('photos')
      .insert({
        name: file.name,
        storage_path: storagePath,
        category: 'natur',
        title: file.name.replace(/\.[^/.]+$/, ''),
      })

    if (insertError) {
      console.error('Database insert failed:', insertError.message)
    }

    setUploading(false)
  }

  return (
    <div>
      <input
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          files.forEach(uploadFile)
        }}
      />

      {uploading && <p>Uploading...</p>}
    </div>
  )
}