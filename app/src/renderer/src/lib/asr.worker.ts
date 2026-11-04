/**
 * Whisper, off the page's thread. Dictation transcribes while you are still
 * speaking (a fresh guess about once a second), and a transcription of several
 * seconds of audio would otherwise freeze the window each time.
 *
 * Messages in:  { type: 'load', ortBase }            build the pipeline (and download the model once)
 *               { type: 'run', id, samples, long }   transcribe 16 kHz mono samples
 * Messages out: { type: 'progress', pct } while downloading
 *               { type: 'ready' }
 *               { type: 'result', id, text } | { type: 'error', id?, message }
 */

// English-only, and the smallest model that transcribes dictation reliably.
const MODEL = 'onnx-community/whisper-base.en'

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string }>

let asr: Promise<Asr> | null = null

function load(ortBase: string): Promise<Asr> {
  if (!asr) {
    asr = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.allowLocalModels = false
      // The ONNX runtime from disk, not a CDN (the CSP blocks it, and dictation
      // should need the network only for the one-time model download).
      const wasm = env.backends.onnx.wasm
      if (wasm) wasm.wasmPaths = ortBase
      const p = await pipeline('automatic-speech-recognition', MODEL, {
        // Both the default and the q8 decoder fail to build a session in this
        // onnxruntime ("Missing required scale … MatMulNBits"), so fp32.
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
        progress_callback: (e: { status: string; progress?: number }) => {
          if (e.status === 'progress' && typeof e.progress === 'number')
            self.postMessage({ type: 'progress', pct: e.progress })
        }
      })
      return p as unknown as Asr
    })().catch((e) => {
      asr = null // a failed download can be tried again
      throw e
    })
  }
  return asr
}

self.onmessage = async (ev: MessageEvent): Promise<void> => {
  const msg = ev.data as
    | { type: 'load'; ortBase: string }
    | { type: 'run'; id: number; samples: Float32Array; long: boolean; ortBase: string }
  try {
    if (msg.type === 'load') {
      await load(msg.ortBase)
      self.postMessage({ type: 'ready' })
      return
    }
    const run = await load(msg.ortBase)
    const out = await run(
      msg.samples,
      // The final pass may be longer than Whisper's 30 s window; a guess while
      // speaking is never given more than one window.
      msg.long ? { chunk_length_s: 30, stride_length_s: 5 } : {}
    )
    self.postMessage({ type: 'result', id: msg.id, text: out.text })
  } catch (e) {
    self.postMessage({
      type: 'error',
      id: msg.type === 'run' ? msg.id : undefined,
      message: e instanceof Error ? e.message : String(e)
    })
  }
}
