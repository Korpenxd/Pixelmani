'use client'

import { useEffect, useRef, useState } from 'react'
import type { Category, Photo } from '@/lib/types'
import Navbar from '@/components/Navbar'
import {
  ADMIN_UPLOAD_BATCH_SIZE,
  AdminApiError,
  MAX_BULK_DELETE,
  uploadInBatches,
  type AdminApi,
  type AdminStorageUsage,
  type UploadItem,
} from '@/lib/adminApi'
import { adminErrorCode, adminErrorMessage, isAuthLost } from '@/lib/adminErrors'
import { createHeroImageVariant, createImageVariants } from '@/lib/imageVariants'

type AdminDashboardProps = {
  /** PHP admin client from AdminApp (session cookie + in-memory CSRF token). */
  api: AdminApi
  onLogout: () => Promise<void>
}

/** Shows an action's failure in Swedish. Silent when the session is gone: AdminApp shows the login. */
function reportError(prefix: string, error: unknown) {
  if (isAuthLost(error)) return
  console.error(prefix, adminErrorCode(error) ?? 'unknown_error')
  alert(`${prefix}: ${adminErrorMessage(error)}`)
}

/** Browser-side image preparation failed: keep known codes (e.g. no WebP), otherwise image_processing. */
function preparationError(error: unknown): unknown {
  return adminErrorCode(error) !== null ? error : new AdminApiError('image_processing', 0)
}

export default function AdminDashboard({ api, onLogout }: AdminDashboardProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([])
  const [deletingSelected, setDeletingSelected] = useState(false)

  const [categories, setCategories] = useState<Category[]>([])
  const [category, setCategory] = useState('okategoriserad')
  const [newCategoryLabel, setNewCategoryLabel] = useState('')
  const [categoryLoading, setCategoryLoading] = useState(false)

  const [title, setTitle] = useState('')
  const [location, setLocation] = useState('')
  const [date, setDate] = useState('')
  const [storageUsage, setStorageUsage] = useState<AdminStorageUsage | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null)

  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [savingHero, setSavingHero] = useState(false)
  const heroFileInputRef = useRef<HTMLInputElement | null>(null)

  const [heroFile, setHeroFile] = useState<File | null>(null)
  const [heroPreviewUrl, setHeroPreviewUrl] = useState<string | null>(null)
  const [currentHeroUrl, setCurrentHeroUrl] = useState<string | null>(null)
  
  const [editingPhotoId, setEditingPhotoId] = useState<string | null>(null)
  const [editCategory, setEditCategory] = useState('okategoriserad')
  const [editLocation, setEditLocation] = useState('')
  const [editDate, setEditDate] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  // Quota and remaining space come from the server (MEDIA_QUOTA_MB).
  const remainingMb = storageUsage?.remaining_mb ?? 0
  const usedPercent =
    storageUsage && storageUsage.quota_bytes > 0
      ? Math.min((storageUsage.total_bytes / storageUsage.quota_bytes) * 100, 100)
      : 0

  useEffect(() => {
    loadPhotos()
    loadHeroImage()
  }, [])

async function loadHeroImage() {
  try {
    setCurrentHeroUrl(await api.getHero())
  } catch (error) {
    if (!isAuthLost(error)) console.error('Hero lookup failed', adminErrorCode(error))
  }
}

