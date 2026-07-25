import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { extractPorts } from '../lib/ports'

const DARK_THEME = {
  background: '#1e1f24',
  foreground: '#d8dae0',
  cursor: '#8b8ff8',
  cursorAccent: '#1e1f24',
  selectionBackground: 'rgba(139, 143, 248, 0.3)',
  black: '#282a30',
  red: '#f97583',
  green: '#85e89d',
  yellow: '#ffea7f',
  blue: '#79b8ff',
  magenta: '#b392f0',
  cyan: '#76e3ea',
  white: '#d8dae0',
  brightBlack: '#6a737d',
  brightRed: '#fdaeb7',
  brightGreen: '#bef5cb',
  brightYellow: '#fff5b1',
  brightBlue: '#c8e1ff',
  brightMagenta: '#d1bcf9',
  brightCyan: '#b3f0f5',
  brightWhite: '#fafbfc'
}

interface TerminalPaneProps {
  cwd?: string
  command?: string
  onExit?: (code: number) => void
  onPort?: (port: number) => void
}

export function TerminalPane({ cwd, command, onExit, onPort }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowTransparency: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: DARK_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL unavailable — canvas renderer fallback is automatic
    }
    fit.fit()

    let disposed = false
    let cleanupPty: (() => void) | undefined

    window.cove
      .ptyCreate({ cwd, command, cols: term.cols, rows: term.rows })
      .then((id) => {
        if (disposed) {
          window.cove.ptyKill(id)
          return
        }
        const offData = window.cove.onPtyData(id, (data) => {
          term.write(data)
          if (onPort) for (const port of extractPorts(data)) onPort(port)
        })
        const offExit = window.cove.onPtyExit(id, (code) => onExit?.(code))
        const onInput = term.onData((data) => window.cove.ptyWrite(id, data))
        const onResize = term.onResize(({ cols, rows }) => window.cove.ptyResize(id, cols, rows))
        cleanupPty = () => {
          offData()
          offExit()
          onInput.dispose()
          onResize.dispose()
          window.cove.ptyKill(id)
        }
      })
      .catch((err) => term.writeln(`\r\nFailed to start terminal: ${err.message}`))

    const resizeObserver = new ResizeObserver(() => fit.fit())
    resizeObserver.observe(container)

    return () => {
      disposed = true
      resizeObserver.disconnect()
      cleanupPty?.()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={containerRef} className="terminal-pane" />
}
