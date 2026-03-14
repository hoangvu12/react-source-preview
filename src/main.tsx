/**
 * Preview site for React Source Extractor — Sandpack-based multi-file renderer.
 *
 * Receives files via postMessage from the extension, renders them using Sandpack.
 * Sandpack handles transpilation, import resolution, npm deps, and error display.
 *
 * Message protocol:
 *   preview-render  → { files: Record<string, string>, entryFile: string, injectedCSS?: string }
 *   preview-loaded  ← signals parent that iframe is ready to receive messages
 *   preview-ready   ← signals parent that component rendered successfully
 *   preview-update  → incremental file updates during streaming (uses sandpack.updateFile)
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { SandpackProvider, SandpackPreview, useSandpack } from '@codesandbox/sandpack-react';

interface PreviewMessage {
  files: Record<string, string>;
  entryFile: string;
  injectedCSS?: string;
}

async function buildSandpackFiles(
  files: Record<string, string>,
  entryFile: string,
  injectedCSS?: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const [path, content] of Object.entries(files)) {
    // Sandpack expects paths starting with /
    const key = path.startsWith('/') ? path : `/${path}`;
    result[key] = content;
  }

  // Inject extracted CSS (variables, keyframes, font-faces) as a file auto-imported by entry
  if (injectedCSS) {
    result['/injected-styles.css'] = injectedCSS;
    const entryKey = entryFile.startsWith('/') ? entryFile : `/${entryFile}`;
    if (result[entryKey]) {
      result[entryKey] = `import './injected-styles.css';\n${result[entryKey]}`;
    }
  }

  // Scan all files for bare npm imports and auto-add as dependencies
  const deps: Record<string, string> = { react: 'latest', 'react-dom': 'latest' };
  // Match: import/export ... from 'pkg', side-effect import 'pkg', and require('pkg')
  const fromImportRe = /(?:import|export)\s[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const content of Object.values(result)) {
    let m: RegExpExecArray | null;
    for (const re of [fromImportRe, sideEffectRe, requireRe]) {
      re.lastIndex = 0;
      while ((m = re.exec(content)) !== null) {
        const spec = m[1];
        // Skip relative, absolute, http imports, and numeric webpack module IDs
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('http') || /^\d+$/.test(spec)) continue;
        // Get package name (handle scoped packages like @foo/bar)
        const pkgName = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0];
        if (!deps[pkgName]) deps[pkgName] = 'latest';
      }
    }
  }


  // Resolve peer dependencies from unpkg — packages like @react-three/fiber need 'three'
  const pkgsToCheck = Object.keys(deps).filter(p => p !== 'react' && p !== 'react-dom');
  if (pkgsToCheck.length > 0) {
    const peerResults = await Promise.allSettled(
      pkgsToCheck.map(async (pkg) => {
        try {
          const res = await fetch(`https://unpkg.com/${pkg}/package.json`, { redirect: 'follow' });
          if (!res.ok) return null;
          const data = await res.json();
          return data.peerDependencies as Record<string, string> | undefined;
        } catch { return null; }
      })
    );
    for (const result2 of peerResults) {
      if (result2.status === 'fulfilled' && result2.value) {
        for (const peer of Object.keys(result2.value)) {
          // Skip react/react-dom (already included), expo/react-native (not relevant for web)
          if (deps[peer] || /^(react|react-dom|react-native|expo)/.test(peer)) continue;
          deps[peer] = 'latest';
        }
      }
    }
  }

  // Override template's package.json — fix main to /index.tsx and include detected deps
  result['/package.json'] = JSON.stringify({
    main: '/index.tsx',
    dependencies: deps,
  });

  // Ensure /App.tsx exists — the template's /index.tsx imports from ./App
  const entryKey = entryFile.startsWith('/') ? entryFile : `/${entryFile}`;
  if (entryKey !== '/App.tsx') {
    const cleanPath = `.${entryKey}`.replace(/\.(tsx?|jsx?)$/, '');
    result['/App.tsx'] = `export { default } from '${cleanPath}';\n`;
  }

  return result;
}

function notifyParent(data: any) {
  if (window.parent !== window) {
    window.parent.postMessage(data, '*');
  }
}

/** Watches Sandpack status, forwards errors to parent, and handles streaming updates. */
function SandpackBridge() {
  const { sandpack, listen } = useSandpack();
  const readyFired = useRef(false);

  // Notify parent when Sandpack starts running
  useEffect(() => {
    if (sandpack.status === 'running' && !readyFired.current) {
      readyFired.current = true;
      notifyParent({ type: 'preview-ready' });
    }
  }, [sandpack.status]);

  // Listen for errors and console.error from Sandpack bundler, forward to parent
  useEffect(() => {
    const unsubscribe = listen((msg: any) => {
      // Compile/runtime errors (error overlay)
      if (msg.type === 'action' && msg.action === 'show-error') {
        notifyParent({
          type: 'preview-error',
          error: {
            message: msg.message || msg.title || 'Unknown error',
            title: msg.title,
            path: msg.path,
            line: msg.line,
            column: msg.column,
          },
        });
      }
      // Console errors
      if (msg.type === 'console' && Array.isArray(msg.log)) {
        const errors = msg.log.filter((entry: any) => entry.method === 'error');
        for (const err of errors) {
          const message = Array.isArray(err.data)
            ? err.data.map((d: any) => typeof d === 'string' ? d : JSON.stringify(d)).join(' ')
            : String(err.data);
          notifyParent({
            type: 'preview-error',
            error: { message, title: 'Console Error' },
          });
        }
      }
      // Compilation success — clear errors
      if (msg.type === 'done' && !msg.compilatonError) {
        notifyParent({ type: 'preview-error-clear' });
      }
    });
    return unsubscribe;
  }, [listen]);

  // Listen for incremental file updates during streaming
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === 'preview-update' && data.files) {
        const newFiles = await buildSandpackFiles(data.files, data.entryFile, data.injectedCSS);
        for (const [path, content] of Object.entries(newFiles)) {
          sandpack.updateFile(path, content);
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [sandpack]);

  return null;
}

function App() {
  const [previewData, setPreviewData] = useState<PreviewMessage | null>(null);
  const [sandpackFiles, setSandpackFiles] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === 'preview-render' && data.files) {
        setPreviewData({
          files: data.files,
          entryFile: data.entryFile || 'App.tsx',
          injectedCSS: data.injectedCSS,
        });
      }
      if (data.type === 'preview-ping') {
        notifyParent({ type: 'preview-loaded' });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Resolve sandpack files (async — fetches peer deps from unpkg)
  useEffect(() => {
    if (!previewData) return;
    let cancelled = false;
    buildSandpackFiles(previewData.files, previewData.entryFile, previewData.injectedCSS)
      .then(files => { if (!cancelled) setSandpackFiles(files); });
    return () => { cancelled = true; };
  }, [previewData]);

  // Signal ready on mount
  useEffect(() => {
    notifyParent({ type: 'preview-loaded' });
  }, []);

  if (!previewData || !sandpackFiles) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: '#a1a1aa', fontSize: 13,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        Waiting for code...
      </div>
    );
  }

  return (
    <SandpackProvider
      template="react-ts"
      files={sandpackFiles}
      options={{ autorun: true }}
    >
      <SandpackPreview
        showNavigator={false}
        showRefreshButton={false}
        style={{ height: '100vh', width: '100vw' }}
      />
      <SandpackBridge />
    </SandpackProvider>
  );
}

const rootEl = document.getElementById('root')!;
ReactDOM.createRoot(rootEl).render(<App />);