function selectHeroFile(file: File | null) {
  if (!file) return

  if (!file.type.startsWith('image/')) {
    alert('Välj en bildfil.')
    return
  }

  if (file.size > 15 * 1024 * 1024) {
    alert('Landningsbilden får vara högst 15 MB.')
    return
  }

  if (heroPreviewUrl) {
    URL.revokeObjectURL(heroPreviewUrl)
  }

  setHeroFile(file)
  setHeroPreviewUrl(URL.createObjectURL(file))
}
  
  async function loadPhotos() {
    setLoading(true)

    try {
      const [photoData, usageData, categoryData] = await Promise.all([
        api.getPhotos(),
        api.getStorageUsage(),
        api.getCategories(),
      ])

      setPhotos(photoData)
      setStorageUsage(usageData)
      setCategories(categoryData)
      setLoadError(null)

      // Drop selections of photos that no longer exist.
      setSelectedPhotoIds((current) => current.filter((id) => photoData.some((photo) => photo.id === id)))

      if (categoryData.length > 0) {
        const categoryStillExists = categoryData.some((cat) => cat.key === category)

        if (!categoryStillExists) {
          setCategory(categoryData[0].key)
        }
      }
    } catch (error) {
      if (!isAuthLost(error)) {
        console.error('Admin data could not be loaded', adminErrorCode(error))
        setLoadError(`Kunde inte hämta foton: ${adminErrorMessage(error)}`)
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleLogout() {
    await onLogout()
  }


async function uploadFiles(files: File[]) {
  if (!files.length) {
    return
  }

  if (!category) {
    alert('Välj en kategori.')
    return
  }

  const images = files.filter((file) => file.type.startsWith('image/'))

  if (images.length === 0) {
    alert('Kunde inte ladda upp fotona: Inga giltiga bilder valdes.')
    return
  }

  setUploading(true)

  const metadata = { category, title, location, date }

  // Sequential requests of at most ADMIN_UPLOAD_BATCH_SIZE photos each (full
  // image + thumbnail per photo). A failed batch stops the rest; batches that
  // already succeeded stay uploaded.
  const result = await uploadInBatches(images, ADMIN_UPLOAD_BATCH_SIZE, async (batch, index, total) => {
    setUploadProgress({ current: index + 1, total })

    const items: UploadItem[] = []
    for (const file of batch) {
      try {
        const variants = await createImageVariants(file)
        items.push({ full: variants.full, thumbnail: variants.thumbnail, originalName: file.name })
      } catch (error) {
        throw preparationError(error)
      }
    }

    await api.uploadPhotos(items, metadata)

    // Uploaded files leave the selection at once, so a retry never sends them again.
    setSelectedFiles((current) => current.filter((file) => !batch.includes(file)))
  })

  setUploadProgress(null)
  setUploading(false)

  if (result.error !== null && isAuthLost(result.error)) {
    return
  }

  if (result.error === null) {
    setTitle('')
    setLocation('')
    setDate('')
    setSelectedFiles([])

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }

    console.log(`${result.uploaded.length} photos uploaded`)
  } else if (result.uploaded.length > 0) {
    console.error('Gallery upload stopped', adminErrorCode(result.error) ?? 'unknown_error')
    alert(
      `${result.uploaded.length} av ${images.length} foton laddades upp. ` +
        `De övriga ${result.notUploaded.length} laddades inte upp: ${adminErrorMessage(result.error)} ` +
        'De finns kvar i listan, så du kan försöka igen.'
    )
  } else {
    reportError('Kunde inte ladda upp fotona', result.error)
  }

  // Show the server's actual state, also after a partial failure.
  await loadPhotos()
}


async function deletePhoto(photo: Photo) {
  const confirmed = window.confirm(
    `Radera "${photo.title || photo.name}"?`
  )

  if (!confirmed) return

  try {
    await api.deletePhoto(photo.id)

    setSelectedPhotoIds((current) =>
      current.filter((id) => id !== photo.id)
    )
  } catch (error) {
    reportError('Kunde inte radera fotot', error)
    if (isAuthLost(error)) return
  }

  await loadPhotos()
}

    function startEditing(photo: Photo) {
      setEditingPhotoId(photo.id)
      setEditCategory(photo.category)
      setEditLocation(photo.location || '')
      setEditDate(photo.date || '')
    }

    function cancelEditing() {
      setEditingPhotoId(null)
      setEditCategory(categories[0]?.key || 'okategoriserad')
      setEditLocation('')
      setEditDate('')
    }


async function saveHeroPhoto() {
  if (!heroFile) {
    alert('Välj en landningsbild först.')
    return
  }

  const confirmed = window.confirm(
    'Vill du ersätta den nuvarande landningsbilden?'
  )

  if (!confirmed) return

  setSavingHero(true)

  try {
    let prepared: File
    try {
      prepared = (await createHeroImageVariant(heroFile)).file
    } catch (error) {
      throw preparationError(error)
    }

    const result = await api.uploadHero(prepared)

    setHeroFile(null)

    if (heroPreviewUrl) {
      URL.revokeObjectURL(heroPreviewUrl)
    }

    setHeroPreviewUrl(null)

    if (heroFileInputRef.current) {
      heroFileInputRef.current.value = ''
    }

    // A new hero always gets a new URL, so no cache-busting is needed.
    setCurrentHeroUrl(result.url)

    await loadPhotos()
  } catch (error) {
    reportError('Kunde inte uppdatera landningsbilden', error)
  } finally {
    setSavingHero(false)
  }
}


async function savePhotoEdit(photoId: string) {
  setSavingEdit(true)

  try {
    // All four keys, always: null clears location/date. Title is not editable.
    const updated = await api.updatePhoto({
      id: photoId,
      category: editCategory,
      location: editLocation.trim() || null,
      date: editDate || null,
    })

    setPhotos((current) =>
      current.map((photo) => (photo.id === updated.id ? updated : photo))
    )

    cancelEditing()
  } catch (error) {
    reportError('Kunde inte uppdatera fotot', error)
  } finally {
    setSavingEdit(false)
  }
}

    function togglePhotoSelection(photoId: string) {
    setSelectedPhotoIds((current) =>
      current.includes(photoId)
        ? current.filter((id) => id !== photoId)
        : [...current, photoId]
    )
}

function clearSelection() {
  setSelectedPhotoIds([])
}

async function deleteSelectedPhotos() {
  if (selectedPhotoIds.length === 0) {
    return
  }

  if (selectedPhotoIds.length > MAX_BULK_DELETE) {
    alert(`Du kan radera högst ${MAX_BULK_DELETE} foton åt gången.`)
    return
  }

  const confirmed = window.confirm(
    `Vill du radera ${selectedPhotoIds.length} markerade foton?`
  )

  if (!confirmed) return

  setDeletingSelected(true)

  let refresh = true

  try {
    const result = await api.bulkDeletePhotos(selectedPhotoIds)

    // Photos that were already gone (notFoundIds) need no message.
    setSelectedPhotoIds([])

    console.log(`${result.deletedCount} photos deleted`)
  } catch (error) {
    reportError('Kunde inte radera fotona', error)
    refresh = !isAuthLost(error)
  } finally {
    setDeletingSelected(false)
  }

  if (refresh) {
    await loadPhotos()
  }
}

    function addSelectedFiles(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))

    setSelectedFiles((current) => [...current, ...imageFiles])
  }

  function removeSelectedFile(indexToRemove: number) {
    setSelectedFiles((current) =>
      current.filter((_, index) => index !== indexToRemove)
    )
  }

  function clearSelectedFiles() {
    setSelectedFiles([])
  }

