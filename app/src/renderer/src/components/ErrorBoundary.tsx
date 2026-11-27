import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * One failing component must not blank the whole window. Without a boundary an exception while
 * drawing a message or a pane unmounted the entire app (white window) and stopped every agent
 * running inside it. A boundary around a chat keeps the rest of the app up and offers to draw
 * that chat again; the one at the root is the last resort.
 */
interface Props {
  scope: 'app' | 'chat'
  children: ReactNode
}
interface State {
  error: Error | null
  attempt: number
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reaches the main process's console capture; the health log keeps the stack.
    console.error(`[${this.props.scope}] render failed:`, error.stack, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error)
      return (
        <div key={this.state.attempt} style={{ display: 'contents' }}>
          {this.props.children}
        </div>
      )
    const app = this.props.scope === 'app'
    return (
      <div role="alert" className="error-boundary">
        <h2>{app ? 'Superagent hit a problem' : 'This conversation could not be drawn'}</h2>
        <p>
          Your conversations are saved.{' '}
          {app
            ? 'Reload the window to carry on.'
            : 'Try again; if it keeps happening, switch to another chat and back.'}
        </p>
        <pre>{this.state.error.message}</pre>
        <button
          onClick={() =>
            app
              ? window.location.reload()
              : this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))
          }
        >
          {app ? 'Reload' : 'Try again'}
        </button>
      </div>
    )
  }
}
