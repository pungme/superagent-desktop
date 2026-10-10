import { useEffect, useState } from 'react'
import { useOverlayLock } from '../state'
import { imagesByDay, type ChatImageRef } from '../../../shared/chat-images'

/** A picture being shown large, and the file it came from when there is one. */
export interface Shown {
  src: string
  origin?: string
}

/** A picture the window can load by itself, rather than a file to ask the Mac for. */
const WEB = /^(https?|data|blob):/i

const DownloadIcon = (): React.JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M8 2.5v7.2m0 0L5.2 7m2.8 2.7L10.8 7M3 12.5h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/**
 * Saving a picture to Downloads, and saying where it went. One per button:
 * the note belongs to the picture that was saved.
 */
function useSave(
  image: Shown | null,
  cwd?: string
): {
  saving: boolean
  saved: { path: string; name: string } | null
  error: string
  save: () => void
} {
  const [saving, setSaving] = useState(false)
  // What happened is kept with the picture it happened to, so the note does
  // not carry over when another picture takes its place.
  const key = image ? image.src.slice(0, 80) + (image.origin ?? '') : ''
  const [done, setDone] = useState<{
    key: string
    saved?: { path: string; name: string }
    error?: string
  } | null>(null)
  const save = (): void => {
    if (!image || saving) return
    setSaving(true)
    setDone(null)
    void window.cove
      .imageSave({ src: image.src, origin: image.origin, base: cwd })
      .then((r) =>
        setDone(r.ok ? { key, saved: { path: r.path, name: r.name } } : { key, error: r.error })
      )
      .catch(() => setDone({ key, error: 'That picture could not be saved.' }))
      .finally(() => setSaving(false))
  }
  const mine = done?.key === key ? done : null
  return { saving, saved: mine?.saved ?? null, error: mine?.error ?? '', save }
}

/**
 * The small Download that shows in a picture's corner when the pointer is
 * over it, in the conversation itself. Its parent is the frame it sits in.
 */