async function handleAddCategory() {
  const label = newCategoryLabel.trim()

  if (!label) {
    alert('Skriv ett kategorinamn.')
    return
  }

  setCategoryLoading(true)

  try {
    // The server normalises the label and generates the key.
    const created = await api.createCategory(label)

    setNewCategoryLabel('')

    await loadPhotos()

    setCategory(created.key)
  } catch (error) {
    reportError('Kunde inte lägga till kategorin', error)
  } finally {
    setCategoryLoading(false)
  }
}

async function handleDeleteCategory(
  key: string,
  label: string
) {
  if (key === 'okategoriserad') {
    alert('Okategoriserad kan inte raderas.')
    return
  }

  const confirmed = window.confirm(
    `Radera kategorin "${label}"? Foton i kategorin flyttas till Okategoriserad.`
  )

  if (!confirmed) return

  setCategoryLoading(true)

  try {
    // The server moves the photos to Okategoriserad and deletes the category in one transaction.
    await api.deleteCategory(key)

    // Avoid keeping a deleted category selected in the upload form.
    if (category === key) {
      setCategory('okategoriserad')
    }

    // Avoid keeping a deleted category selected in the edit form.
    if (editCategory === key) {
      setEditCategory('okategoriserad')
    }

    await loadPhotos()
  } catch (error) {
    reportError('Kunde inte radera kategorin', error)
  } finally {
    setCategoryLoading(false)
  }
}


