/**
 * Preview site for React Source Extractor.
 *
 * Receives JSX code via postMessage or URL hash, compiles it with Sucrase
 * (loaded from CDN), resolves npm imports via esm.sh, and renders the component.
 *
 * React is loaded once via import map (in index.html) so the component and
 * renderer always share the same React instance. Third-party packages are
 * rewritten to esm.sh with ?external=react,react-dom so they also use the
 * import map's React.
 */

// These resolve via the import map in index.html → single React instance
import React from 'react';
import ReactDOM from 'react-dom/client';

const rootEl = document.getElementById('root')!;
const errorEl = document.getElementById('error')!;
const loadingEl = document.getElementById('loading')!;

let sucraseTransform: ((code: string, options: any) => { code: string }) | null = null;
let sucraseLoading: Promise<void> | null = null;
let currentCleanup: (() => void) | null = null;
let isComponentReady = false;
let pendingCaptures: (() => void)[] = [];

// ── Load Sucrase from CDN ──────────────────────────────────────────────
async function ensureSucrase(): Promise<void> {
  if (sucraseTransform) return;
  if (sucraseLoading) return sucraseLoading;

  sucraseLoading = (async () => {
    const mod = await import(/* @vite-ignore */ 'https://esm.sh/sucrase@3.35.1?external=react,react-dom');
    sucraseTransform = mod.transform;
    console.log('[preview] Sucrase loaded');
  })();

  return sucraseLoading;
}

// ── UI helpers ─────────────────────────────────────────────────────────
function showError(msg: string) {
  const match = msg.match(/^(\w[\w ]+):\n/);
  const title = match ? match[1] : 'Error';
  const detail = match ? msg.slice(match[0].length) : msg;

  errorEl.innerHTML = `<div class="error-title">${title}</div>${escapeHtml(detail)}`;
  errorEl.style.display = 'block';
  rootEl.classList.add('hidden');
  loadingEl.style.display = 'none';
}

function hideError() {
  errorEl.style.display = 'none';
  rootEl.classList.remove('hidden');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showLoading(msg: string) {
  loadingEl.innerHTML = `<div class="spinner"></div>${msg}`;
  loadingEl.style.display = 'flex';
}

function hideLoading() { loadingEl.style.display = 'none'; }

// ── Import rewriting ───────────────────────────────────────────────────

const REACT_PACKAGES = new Set([
  'react', 'react-dom', 'react-dom/client',
  'react/jsx-runtime', 'react/jsx-dev-runtime',
]);

/** Check if an import is a framework/Node.js import that should be stubbed */
function isFrameworkImport(specifier: string): boolean {
  const prefixes = [
    'next/', 'next-auth', 'nuxt/', '@nuxt/',
    'gatsby', '@remix-run/', 'astro',
    'fs', 'path', 'crypto', 'http', 'https', 'net', 'os',
    'child_process', 'stream', 'util', 'events', 'buffer',
    'url', 'querystring', 'node:',
  ];
  return prefixes.some(p =>
    specifier === p || specifier.startsWith(p + '/') || specifier.startsWith(p + '-')
  );
}

/**
 * Rewrite bare imports:
 * - react/react-dom → left as bare (resolved by import map)
 * - framework/Node → stubbed
 * - everything else → esm.sh with ?external=react,react-dom
 */
function rewriteImports(code: string): { code: string; skipped: string[] } {
  const skipped: string[] = [];

  const result = code.replace(
    /((?:import|export)\s+.*?from\s+)['"]([^'"]+)['"]/gs,
    (full, prefix, specifier) => {
      // Leave relative/absolute/http imports alone
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('http')) {
        return full;
      }
      // React packages — keep bare, import map handles them
      if (REACT_PACKAGES.has(specifier)) {
        return full;
      }
      // Stub framework/Node imports
      if (isFrameworkImport(specifier)) {
        skipped.push(specifier);
        return `${prefix}'data:text/javascript,export default null'`;
      }
      // npm package → esm.sh (with external react so it uses the import map's React)
      return `${prefix}'https://esm.sh/${specifier}?external=react,react-dom'`;
    }
  );

  return { code: result, skipped };
}

