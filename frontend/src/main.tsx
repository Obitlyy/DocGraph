import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { LocaleProvider } from './locale'
import './index.css'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null; info: React.ErrorInfo | null }> {
  state = { error: null as Error | null, info: null as React.ErrorInfo | null }
  static getDerivedStateFromError(error: Error) {
    return { error, info: null }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
    this.setState({ error, info })
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', color: '#c00', whiteSpace: 'pre-wrap', overflow: 'auto', height: '100vh' }}>
          <h2 style={{ color: '#c00' }}>💥 渲染错误</h2>
          <p><strong>{this.state.error.name}: {this.state.error.message}</strong></p>
          <hr />
          <p style={{ fontSize: 12 }}>Stack:</p>
          <pre style={{ fontSize: 11, background: '#fff5f5', padding: 8 }}>{this.state.error.stack}</pre>
          {this.state.info?.componentStack && (
            <>
              <p style={{ fontSize: 12 }}>Component stack:</p>
              <pre style={{ fontSize: 11, background: '#fff5f5', padding: 8 }}>{this.state.info.componentStack}</pre>
            </>
          )}
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LocaleProvider>
        <App />
      </LocaleProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
