import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Push-to-talk dictation, transcribed locally by Whisper (transformers.js), in
 * a worker (asr.worker.ts) so the window never freezes while it works.
 *
 * The words appear while you speak: the audio so far is transcribed again
 * about once a second and shown as a guess (`partial`). When you stop, the
 * whole recording is transcribed once more, which is what lands in the
 * composer: a guess made mid-word is often wrong at its end.
 *
 * Nothing leaves the machine except the one-time model download. The Web
 * Speech API is not an option here: Electron ships Chromium without Google's
 * speech service keys, so SpeechRecognition fails with `network`.
 */

export type DictationState = 'idle' | 'loading-model' | 'recording' | 'transcribing'

const SAMPLE_RATE = 16_000
/** How often a fresh guess is made while speaking. */
const GUESS_EVERY_MS = 700
/** A guess covers at most this much audio; past it, what was heard is kept and a new window starts. */
const GUESS_WINDOW_S = 24

// --- the worker ------------------------------------------------------------------

let worker: Worker | null = null
let ready = false
let loading: Promise<void> | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()
const progressListeners = new Set<(pct: number) => void>()

/** Where the ONNX runtime's files are, resolved against the page (see asr.worker.ts). */
const ortBase = (): string => new URL('ort/', document.baseURI).href

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev: MessageEvent): void => {
    const m = ev.data as
      | { type: 'progress'; pct: number }
      | { type: 'ready' }
      | { type: 'result'; id: number; text: string }
      | { type: 'error'; id?: number; message: string }
    if (m.type === 'progress') progressListeners.forEach((f) => f(m.pct))
    else if (m.type === 'result') {
      waiting.get(m.id)?.resolve(m.text)
      waiting.delete(m.id)
    } else if (m.type === 'error' && m.id !== undefined) {
      waiting.get(m.id)?.reject(new Error(m.message))
      waiting.delete(m.id)
    }
  }
  return worker
}

/** Build the pipeline (downloading the model the first time). */
function loadModel(): Promise<void> {
  if (ready) return Promise.resolve()
  if (!loading) {
    const w = getWorker()
    loading = new Promise<void>((resolve, reject) => {
      const on = (ev: MessageEvent): void => {
        const m = ev.data as { type: string; id?: number; message?: string }
        if (m.type === 'ready') {
          w.removeEventListener('message', on)
          ready = true
          resolve()
        } else if (m.type === 'error' && m.id === undefined) {
          w.removeEventListener('message', on)
          loading = null // a failed download can be tried again
          reject(new Error(m.message))
        }
      }
      w.addEventListener('message', on)
      w.postMessage({ type: 'load', ortBase: ortBase() })
    })
  }
  return loading
}

function transcribe(samples: Float32Array, long: boolean): Promise<string> {
  const id = nextId++
  return new Promise<string>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    getWorker().postMessage({ type: 'run', id, samples, long, ortBase: ortBase() })
  })
}

