/**
 * Preview site for React Source Extractor.
 *
 * Receives JSX code via postMessage or URL hash, compiles it with Sucrase
 * (loaded from CDN), resolves npm imports via esm.sh, and renders the component.
 *
 * No bundler needed — uses native ES module imports via blob URLs.
 */

const rootEl = document.getElementById('root')!;
const errorEl = document.getElementById('error')!;
const loadingEl = document.getElementById('loading')!;

let tailwindLoaded = false;
let pendingTailwind: Promise<void> | null = null;
let sucraseTransform: ((code: string, options: any) => { code: string }) | null = null;
let sucraseLoading: Promise<void> | null = null;
let currentCleanup: (() => void) | null = null;

// ── Load Sucrase from CDN ──────────────────────────────────────────────
async function ensureSucrase(): Promise<void> {
  if (sucraseTransform) return;
  if (sucraseLoading) return sucraseLoading;

  sucraseLoading = (async () => {
    const mod = await import('https://esm.sh/sucrase@3.35.1');
    sucraseTransform = mod.transform;
    console.log('[preview] Sucrase loaded');
  })();

  return sucraseLoading;
}

// ── Tailwind CDN ───────────────────────────────────────────────────────
function loadTailwindCDN(): Promise<void> {
  if (tailwindLoaded) return Promise.resolve();
  if (pendingTailwind) return pendingTailwind;

  pendingTailwind = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.tailwindcss.com';
    script.onload = () => { tailwindLoaded = true; pendingTailwind = null; resolve(); };
    script.onerror = () => { console.warn('[preview] Failed to load Tailwind CDN'); pendingTailwind = null; resolve(); };
    document.head.appendChild(script);
  });
  return pendingTailwind;
}

function codeUsesTailwind(code: string): boolean {
  return /class(?:Name)?=["'`{][^"'`}]*(?:flex|grid|p-\d|m-\d|px-|py-|mx-|my-|w-\[|h-\[|text-(?:sm|lg|xl|\[)|bg-(?:\w|linear)|border|rounded|gap-|space-[xy]|items-|justify-|overflow-|translate|scale-|rotate-|transition|animate-|shadow|ring-|inset-|leading-|tracking-|font-(?:bold|medium|semibold|light)|whitespace-|pointer-events-)/.test(code);
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

/** Extract bare import specifiers from code */
function extractImports(code: string): string[] {
  const imports = new Set<string>();
  // Match: import ... from 'pkg' / import 'pkg' / export ... from 'pkg'
  const re = /(?:import|export)\s+.*?from\s+['"]([^'"./][^'"]*)['"]/g;
  let m;
  while ((m = re.exec(code))) imports.add(m[1]);
  // Also match: import('pkg')
  const dynRe = /import\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;
  while ((m = dynRe.exec(code))) imports.add(m[1]);
  return [...imports];
}

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

/** Rewrite bare imports to esm.sh URLs, stub framework imports */
function rewriteImports(code: string): { code: string; skipped: string[] } {
  const skipped: string[] = [];

  const result = code.replace(
    /((?:import|export)\s+.*?from\s+)['"]([^'"]+)['"]/g,
    (full, prefix, specifier) => {
      // Leave relative/absolute imports alone
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('http')) {
        return full;
      }
      // Stub framework/Node imports
      if (isFrameworkImport(specifier)) {
        skipped.push(specifier);
        return `${prefix}'data:text/javascript,export default null'`;
      }
      // Rewrite to esm.sh
      return `${prefix}'https://esm.sh/${specifier}?external=react,react-dom'`;
    }
  );

  return { code: result, skipped };
}

// ── Main render pipeline ───────────────────────────────────────────────
async function renderPreview(code: string, css?: string) {
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

  // Auto-detect Tailwind
  if (!tailwindLoaded && codeUsesTailwind(code)) {
    await loadTailwindCDN();
  }

  // Load Sucrase
  try {
    await ensureSucrase();
  } catch (err) {
    showError(`Failed to load compiler:\n${(err as Error).message}`);
    return;
  }

  showLoading('Compiling...');

  // Compile JSX/TSX → JS
  let compiled: string;
  try {
    const result = sucraseTransform!(code, {
      transforms: ['jsx', 'typescript', 'imports'],
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
      production: true,
    });
    compiled = result.code;
  } catch (err) {
    showError(`Compile error:\n${(err as Error).message}`);
    return;
  }

  // Sucrase with 'imports' transform outputs CJS (require/exports).
  // We need ESM for blob URL import. Re-compile without 'imports' transform.
  try {
    const result = sucraseTransform!(code, {
      transforms: ['jsx', 'typescript'],
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
      production: true,
    });
    compiled = result.code;
  } catch {
    // Fall back to CJS version — will handle below
  }

  // Rewrite bare imports to esm.sh URLs
  const { code: rewritten, skipped } = rewriteImports(compiled);

  showLoading('Loading dependencies...');

  // Create a blob URL module and import it
  const blobContent = rewritten;
  const blob = new Blob([blobContent], { type: 'text/javascript' });
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

  // Render
  showLoading('Rendering...');

  try {
    // Dynamic import React from esm.sh so we use the same instance as the component
    const React = await import('https://esm.sh/react@19?external=');
    const ReactDOM = await import('https://esm.sh/react-dom@19/client?external=');

    hideLoading();
    rootEl.innerHTML = '';

    // Cleanup previous render
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }

    const root = ReactDOM.createRoot(rootEl, {
      onRecoverableError: (err: any) => showError(`React error:\n${err?.message || err}`),
    });
    root.render(React.createElement(Component));
    currentCleanup = () => root.unmount();

    // Nudge Tailwind
    if (tailwindLoaded) {
      requestAnimationFrame(() => {
        const probe = document.createElement('div');
        probe.className = 'hidden';
        rootEl.appendChild(probe);
        requestAnimationFrame(() => probe.remove());
      });
    }

    // Show warnings
    if (skipped.length > 0) {
      const el = document.createElement('div');
      el.id = 'preview-warnings';
      el.style.cssText =
        'position:fixed;bottom:0;left:0;right:0;padding:6px 12px;background:#fefce8;border-top:1px solid #fde68a;color:#92400e;font-size:11px;font-family:ui-monospace,monospace;z-index:100';
      el.textContent = `Skipped: ${skipped.join(', ')}`;
      document.body.appendChild(el);
    }

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

  if (data.type === 'preview-tailwind') {
    await loadTailwindCDN();
  }

  if (data.type === 'preview-render') {
    if (data.tailwind) await loadTailwindCDN();
    if (pendingTailwind) await pendingTailwind;
    await renderPreview(data.code, data.css);
  }
});

// ── URL hash fallback ──────────────────────────────────────────────────
async function loadFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;

  try {
    const json = JSON.parse(atob(hash));
    if (json.code) {
      if (json.tailwind) await loadTailwindCDN();
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
