import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Pi Desktop renderer error", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error">
        <h1>Pi Desktop 遇到界面错误</h1>
        <p>{this.state.error.message}</p>
        <button onClick={() => window.location.reload()}>重新加载</button>
      </main>
    );
  }
}