export function SaveCorner({ image, cwd }: { image: Shown; cwd?: string }): React.JSX.Element {
  const { saving, saved, error, save } = useSave(image, cwd)
  return (
    <button
      className={`img-save-corner ${saved ? 'done' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        save()
      }}
      disabled={saving}
      aria-label={saved ? `Saved as ${saved.name}` : 'Download picture'}
      title={saved ? `Saved to Downloads as ${saved.name}` : error || 'Save to Downloads'}
    >
      {saved ? '✓' : <DownloadIcon />}
    </button>
  )
}

/** A picture, full size, over the chat: click outside or Esc to close, and a way to keep it. */
export function Lightbox({
  image,
  cwd,
  onClose
}: {
  image: Shown
  cwd?: string
  onClose: () => void
}): React.JSX.Element {
  const { saving, saved, error, save } = useSave(image, cwd)
  return (
    <div className="easy-lightbox" onClick={onClose}>
      <div className="easy-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {saved ? (
          <span className="easy-lightbox-note" role="status">
            Saved to Downloads as {saved.name}
            <button onClick={() => window.cove.imageReveal(saved.path)}>Show in Finder</button>
          </span>
        ) : error ? (
          <span className="easy-lightbox-note" role="alert">
            {error}
          </span>
        ) : null}
        <button
          className="easy-lightbox-btn"
          onClick={save}
          disabled={saving}
          title="Save to Downloads"
        >
          <DownloadIcon />
          {saving ? 'Saving…' : 'Download'}
        </button>
        <button
          className="easy-lightbox-btn icon"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <img src={image.src} alt="attachment" />
    </div>
  )
}

/** One picture of the grid: found where it lives, then shown. */
function Tile({
  image,
  cwd,
  onOpen,
  onShowInChat
}: {
  image: ChatImageRef
  cwd: string
  onOpen: (shown: Shown) => void
  onShowInChat?: (image: ChatImageRef) => void
}): React.JSX.Element | null {
  // undefined while it is being fetched, null when it is gone.
  const ready =
    image.kind === 'data' || (image.kind === 'path' && WEB.test(image.src)) ? image.src : undefined
  const [src, setSrc] = useState<string | null | undefined>(ready)
  useEffect(() => {
    if (ready !== undefined) return
    let alive = true
    const got = (r: { mediaType: string; data: string } | null): void => {
      if (alive) setSrc(r ? `data:${r.mediaType};base64,${r.data}` : null)
    }
    if (image.kind === 'remote')
      void window.cove.chatImage(image.id, image.index).then(got, () => got(null))
    else if (image.kind === 'path')
      void window.cove
        .fileThumbnail(image.src, { base: cwd, width: 1600 })
        .then(got, () => got(null))
    return () => {
      alive = false
    }
  }, [image, cwd, ready])
  const shown: Shown | null = src
    ? { src, origin: image.kind === 'path' ? image.src : undefined }
    : null
  const { saving, saved, save } = useSave(shown, cwd)
  // A picture whose file has since been deleted is left out rather than shown broken.
  if (src === null) return null
  const label = image.kind === 'path' && image.alt ? image.alt : 'Picture'
  return (
    <div className="chat-images-tile" data-from={image.from}>
      {shown ? (
        <button
          className="chat-images-open"
          onClick={() => onOpen(shown)}
          title={`${label} — click to enlarge`}
        >
          <img src={shown.src} alt={label} loading="lazy" />
        </button>
      ) : (
        <span className="chat-images-loading" aria-hidden="true" />
      )}
      {onShowInChat ? (
        <button
          className="chat-images-who as-link"
          onClick={() => onShowInChat(image)}
          title="Show where this is in the chat"
        >
          {image.from === 'you' ? 'You' : 'Agent'} · show in chat
        </button>
      ) : (
        <span className="chat-images-who">{image.from === 'you' ? 'You' : 'Agent'}</span>
      )}
      {shown && (
        <button
          className={`chat-images-save ${saved ? 'done' : ''}`}
          onClick={save}
          disabled={saving}
          aria-label={saved ? `Saved as ${saved.name}` : `Download ${label}`}
          title={saved ? `Saved to Downloads as ${saved.name}` : 'Save to Downloads'}
        >
          {saved ? '✓' : <DownloadIcon />}
        </button>
      )}
    </div>
  )
}

/**
 * Every picture in the conversation, newest first: what was attached, what the
 * agent captured and what it showed. Click one to see it large; each can be
 * saved to Downloads.
 */
export function ChatImagesView({
  images,
  cwd,
  covered,
  onOpen,
  onClose,
  onShowInChat
}: {
  images: ChatImageRef[]
  cwd: string
  /** A picture is open on top of this: Esc is that one's to take. */
  covered: boolean
  onOpen: (shown: Shown) => void
  onClose: () => void
  /** Close this and go to the message a picture came from. */
  onShowInChat?: (image: ChatImageRef) => void
}): React.JSX.Element {
  useOverlayLock(true)
  useEffect(() => {
    if (covered) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [covered, onClose])
  const days = imagesByDay(images)
  // Pictures with no date at all (an older chat): a heading would say nothing.
  const headed = days.some((g) => g.day !== 'Earlier')
  return (
    <div className="chat-images" role="dialog" aria-label="Images in this chat" onClick={onClose}>
      <div className="chat-images-panel" onClick={(e) => e.stopPropagation()}>
        <div className="chat-images-head">
          <span>
            Images in this chat <em>{images.length}</em>
          </span>
          <button className="chat-images-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="chat-images-scroll">
          {days.map((g) => (
            <section key={g.day + g.images[0].key}>
              {headed && <h3 className="chat-images-day">{g.day}</h3>}
              <div className="chat-images-grid">
                {g.images.map((im) => (
                  <Tile
                    key={im.key}
                    image={im}
                    cwd={cwd}
                    onOpen={onOpen}
                    onShowInChat={onShowInChat}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
