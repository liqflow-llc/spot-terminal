import { Component } from 'react';
import { reportError } from '../services/report';

/** Keeps one panel's crash (e.g. the chart) from blanking the whole page; reports it. */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    reportError(`${this.props.name || 'panel'}_crashed`, error);
  }

  render() {
    if (this.state.failed) return <div className="panel-error muted">{this.props.fallback || 'This panel hit an error. Reload the page to try again.'}</div>;
    return this.props.children;
  }
}