function getCategoryLabel(key: string) {
  return categories.find((cat) => cat.key === key)?.label || key
}


  return (
    <>
    <Navbar />
    <main
      className="admin-page"
      style={{
        minHeight: '100vh',
        background: '#111',
        color: '#fff',
      }}
    >
      <div className="admin-container" style={{ maxWidth: '1100px', margin: '0 auto' }}>
        <header className="admin-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: '1rem',
            marginBottom: '3rem',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 'clamp(2rem, 5vw, 4rem)',
                fontWeight: 300,
                letterSpacing: '-0.04em',
                margin: 0,
              }}
            >
              Admin
            </h1>
          </div>

          {storageUsage && (
            <div className="admin-storage-panel"
              style={{
                marginTop: '1.5rem',
                padding: '1rem',
                border: '1px solid #252525',
                background: '#151515',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '0.75rem',
                  gap: '1rem',
                  color: '#aaa',
                  fontSize: '0.85rem',
                  flexWrap: 'wrap',
                }}
              >
                <span> {storageUsage.total_mb} MB använt</span>
                <span> {remainingMb.toFixed(2)} MB kvar</span>
              </div>

              <div
                style={{
                  height: '6px',
                  background: '#252525',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${usedPercent}%`,
                    background: '#fff',
                  }}
                />
              </div>
            </div>
          )}

          <button
            className='admin-header-button'
            type="button"
            onClick={loadPhotos}
            style={{
              background: 'transparent',
              color: '#aaa',
              border: '1px solid #333',
              padding: '0.8rem 1rem',
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              fontSize: '0.72rem',
            }}
          >
            Uppdatera
          </button>
          <button
            type="button"
            onClick={handleLogout}
            style={{
                background: 'transparent',
                color: '#ff6b6b',
                border: '1px solid #3a2020',
                padding: '0.8rem 1rem',
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                fontSize: '0.72rem',
            }}
            >
            Logga ut
            </button>
        </header>

        <section
          style={{
            border: '1px solid #252525',
            background: '#151515',
            padding: 'clamp(1.25rem, 4vw, 2rem)',
            marginBottom: '3rem',
          }}
        >
          <h2
            style={{
              fontWeight: 300,
              fontSize: '1.4rem',
              marginTop: 0,
              marginBottom: '1.5rem',
            }}
          >
            Ladda upp nya foton
          </h2>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
              gap: '1rem',
              marginBottom: '1.5rem',
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ color: '#777', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Kategori
              </span>

              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                style={inputStyle}
                disabled={categories.length === 0}
              >
                {categories.length === 0 ? (
                  <option value="">Inga kategorier</option>
                ) : (
                  categories.map((cat) => (
                    <option key={cat.key} value={cat.key}>
                      {cat.label}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ color: '#777', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Titel
              </span>

              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Valfritt"
                style={inputStyle}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ color: '#777', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Plats
              </span>

              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Valfritt"
                style={inputStyle}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ color: '#777', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Datum
              </span>

              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={inputStyle}
              />
            </label>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragActive(false)
              addSelectedFiles(Array.from(e.dataTransfer.files))
            }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: dragActive ? '1px solid #fff' : '1px dashed #444',
              background: dragActive ? '#202020' : '#111',
              padding: 'clamp(2rem, 6vw, 4rem)',
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'border 0.2s, background 0.2s',
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addSelectedFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />

            <p
              style={{
                margin: 0,
                fontSize: 'clamp(1.1rem, 3vw, 1.8rem)',
                fontWeight: 300,
              }}
            >
              {uploading ? 'Laddar...' : 'Släpp foton här'}
            </p>

            <p style={{ color: '#666', marginBottom: 0 }}>
              eller klicka för att välja filer
              {storageUsage && (
                <>
                  <br /> (max {remainingMb.toFixed(2)} MB kvar)
                </>
              )}
            </p>
          </div>
          {selectedFiles.length > 0 && (
          <div
            style={{
              marginTop: '1.5rem',
              border: '1px solid #252525',
              background: '#111',
              padding: '1rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '1rem',
                marginBottom: '1rem',
                flexWrap: 'wrap',
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: '#aaa',
                  fontSize: '0.85rem',
                }}
              >
                {selectedFiles.length} foton valda
              </p>

              <button
                type="button"
                onClick={clearSelectedFiles}
                disabled={uploading}
                style={{
                  background: 'transparent',
                  color: '#aaa',
                  border: '1px solid #333',
                  padding: '0.65rem 0.85rem',
                  cursor: uploading ? 'not-allowed' : 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  fontSize: '0.68rem',
                  opacity: uploading ? 0.6 : 1,
                }}
              >
                Rensa
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
  'repeat(auto-fill, minmax(min(100%, 220px), 1fr))',
                gap: '0.75rem',
                marginBottom: '1rem',
              }}
            >
              {selectedFiles.map((file, index) => (
                <div
                  key={`${file.name}-${index}`}
                  style={{
                    border: '1px solid #252525',
                    background: '#151515',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      aspectRatio: '4 / 3',
                      background: '#0b0b0b',
                      overflow: 'hidden',
                    }}
                  >
                    <img
                      src={URL.createObjectURL(file)}
                      alt={file.name}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                  </div>

                  <div style={{ padding: '0.65rem' }}>
                    <p
                      style={{
                        margin: '0 0 0.5rem',
                        color: '#777',
                        fontSize: '0.72rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={file.name}
                    >
                      {file.name}
                    </p>

                    <button
                      type="button"
                      onClick={() => removeSelectedFile(index)}
                      disabled={uploading}
                      style={{
                        width: '100%',
                        background: 'transparent',
                        color: '#ff6b6b',
                        border: '1px solid #3a2020',
                        padding: '0.5rem',
                        cursor: uploading ? 'not-allowed' : 'pointer',
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        fontSize: '0.65rem',
                        opacity: uploading ? 0.6 : 1,
                      }}
                    >
                      Ta bort
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => uploadFiles(selectedFiles)}
              disabled={uploading || selectedFiles.length === 0}
              style={{
                width: '100%',
                background: '#fff',
                color: '#111',
                border: 'none',
                padding: '0.9rem 1rem',
                cursor: uploading ? 'not-allowed' : 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                fontSize: '0.75rem',
                opacity: uploading ? 0.6 : 1,
              }}
            >
              {uploading
                ? uploadProgress && uploadProgress.total > 1
                  ? `Laddar upp ${uploadProgress.current} av ${uploadProgress.total}…`
                  : 'Laddar upp...'
                : 'Ladda upp valda foton'}
            </button>
          </div>
        )}
        </section>

        <div
  className="admin-management-grid"
  style={{
    display: 'grid',
    gap: '1rem',
    alignItems: 'stretch',
    marginBottom: '3rem',
  }}
>
  {/* Category management */}
  <section
  className="admin-category-panel"
    style={{
      border: '1px solid #252525',
      background: '#151515',
      padding: 'clamp(1.25rem, 4vw, 2rem)',
    }}
  >
    <h2
      style={{
        fontWeight: 300,
        fontSize: '1.4rem',
        marginTop: 0,
        marginBottom: '1.5rem',
      }}
    >
      Kategorier
    </h2>

    <div
      className="admin-category-form"
      style={{
        display: 'flex',
        gap: '0.75rem',
        marginBottom: '1.5rem',
        flexWrap: 'wrap',
      }}
    >
      <input
        className='admin-category-input'
        value={newCategoryLabel}
        onChange={(e) => setNewCategoryLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleAddCategory()
          }
        }}
        placeholder="Ny kategori"
        style={{
          ...inputStyle,
          flex: '1 1 220px',
        }}
      />

      <button
        className="admin-category-add-button"
        type="button"
        onClick={handleAddCategory}
        disabled={categoryLoading || !newCategoryLabel.trim()}
        style={{
          background: '#fff',
          color: '#111',
          border: 'none',
          padding: '0.8rem 1rem',
          cursor: categoryLoading ? 'not-allowed' : 'pointer',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontSize: '0.72rem',
          opacity:
            categoryLoading || !newCategoryLabel.trim() ? 0.6 : 1,
        }}
      >
        Lägg till
      </button>
    </div>

    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.75rem',
      }}
    >
      {categories.map((cat) => (
        <div
          key={cat.key}
          className="admin-category-chip"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.65rem',
            border: '1px solid #333',
            padding: '0.65rem 0.85rem',
            background: '#111',
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          <span
            style={{
              color: '#aaa',
              fontSize: '0.8rem',
              overflowWrap: 'anywhere',
              minWidth: 0,
            }}
          >
            {cat.label}
          </span>

          {cat.key !== 'okategoriserad' && (
            <button
              type="button"
              onClick={() =>
                handleDeleteCategory(cat.key, cat.label)
              }
              disabled={categoryLoading}
              aria-label={`Radera kategorin ${cat.label}`}
              style={{
                background: 'transparent',
                color: '#ff6b6b',
                border: 'none',
                cursor: categoryLoading ? 'not-allowed' : 'pointer',
                fontSize: '1.1rem',
                padding: '0.2rem 0.35rem',
                flexShrink: 0,
                minWidth: '32px',
                minHeight: '32px',
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  </section>

  {/* Hero editor */}
      <section
      className="admin-hero-panel"
      style={{
        border: '1px solid #252525',
        background: '#151515',
        padding: 'clamp(1rem, 4vw, 1.5rem)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
  <h2
    style={{
      fontWeight: 300,
      fontSize: '1.1rem',
      margin: '0 0 1rem',
    }}
  >
    Landningsbild
  </h2>

  <div
    className="admin-hero-preview"
    style={{
      position: 'relative',
      aspectRatio: '16 / 10',
      width: '100%',
      minHeight: 0,
      overflow: 'hidden',
      background: '#0b0b0b',
      marginBottom: '1rem',
    }}
  >
    {heroPreviewUrl || currentHeroUrl ? (
      <img
        src={heroPreviewUrl || currentHeroUrl || ''}
        alt="Förhandsvisning av landningsbild"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
        }}
      />
    ) : (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          color: '#666',
          fontSize: '0.75rem',
          textAlign: 'center',
          padding: '1rem',
        }}
      >
        Ingen landningsbild vald
      </div>
    )}

    {heroPreviewUrl && (
      <span
        style={{
          position: 'absolute',
          top: '0.6rem',
          left: '0.6rem',
          background: 'rgba(0,0,0,0.75)',
          color: '#fff',
          padding: '0.4rem 0.55rem',
          fontSize: '0.62rem',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
        }}
      >
        Ny förhandsvisning
      </span>
    )}
  </div>

  <input
    ref={heroFileInputRef}
    type="file"
    accept="image/*"
    hidden
    onChange={(e) => {
      selectHeroFile(e.target.files?.[0] || null)
    }}
  />

  <button
    type="button"
    onClick={() => heroFileInputRef.current?.click()}
    disabled={savingHero}
    style={{
      width: '100%',
      background: 'transparent',
      color: '#aaa',
      border: '1px solid #444',
      padding: '0.8rem',
      cursor: savingHero ? 'not-allowed' : 'pointer',
      textTransform: 'uppercase',
      letterSpacing: '0.12em',
      fontSize: '0.7rem',
      marginBottom: '0.75rem',
      opacity: savingHero ? 0.6 : 1,
    }}
  >
    Välj ny bild
  </button>

  {heroFile && (
  <button
    type="button"
    onClick={saveHeroPhoto}
    disabled={savingHero}
    style={{
      width: '100%',
      marginTop: 'auto',
      background: '#fff',
      color: '#111',
      border: '1px solid #fff',
      padding: '0.8rem',
      cursor: savingHero ? 'not-allowed' : 'pointer',
      textTransform: 'uppercase',
      letterSpacing: '0.12em',
      fontSize: '0.7rem',
      opacity: savingHero ? 0.6 : 1,
    }}
  >
    {savingHero ? 'Laddar upp...' : 'Spara landningsbild'}
  </button>
)}

  
</section>
</div>

        <section>
          <div
            className="admin-photo-list-header"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '1rem',
              marginBottom: '1.5rem',
            }}
          >
            <h2
              style={{
                fontWeight: 300,
                fontSize: '1.4rem',
                margin: 0,
              }}
            >
              Nuvarande foton
            </h2>

            <div
            className="admin-photo-list-actions"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              flexWrap: 'wrap',
            }}
        >
          <span style={{ color: '#666', fontSize: '0.85rem' }}>
            {photos.length} foton
          </span>

          {selectedPhotoIds.length > 0 && (
            <>
              <span style={{ color: '#777', fontSize: '0.85rem' }}>
                {selectedPhotoIds.length} markerade
              </span>

              <button
                type="button"
                onClick={clearSelection}
                style={{
                  background: 'transparent',
                  color: '#aaa',
                  border: '1px solid #333',
                  padding: '0.55rem 0.75rem',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  fontSize: '0.68rem',
                }}
              >
                Avmarkera
              </button>

              <button
                type="button"
                onClick={deleteSelectedPhotos}
                disabled={deletingSelected}
                style={{
                  background: 'transparent',
                  color: '#ff6b6b',
                  border: '1px solid #3a2020',
                  padding: '0.55rem 0.75rem',
                  cursor: deletingSelected ? 'not-allowed' : 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  fontSize: '0.68rem',
                  opacity: deletingSelected ? 0.6 : 1,
                }}
              >
                {deletingSelected ? 'Raderar...' : 'Radera markerade'}
              </button>
            </>
          )}
        </div>
          </div>

          {loadError && (
            <p role="alert" style={{ color: '#ff6b6b' }}>{loadError}</p>
          )}

          {loading ? (
            <p style={{ color: '#777' }}>Laddar foton...</p>
          ) : photos.length === 0 ? (
            <p style={{ color: '#777' }}>Inga foton laddade ännu.</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
  'repeat(auto-fill, minmax(min(100%, 220px), 1fr))',
                gap: '1rem',
              }}
            >
              {photos.map((photo) => (
                <article
                  key={photo.id}
                  style={{
                    background: '#151515',
                    border: '1px solid #252525',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      aspectRatio: '4 / 3',
                      background: '#0b0b0b',
                      overflow: 'hidden',
                    }}
                  >
                    <label
                      style={{
                        position: 'absolute',
                        top: '0.75rem',
                        left: '0.75rem',
                        zIndex: 2,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        background: 'rgba(0,0,0,0.7)',
                        color: '#fff',
                        padding: '0.45rem 0.55rem',
                        fontSize: '0.7rem',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPhotoIds.includes(photo.id)}
                        onChange={() => togglePhotoSelection(photo.id)}
                      />
                      Markera
                    </label>
                    <img
                      src={photo.url}
                      alt={photo.title || photo.name}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                  </div>

                  <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', flex: 1, }}>
                    <h3
                      style={{
                        fontSize: '1rem',
                        fontWeight: 400,
                        margin: '0 0 0.5rem',
                      }}
                    >
                      {photo.title || photo.name}
                    </h3>

                    {editingPhotoId === photo.id ? (
                      <div
                        style={{
                          display: 'grid',
                          gap: '0.6rem',
                          marginBottom: '1rem',
                          minHeight: '4.2rem',
                        }}
                      >
                        <select
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value)}
                          style={inputStyle}
                        >
                          {categories.map((cat) => (
                            <option key={cat.key} value={cat.key}>
                              {cat.label}
                            </option>
                          ))}
                        </select>

                        <input
                          value={editLocation}
                          onChange={(e) => setEditLocation(e.target.value)}
                          placeholder="Plats"
                          style={inputStyle}
                        />

                        <input
                          type="date"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                          style={inputStyle}
                        />
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'grid',
                          gap: '0.25rem',
                          marginBottom: '1rem',
                          minHeight: '4.2rem',
                        }}
                      >
                        <p style={{ margin: 0, color: '#777', fontSize: '0.8rem' }}>
                          Kategori: {getCategoryLabel(photo.category)}
                        </p>

                        <p style={{ margin: 0, color: '#777', fontSize: '0.8rem' }}>
                          Plats: {photo.location || '—'}
                        </p>

                        <p style={{ margin: 0, color: '#777', fontSize: '0.8rem' }}>
                          Datum: {photo.date || '—'}
                        </p>
                      </div>
                    )}

                    {editingPhotoId === photo.id ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: '0.5rem',
                        marginTop: 'auto',
                        marginBottom: '0.5rem',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => savePhotoEdit(photo.id)}
                        disabled={savingEdit}
                        style={{
                          background: 'transparent',
                          color: '#fff',
                          border: '1px solid #444',
                          padding: '0.75rem',
                          cursor: savingEdit ? 'not-allowed' : 'pointer',
                          textTransform: 'uppercase',
                          letterSpacing: '0.12em',
                          fontSize: '0.72rem',
                          opacity: savingEdit ? 0.6 : 1,
                        }}
                      >
                        {savingEdit ? 'Sparar...' : 'Spara'}
                      </button>

                      <button
                        type="button"
                        onClick={cancelEditing}
                        style={{
                          background: 'transparent',
                          color: '#aaa',
                          border: '1px solid #333',
                          padding: '0.75rem',
                          cursor: 'pointer',
                          textTransform: 'uppercase',
                          letterSpacing: '0.12em',
                          fontSize: '0.72rem',
                        }}
                      >
                        Avbryt
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEditing(photo)}
                      style={{
                        width: '100%',
                        marginTop: 'auto',
                        marginBottom: '0.5rem',
                        background: 'transparent',
                        color: '#aaa',
                        border: '1px solid #333',
                        padding: '0.75rem',
                        cursor: 'pointer',
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        fontSize: '0.72rem',
                      }}
                    >
                      Redigera
                    </button>
                  )}

                    <button
                      onClick={() => deletePhoto(photo)}
                      style={{
                        width: '100%',
                        background: 'transparent',
                        color: '#ff6b6b',
                        border: '1px solid #3a2020',
                        padding: '0.75rem',
                        cursor: 'pointer',
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        fontSize: '0.72rem',
                      }}
                    >
                      Radera
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
    </>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
  background: '#111',
  color: '#fff',
  border: '1px solid #333',
  padding: '0.8rem 1rem',
  fontSize: '16px',
}