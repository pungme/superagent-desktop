import { ReactNode } from 'react'

/** The applications that live on the Computer desktop. */
export type AppId = 'chat' | 'browser' | 'dashboard' | 'skills' | 'routines' | 'file' | 'folder'

export interface DesktopApp {
  id: AppId
  name: string
  icon: ReactNode
  /** Where its window opens the first time, before you move it. */
  initial: { w: number; h: number }
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

/**
 * Icons are drawn rather than emoji: at icon size an emoji carries its own
 * colour and baseline, and three of them side by side never look like one set.
 */
export const DESKTOP_APPS: DesktopApp[] = [
  {
    id: 'chat',
    name: 'Chat',
    initial: { w: 720, h: 620 },
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M20.5 12.2c0 4-3.8 7.2-8.5 7.2a9.9 9.9 0 01-2.6-.34L4.6 20.5l1.2-3.4A6.9 6.9 0 013.5 12.2C3.5 8.2 7.3 5 12 5s8.5 3.2 8.5 7.2z" />
      </svg>
    )
  },
  {
    id: 'browser',
    name: 'Browser',
    initial: { w: 1000, h: 680 },
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3.6 4.8 3.6 13.2 0 18M12 3C8.4 7.8 8.4 16.2 12 21" />
      </svg>
    )
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    initial: { w: 900, h: 620 },
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M4 20V11M9.5 20V5M15 20v-6.5M20.5 20V8" />
      </svg>
    )
  },
  {
    id: 'skills',
    name: 'Skills',
    initial: { w: 820, h: 560 },
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M12 3.2l2.6 5.8 6.2.6-4.7 4.2 1.4 6.1L12 16.7 6.5 19.9l1.4-6.1L3.2 9.6l6.2-.6z" />
      </svg>
    )
  },
  {
    id: 'routines',
    name: 'Routines',
    initial: { w: 780, h: 560 },
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <circle cx="12" cy="13.5" r="8" />
        <path d="M12 9v4.6l2.9 1.8M8.5 2.2h7" />
      </svg>
    )
  }
]

/**
 * A file opened from the desktop. Deliberately not in DESKTOP_APPS: there is
 * nothing to launch from the dock — a window of this kind only exists because
 * you opened a particular file.
 */
export const FILE_APP: DesktopApp = {
  id: 'file',
  name: 'File',
  initial: { w: 760, h: 560 },
  icon: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M13.5 3.2H7a1.8 1.8 0 00-1.8 1.8v14a1.8 1.8 0 001.8 1.8h10a1.8 1.8 0 001.8-1.8V8.5z" />
      <path d="M13.4 3.3v5.2h5.3" />
    </svg>
  )
}

/** A folder opened from the desk. Like FILE_APP, it exists only once opened. */
export const FOLDER_APP: DesktopApp = {
  id: 'folder',
  name: 'Folder',
  initial: { w: 560, h: 460 },
  icon: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M3 6.5A1.5 1.5 0 014.5 5h4l2 2.2h7A1.5 1.5 0 0119 8.7v9.3a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 013 18z" />
    </svg>
  )
}

export const appById = (id: AppId): DesktopApp =>
  id === 'file'
    ? FILE_APP
    : id === 'folder'
      ? FOLDER_APP
      : (DESKTOP_APPS.find((a) => a.id === id) ?? DESKTOP_APPS[0])
