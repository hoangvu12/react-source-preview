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

function buildSandpackFiles(
  files: Record<string, string>,
  entryFile: string,
  injectedCSS?: string,
): Record<string, string> {
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

  return result;
}

function notifyParent(data: any) {
  if (window.parent !== window) {
    window.parent.postMessage(data, '*');
  }
}

/** Watches Sandpack status and sends preview-ready when running. Also handles streaming updates. */
function SandpackBridge() {
  const { sandpack } = useSandpack();
  const readyFired = useRef(false);

  // Notify parent when Sandpack starts running
  useEffect(() => {
    if (sandpack.status === 'running' && !readyFired.current) {
      readyFired.current = true;
      notifyParent({ type: 'preview-ready' });
    }
  }, [sandpack.status]);

  // Listen for incremental file updates during streaming
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === 'preview-update' && data.files) {
        const newFiles = buildSandpackFiles(data.files, data.entryFile, data.injectedCSS);
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

  // Signal ready on mount
  useEffect(() => {
    notifyParent({ type: 'preview-loaded' });
  }, []);

  if (!previewData) {
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

  const sandpackFiles = buildSandpackFiles(
    previewData.files,
    previewData.entryFile,
    previewData.injectedCSS,
  );

  const entryKey = previewData.entryFile.startsWith('/')
    ? previewData.entryFile
    : `/${previewData.entryFile}`;

  return (
    <SandpackProvider
      template="react-ts"
      files={sandpackFiles}
      customSetup={{ entry: entryKey }}
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