/** Whisper's markers for silence and noise ("[BLANK_AUDIO]", "(wind blowing)") are not words. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The recorded pieces as one run of samples, from `from` on. */
function joined(pieces: Float32Array[], total: number, from = 0): Float32Array {
  const out = new Float32Array(Math.max(0, total - from))
  let at = 0
  let skip = from
  for (const p of pieces) {
    if (skip >= p.length) {
      skip -= p.length
      continue
    }
    const part = skip ? p.subarray(skip) : p
    skip = 0
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Said when macOS has the microphone off for Superagent. */
export const MIC_OFF =
  'Superagent is not allowed to use the microphone. Allow it in System Settings → Privacy & Security → Microphone.'

interface Dictation {
  state: DictationState
  /** macOS has the microphone off for Superagent: System Settings is the fix. */
  micDenied: boolean
  /** 0–1 while the model downloads the first time. */
  progress: number
  /** Live input level, 0–1, while recording — so the button can show it's hearing you. */
  level: number
  /** What has been heard so far, while recording and until the final text is in. A guess. */
  partial: string
  error: string | null
  start: () => Promise<void>
  /** Stops recording and resolves with the transcript ('' if nothing was said). */
  stop: () => Promise<string>
  /** Throw the recording away and close the mic — the way out of a stuck hold. */
  cancel: () => void
  /** Take the error line down. It also goes by itself on the next attempt. */
  dismiss: () => void
}

export function useDictation(): Dictation {
  const [state, setState] = useState<DictationState>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [micDenied, setMicDenied] = useState(false)
  const [level, setLevel] = useState(0)
  const [partial, setPartial] = useState('')
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingRef = useRef(false)
  /** The recording so far, as 16 kHz mono pieces. */
  const piecesRef = useRef<Float32Array[]>([])
  const totalRef = useRef(0)
  /** The guess in flight, so the final pass waits for it (one at a time in the worker). */
  const guessRef = useRef<Promise<void> | null>(null)
  const guessTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Where the current guess window starts, what was heard before it, and what it last said. */
  const windowRef = useRef({ start: 0, kept: '', said: '', saidUpTo: 0 })

  useEffect(() => {
    progressListeners.add(setProgress)
    return () => {
      progressListeners.delete(setProgress)
    }
  }, [])

  /** Close the microphone and everything listening to it. */
  const closeMic = useCallback((): void => {
    recordingRef.current = false
    if (guessTimerRef.current) clearInterval(guessTimerRef.current)
    guessTimerRef.current = null
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    void ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setLevel(0)
  }, [])

  /** One guess at what has been said so far, if the model is ready and there is new audio. */
  const guess = useCallback((): void => {
    if (!ready || guessRef.current || !recordingRef.current) return
    const w = windowRef.current
    const total = totalRef.current
    if (total < SAMPLE_RATE * 0.6 || total - w.saidUpTo < SAMPLE_RATE * 0.4) return
    // A long dictation: keep what the last window heard, and start a new one.
    if (total - w.start > SAMPLE_RATE * GUESS_WINDOW_S && w.said) {
      w.kept = [w.kept, w.said].filter(Boolean).join(' ')
      w.start = w.saidUpTo
      w.said = ''
    }
    const samples = joined(piecesRef.current, total, w.start)
    const upTo = total
    guessRef.current = transcribe(samples, false)
      .then((text) => {
        if (!recordingRef.current) return
        w.said = cleanTranscript(text)
        w.saidUpTo = upTo
        setPartial([w.kept, w.said].filter(Boolean).join(' '))
      })
      .catch(() => {
        /* a failed guess is only a missing preview; the final pass decides */
      })
      .finally(() => {
        guessRef.current = null
      })
  }, [])

  const stop = useCallback(async (): Promise<string> => {
    if (!recordingRef.current) return ''
    closeMic()
    const total = totalRef.current
    const pieces = piecesRef.current
    piecesRef.current = []
    totalRef.current = 0
    try {
      // Whisper hallucinates filler on near-silence; a very short clip is a
      // mis-press, not speech.
      if (total < SAMPLE_RATE * 0.3) return ''
      if (!ready) setState('loading-model')
      await loadModel()
      setState('transcribing')
      await guessRef.current
      return cleanTranscript(await transcribe(joined(pieces, total), true))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription failed')
      return ''
    } finally {
      setState('idle')
      setProgress(0)
      setPartial('')
    }
  }, [closeMic])

  const start = useCallback(async (): Promise<void> => {
    if (recordingRef.current) return
    setError(null)
    setMicDenied(false)
    setPartial('')
    // The app asks macOS for the microphone first: from the dot, a panel that
    // is never the active app, Chromium's own asking shows nothing and fails.
    try {
      const access = await window.cove.micAccess?.()
      if (access === 'denied' || access === 'restricted') {
        setMicDenied(true)
        setError(MIC_OFF)
        return
      }
    } catch {
      /* no answer is not a no: the page's own request below still decides */
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      // The samples Whisper wants, straight from the mic: 16 kHz, mono.
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      ctxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const tap = ctx.createScriptProcessor(4096, 1, 1)
      piecesRef.current = []
      totalRef.current = 0
      windowRef.current = { start: 0, kept: '', said: '', saidUpTo: 0 }
      tap.onaudioprocess = (e): void => {
        if (!recordingRef.current) return
        const piece = new Float32Array(e.inputBuffer.getChannelData(0))
        piecesRef.current.push(piece)
        totalRef.current += piece.length
      }
      // A processor only runs when connected through to the output; silenced.
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(tap)
      tap.connect(mute)
      mute.connect(ctx.destination)
      // Meter the input so the button can show it is actually hearing something.
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = (): void => {
        analyser.getByteTimeDomainData(data)
        let peak = 0
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
        setLevel(peak)
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
      recordingRef.current = true
      setState('recording')
      guessTimerRef.current = setInterval(guess, GUESS_EVERY_MS)
      // Warm the model while the user is still speaking, so a first-run download
      // overlaps with the recording instead of stalling after it.
      void loadModel().catch(() => {})
    } catch (e) {
      closeMic()
      setState('idle')
      const name = e instanceof Error ? e.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMicDenied(true)
        setError(MIC_OFF)
      } else setError(e instanceof Error ? e.message : 'Could not access the microphone')
    }
  }, [closeMic, guess])

  /**
   * Abandon a recording without transcribing it. Hold-to-talk has no exit if the
   * release is ever missed — the window losing focus mid-hold, or ⌥Space being
   * swallowed by a system shortcut — and a mic stuck open with no way to close
   * it is not something the user should have to restart the app over.
   */
  const cancel = useCallback((): void => {
    closeMic()
    piecesRef.current = []
    totalRef.current = 0
    setPartial('')
    setState('idle')
    setProgress(0)
  }, [closeMic])

  const dismiss = useCallback((): void => {
    setError(null)
    setMicDenied(false)
  }, [])

  return { state, progress, level, partial, error, micDenied, start, stop, cancel, dismiss }
}

/**
 * The composer while you dictate: what you typed, with the words heard so far
 * at the caret, as they come. They become real text when you stop.
 */
export function dictatingInto(input: string, at: number, heard: string): string {
  if (!heard) return input
  const cut = Math.min(at, input.length)
  const before = input.slice(0, cut)
  const after = input.slice(cut)
  const spacer = before && !/\s$/.test(before) ? ' ' : ''
  return before + spacer + heard + after
}
