import { createRoot } from 'react-dom/client';
import { installChromeShim, installSiteFetchShim } from './chromeShim';
import { ErrorBoundary } from '@/entrypoints/content/ui/ErrorBoundary';
import { AppShell } from './AppShell';

installChromeShim();
installSiteFetchShim();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <ErrorBoundary entry="web-shell">
      <AppShell />
    </ErrorBoundary>,
  );
}