// ── Main render pipeline ───────────────────────────────────────────────
async function renderPreview(code: string, css?: string) {
  isComponentReady = false;
  hideError();
  showLoading('Loading compiler...');

  document.getElementById('preview-warnings')?.remove();

  // Inject custom CSS
  let customStyleEl = document.getElementById('preview-custom-css') as HTMLStyleElement | null;
  if (css) {
    if (!customStyleEl) {
      customStyleEl = document.createElement('style');
      customStyleEl.id = 'preview-custom-css';
      document.head.appendChild(customStyleEl);
    }
    customStyleEl.textContent = css;
  } else if (customStyleEl) {
    customStyleEl.textContent = '';
  }

  // Load Sucrase
  try {
    await ensureSucrase();
  } catch (err) {
    showError(`Failed to load compiler:\n${(err as Error).message}`);
    return;
  }

  showLoading('Compiling...');

  // Compile JSX/TSX → ESM JS (no imports transform — keep ES imports)
  let compiled: string;
  try {
    const result = sucraseTransform!(code, {
      transforms: ['jsx', 'typescript'],
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
      production: true,
    });
    compiled = result.code;
  } catch (err) {
    showError(`Compile error:\n${(err as Error).message}`);
    return;
  }

  // Rewrite non-react bare imports to esm.sh URLs
  const { code: rewritten, skipped } = rewriteImports(compiled);

  showLoading('Loading dependencies...');

  // Create a blob URL module and dynamic-import it
  // Blob URLs inherit the page's import map, so bare `react` imports resolve correctly
  const blob = new Blob([rewritten], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);

  let mod: any;
  try {
    mod = await import(/* @vite-ignore */ blobUrl);
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    showError(`Runtime error:\n${(err as Error).message}`);
    return;
  }
  URL.revokeObjectURL(blobUrl);

  // Find the component
  const Component =
    mod?.default ||
    Object.values(mod).find((v: any) => typeof v === 'function') ||
    null;

  if (!Component || typeof Component !== 'function') {
    showError(
      'No renderable component found.\n\n' +
      'The code must export a React component as the default export:\n' +
      '  export default function MyComponent() { ... }'
    );
    return;
  }

  // Render using the same React from import map
  showLoading('Rendering...');

  try {
    hideLoading();
    rootEl.innerHTML = '';

    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }

    const root = ReactDOM.createRoot(rootEl, {
      onRecoverableError: (err: any) => showError(`React error:\n${err?.message || err}`),
    });
    root.render(React.createElement(Component));
    currentCleanup = () => root.unmount();

    // Show warnings
    if (skipped.length > 0) {
      const el = document.createElement('div');
      el.id = 'preview-warnings';
      el.style.cssText =
        'position:fixed;bottom:0;left:0;right:0;padding:6px 12px;background:#fefce8;border-top:1px solid #fde68a;color:#92400e;font-size:11px;font-family:ui-monospace,monospace;z-index:100';
      el.textContent = `Skipped: ${skipped.join(', ')}`;
      document.body.appendChild(el);
    }

    isComponentReady = true;
    pendingCaptures.forEach(fn => fn());
    pendingCaptures = [];
    notifyParent({ type: 'preview-ready' });
  } catch (err) {
    showError(`Render error:\n${(err as Error).message}`);
  }
}

// ── Parent communication ───────────────────────────────────────────────
function notifyParent(data: any) {
  if (window.parent !== window) {
    window.parent.postMessage(data, '*');
  }
}

// ── Catch uncaught errors ──────────────────────────────────────────────
window.addEventListener('error', (e) => {
  showError(`Uncaught error:\n${e.message}${e.filename ? `\n  at ${e.filename}:${e.lineno}` : ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  showError(`Unhandled promise rejection:\n${e.reason?.message || e.reason}`);
});

// ── Message handler (postMessage from parent) ──────────────────────────
window.addEventListener('message', async (event) => {
  const data = event.data || {};

  if (data.type === 'preview-render') {
    await renderPreview(data.code, data.css);
  }

  if (data.type === 'capture-screenshot') {
    try {
      // Wait for component to finish rendering
      if (!isComponentReady) {
        await new Promise<void>(resolve => pendingCaptures.push(resolve));
      }

      const { toJpeg } = await import(/* @vite-ignore */ 'https://esm.sh/html-to-image@1.11.13');

      // Temporarily expand to desktop width for a realistic screenshot
      const width = data.width || 1280;
      const savedHtml = document.documentElement.style.cssText;
      const savedBody = document.body.style.cssText;
      const savedRoot = rootEl.style.cssText;

      document.documentElement.style.width = `${width}px`;
      document.body.style.width = `${width}px`;
      rootEl.style.width = `${width}px`;
      rootEl.style.minWidth = `${width}px`;

      // Wait for reflow so layout recalculates at new width
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const bg = getComputedStyle(document.body).backgroundColor || '#ffffff';
      const dataUrl = await toJpeg(rootEl, { quality: 0.8, backgroundColor: bg });
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');

      // Restore original styles
      document.documentElement.style.cssText = savedHtml;
      document.body.style.cssText = savedBody;
      rootEl.style.cssText = savedRoot;

      notifyParent({ type: 'screenshot-result', data: base64 });
    } catch (err) {
      notifyParent({ type: 'screenshot-result', error: (err as Error).message });
    }
  }
});

// ── URL hash fallback ──────────────────────────────────────────────────
async function loadFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;

  try {
    const json = JSON.parse(atob(hash));
    if (json.code) {
      await renderPreview(json.code, json.css);
    }
  } catch {
    // Not valid base64 JSON — ignore
  }
}

// ── Init ───────────────────────────────────────────────────────────────
hideLoading();
loadingEl.innerHTML = '<span style="color:#a1a1aa">Waiting for code...</span>';
notifyParent({ type: 'preview-loaded' });
loadFromHash();
