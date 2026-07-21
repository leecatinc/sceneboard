'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

export class RendererErrorBoundary extends Component<
  {
    nodeId: string;
    nodeType: string;
    children: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The renderer intentionally does not log scene content or thrown values.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <section className="scene-fallback" role="alert">
          <strong>Block unavailable</strong>
          <span>
            {this.props.nodeType} · {this.props.nodeId}
          </span>
        </section>
      );
    }
    return this.props.children;
  }
}
