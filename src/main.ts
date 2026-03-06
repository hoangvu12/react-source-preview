/**
 * Preview site for React Source Extractor.
 *
 * Receives code via:
 *   1. postMessage from parent iframe embedder (primary)
 *   2. URL hash (fallback) — base64-encoded JSON { code, css?, tailwind? }
 *
 * Uses esbuild-wasm to bundle user code + npm dependencies in-browser.
 * npm packages are fetched from cdn.jsdelivr.net.
 * React/ReactDOM are pre-bundled and provided as externals.
 */

import * as esbuild from 'esbuild-wasm/esm/browser.js';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import ReactDOM from 'react-dom/client';

const rootEl = document.getElementById('root')!;
const errorEl = document.getElementById('error')!;
const loadingEl = document.getElementById('loading')!;

let currentRoot: ReactDOM.Root | null = null;
let tailwindLoaded = false;
let pendingTailwind: Promise<void> | null = null;
let esbuildReady = false;
let esbuildInitPromise: Promise<void> | null = null;

// ── Globals for the runtime require() ──────────────────────────────────
const EXTERNAL_MODULES: Record<string, any> = {
  'react': React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOM,
  'react/jsx-runtime': jsxRuntime,
  'react/jsx-dev-runtime': jsxDevRuntime,
};

// ── esbuild init ───────────────────────────────────────────────────────
async function ensureEsbuild(): Promise<void> {
  if (esbuildReady) return;
  if (esbuildInitPromise) return esbuildInitPromise;

  esbuildInitPromise = esbuild.initialize({
    wasmURL: 'https://cdn.jsdelivr.net/npm/esbuild-wasm@0.27.3/esbuild.wasm',
  }).then(() => {
    esbuildReady = true;
    console.log('[preview] esbuild-wasm initialized');
  });

  return esbuildInitPromise;
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

// ── CDN fetch cache ────────────────────────────────────────────────────
const fetchCache = new Map<string, string>();

async function fetchText(url: string): Promise<string> {
  if (fetchCache.has(url)) return fetchCache.get(url)!;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const text = await res.text();
  fetchCache.set(url, text);
  return text;
}

// ── Import classification ──────────────────────────────────────────────
function isLocalImport(specifier: string): boolean {
  if (specifier.startsWith('.')) return true;
  if (specifier.startsWith('/') && !specifier.startsWith('/npm/')) return true;
  if (/^[@~#]\//.test(specifier)) return true;
  return false;
}

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

// ── esbuild plugin: resolve npm packages from jsdelivr CDN ─────────────
const CDN_BASE = 'https://cdn.jsdelivr.net';

function cdnPlugin(skipped: string[]): esbuild.Plugin {
  const REACT_EXTERNALS: Record<string, string> = {
    'react': 'react',
    'react-dom': 'react-dom',
    'react-dom/client': 'react-dom/client',
    'react/jsx-runtime': 'react/jsx-runtime',
    'react/jsx-dev-runtime': 'react/jsx-dev-runtime',
  };

  function getReactExternal(path: string): string | null {
    if (REACT_EXTERNALS[path]) return REACT_EXTERNALS[path];
    const cdnMatch = path.match(/^\/npm\/(react(?:-dom)?)((?:@[^/]+)?)(\/.*?)?\/?(?:\+esm)?$/);
    if (cdnMatch) {
      const pkg = cdnMatch[1];
      const subpath = cdnMatch[3]?.replace(/\/\+esm$/, '') || '';
      const key = subpath ? `${pkg}${subpath}` : pkg;
      return REACT_EXTERNALS[key] || REACT_EXTERNALS[pkg] || null;
    }
    return null;
  }

  return {
    name: 'cdn-resolve',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const reactExternal = getReactExternal(args.path);
        if (reactExternal) return { path: reactExternal, external: true };

        if (args.namespace === 'cdn') {
          if (args.path.startsWith('.') || args.path.startsWith('/')) {
            const resolved = new URL(args.path, `${CDN_BASE}${args.importer}`).pathname;
            const reactResolved = getReactExternal(resolved);
            if (reactResolved) return { path: reactResolved, external: true };
            return { path: resolved, namespace: 'cdn' };
          }
          if (!isLocalImport(args.path) && !isFrameworkImport(args.path)) {
            return { path: `/npm/${args.path}/+esm`, namespace: 'cdn' };
          }
        }

        if (args.namespace === 'entry') return undefined;

        if (isLocalImport(args.path) || isFrameworkImport(args.path)) {
          skipped.push(args.path);
          return { path: args.path, namespace: 'stub' };
        }

        return { path: `/npm/${args.path}/+esm`, namespace: 'cdn' };
      });

      build.onLoad({ filter: /.*/, namespace: 'cdn' }, async (args) => {
        const url = `${CDN_BASE}${args.path}`;
        try {
          const contents = await fetchText(url);
          return { contents, loader: 'js' };
        } catch (err) {
          return { contents: `/* Failed to load: ${url} — ${(err as Error).message} */\nexport default {};`, loader: 'js' };
        }
      });

      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `
          const handler = { get(_, p) { if (p === '__esModule') return true; if (p === 'default') return (props) => props?.children ?? null; return () => null; } };
          export default new Proxy({}, handler);
          export const __esModule = true;
        `,
        loader: 'js',
      }));
    },
  };
}

