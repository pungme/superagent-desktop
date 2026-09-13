export interface RemoteUserMessage {
  id: string
  text: string
  from: 'ios'
  imageCount: number
}

/** The live renderer event must identify the same logged message whose thumbnails it fetches. */
export function remoteUserMessage(
  id: string,
  text: string,
  imageCount: number
): RemoteUserMessage {
  return { id, text, from: 'ios', imageCount }
}
