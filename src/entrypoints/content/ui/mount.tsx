import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { ensureUiHost, removeUiHost } from './host';

let root: Root | null = null;

export function mountUi(): () => void {
  const { container } = ensureUiHost();
  if (!root) {
    root = createRoot(container);
    root.render(<App />);
  }
  return () => {
    root?.unmount();
    root = null;
    removeUiHost();
  };
}