// ── Main render pipeline ───────────────────────────────────────────────
async function renderPreview(code: string, css?: string) {
  hideError();
  showLoading('Initializing...');

  document.getElementById('preview-warnings')?.remove();

  // Inject custom CSS if provided
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

  try {
    await ensureEsbuild();
  } catch (err) {
    showError(`Failed to initialize esbuild:\n${(err as Error).message}`);
    return;
  }

  showLoading('Bundling...');

  const skipped: string[] = [];
  let bundledCode: string;

  try {
    const result = await esbuild.build({
      stdin: {
        contents: code,
        loader: 'tsx',
        resolveDir: '/',
      },
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'react',
      define: {
        'process.env.NODE_ENV': '"production"',
        'process.env': '{}',
      },
      plugins: [cdnPlugin(skipped)],
      write: false,
      logLevel: 'silent',
    });

    bundledCode = result.outputFiles[0].text;
  } catch (err) {
    showError(`Build error:\n${(err as Error).message}`);
    return;
  }

  showLoading('Rendering...');

  const requireSync = (spec: string): any => {
    if (EXTERNAL_MODULES[spec]) return EXTERNAL_MODULES[spec];
    console.warn(`[preview] Unresolved require("${spec}")`);
    return {};
  };

  const moduleExports: Record<string, any> = {};
  const moduleObj = { exports: moduleExports };

  try {
    const fn = new Function('require', 'exports', 'module', bundledCode);
    fn(requireSync, moduleExports, moduleObj);
  } catch (err) {
    showError(`Runtime error:\n${(err as Error).message}`);
    return;
  }

  const exported = moduleObj.exports;
  const Component =
    exported?.default ||
    Object.values(exported).find((v) => typeof v === 'function') ||
    null;

  if (!Component || typeof Component !== 'function') {
    showError(
      'No renderable component found.\n\n' +
      'The code must export a React component as the default export:\n' +
      '  export default function MyComponent() { ... }'
    );
    return;
  }

  try {
    hideLoading();
    rootEl.innerHTML = '';

    if (currentRoot) currentRoot.unmount();
    currentRoot = ReactDOM.createRoot(rootEl, {
      onRecoverableError: (err) => showError(`React error:\n${(err as Error).message || err}`),
    });
    currentRoot.render(React.createElement(Component));

    if (tailwindLoaded) {
      requestAnimationFrame(() => {
        const probe = document.createElement('div');
        probe.className = 'hidden';
        rootEl.appendChild(probe);
        requestAnimationFrame(() => probe.remove());
      });
    }

    const warnings: string[] = [];
    if (skipped.length > 0) warnings.push(`Skipped: ${skipped.join(', ')}`);
    if (warnings.length > 0) {
      const el = document.createElement('div');
      el.id = 'preview-warnings';
      el.style.cssText =
        'position:fixed;bottom:0;left:0;right:0;padding:6px 12px;background:#fefce8;border-top:1px solid #fde68a;color:#92400e;font-size:11px;font-family:ui-monospace,monospace;z-index:100';
      el.textContent = warnings.join(' | ');
      document.body.appendChild(el);
    }

    // Notify parent that render is complete
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

// Check if there's code in the URL hash
loadFromHash();
