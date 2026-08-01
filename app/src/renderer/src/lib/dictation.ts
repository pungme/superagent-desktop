import { useCallback, useRef, useState } from 'react'

/**
 * Push-to-talk dictation, transcribed locally by Whisper (transformers.js).
 *
 * Nothing leaves the machine except the one-time model download, so dictation
 * costs nothing and works offline afterwards. The Web Speech API is not an
 * option here: Electron ships Chromium without Google's speech service keys, so
 * SpeechRecognition starts and then fails with `network` as soon as audio
 * arrives.
 */

export type DictationState = 'idle' | 'loading-model' | 'recording' | 'transcribing'

// English-only, and the smallest model that transcribes dictation reliably.
// Multilingual needs 'onnx-community/whisper-base' instead (same size).
const MODEL = 'onnx-community/whisper-base.en'
const SAMPLE_RATE = 16_000

// The pipeline is heavy to build and safe to share, so it is created once per
// session and reused; the model files themselves are cached on disk by the
// browser after the first download.
let asrPromise: Promise<unknown> | null = null

async function getPipeline(onProgress?: (pct: number) => void): Promise<unknown> {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      // Renderer-side inference: no local model directory to look in.
      env.allowLocalModels = false
      // Load the ONNX runtime from disk. Left alone it fetches WASM from a CDN,
      // which the CSP blocks and which would make dictation need the network
      // every launch rather than only for the one-time model download.
      // Resolve against the page, not this module: a relative path would be
      // taken relative to Vite's dep cache in dev, and an absolute "/ort/" would
      // point at the filesystem root once packaged and loaded over file://.
      const wasm = env.backends.onnx.wasm
      if (wasm) wasm.wasmPaths = new URL('ort/', document.baseURI).href
      return pipeline('automatic-speech-recognition', MODEL, {
        // Explicit precision. Both the default and the q8 decoder fail to build
        // a session in this onnxruntime ("Missing required scale … MatMulNBits"),
        // so fp32 it is — a larger one-time download, but the one that works.
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
        progress_callback: (p: { status: string; progress?: number }) => {
          if (p.status === 'progress' && typeof p.progress === 'number') onProgress?.(p.progress)
        }
      })
    })().catch((e) => {
      asrPromise = null // let a failed download be retried
      throw e
    })
  }
  return asrPromise
}

/** Decode recorded audio to the mono 16 kHz float samples Whisper expects. */
async function toSamples(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer()
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  try {
    const decoded = await ctx.decodeAudioData(bytes)
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0)
    // Average the channels rather than dropping one, so a mic panned to one
    // side isn't silently discarded.
    const left = decoded.getChannelData(0)
    const right = decoded.getChannelData(1)
    const mono = new Float32Array(left.length)
    for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2
    return mono
  } finally {
    void ctx.close()
  }
}

interface Dictation {
  state: DictationState
  /** 0–1 while the model downloads the first time. */
  progress: number
  error: string | null
  start: () => Promise<void>
  /** Stops recording and resolves with the transcript ('' if nothing was said). */
  stop: () => Promise<string>
}

export function useDictation(): Dictation {
  const [state, setState] = useState<DictationState>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const start = useCallback(async (): Promise<void> => {
    if (recorderRef.current) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.start()
      recorderRef.current = rec
      setState('recording')
      // Warm the model while the user is still speaking, so a first-run download
      // overlaps with the recording instead of stalling after it.
      void getPipeline(setProgress).catch(() => {})
    } catch (e) {
      setState('idle')
      setError(e instanceof Error ? e.message : 'Could not access the microphone')
    }
  }, [])

  const stop = useCallback(async (): Promise<string> => {
    const rec = recorderRef.current
    if (!rec) return ''
    recorderRef.current = null

    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType }))
      rec.stop()
    })
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null

    try {
      setState('loading-model')
      const asr = (await getPipeline(setProgress)) as (
        audio: Float32Array,
        opts: Record<string, unknown>
      ) => Promise<{ text: string }>
      const samples = await toSamples(blob)
      // Whisper hallucinates filler on near-silence; a very short clip is a
      // mis-press, not speech.
      if (samples.length < SAMPLE_RATE * 0.3) return ''
      setState('transcribing')
      const out = await asr(samples, { chunk_length_s: 30, stride_length_s: 5 })
      return out.text.trim()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription failed')
      return ''
    } finally {
      setState('idle')
      setProgress(0)
    }
  }, [])

  return { state, progress, error, start, stop }
}
