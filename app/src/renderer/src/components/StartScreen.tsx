/**
 * What a new person sees with no project yet: one thing to do, at once. Start a
 * chat (no folder needed) is the big button; a project folder is the second way
 * in; a few starters show what an agent is for, and send themselves when clicked.
 */
const STARTERS: { title: string; hint: string; prompt: string }[] = [
  {
    title: 'Tidy up a folder',
    hint: 'Sort my Downloads',
    prompt:
      'Look at my Downloads folder and propose how to sort it into folders. Show me the plan first; do not move anything until I say yes.'
  },
  {
    title: 'Research something',
    hint: 'With sources',
    prompt:
      'Help me research a topic. Ask me what it is, then search the web and give me a short, sourced summary.'
  },
  {
    title: 'Build a small web page',
    hint: 'And see it live',
    prompt:
      'Build me a simple one-page website. Ask me what it is for, then make it and show it to me in the browser.'
  },
  {
    title: 'Plan my week',
    hint: 'From my calendar and to-dos',
    prompt:
      'Help me plan my week. Ask what matters most to me, then turn it into a short day-by-day plan.'
  }
]

export function StartScreen({
  onChat,
  onProject
}: {
  onChat: (prompt?: string) => void
  onProject: () => void
}): React.JSX.Element {
  return (
    <div className="empty-state" data-testid="start-screen">
      <div className="start">
        <h1>What do you want to get done?</h1>
        <p>
          Tell an agent in plain words. It can read and write files, browse, and run things on your
          Mac.
        </p>
        <div className="start-main">
          <button className="start-cta" onClick={() => onChat()} data-testid="start-chat">
            Start a chat
          </button>
          <button className="start-alt" onClick={onProject} data-testid="start-project">
            Open a project folder
          </button>
        </div>
        <div className="start-or">or try one of these</div>
        <div className="start-grid">
          {STARTERS.map((s) => (
            <button key={s.title} className="start-card" onClick={() => onChat(s.prompt)}>
              <b>{s.title}</b>
              <span>{s.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
