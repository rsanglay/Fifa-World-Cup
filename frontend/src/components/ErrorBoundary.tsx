import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Catches render-time crashes so one bad component doesn't white-screen the app. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card m-6 p-8 text-center">
          <div className="text-4xl">⚠️</div>
          <div className="mt-2 font-semibold">Something went wrong</div>
          <p className="mt-1 text-sm text-white/50">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })} className="btn-ghost mt-4 text-sm">
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
