import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme as antdTheme } from 'antd';
import {
  App as McpApp,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import NegKeywordTool from './index';

declare global {
  interface Window {
    __MCP_API_FETCH__?: (path: string, options?: RequestInit & { timeoutMs?: number }) => Promise<any>;
  }
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: '#cf1322', background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 8, margin: 16 }}>
          <h4 style={{ marginTop: 0 }}>否词工作台渲染异常</h4>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.error.stack || this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function RootApp() {
  const [isDark, setIsDark] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    const mcpApp = new McpApp({ name: 'AMZ 否词工具', version: '1.0.0' }, {});

    window.__MCP_API_FETCH__ = async (path: string, options?: RequestInit & { timeoutMs?: number }) => {
      const method = (options?.method || 'GET').toUpperCase();
      let body: any = undefined;
      if (options?.body && typeof options.body === 'string') {
        try {
          body = JSON.parse(options.body);
        } catch {
          body = options.body;
        }
      } else if (options?.body !== undefined) {
        body = options.body;
      }

      const res: any = await mcpApp.callServerTool({
        name: 'app_api_request',
        arguments: { method, path, body },
      });
      if (res?.isError) {
        const errText = res?.content?.[0]?.text || 'MCP tool call failed';
        throw new Error(errText);
      }
      if (res?.structuredContent && 'data' in res.structuredContent) {
        return res.structuredContent.data;
      }
      const txt = res?.content?.[0]?.text;
      return txt ? JSON.parse(txt) : {};
    };

    mcpApp.onhostcontextchanged = (ctx: any) => {
      if (ctx?.theme) {
        applyDocumentTheme(ctx.theme);
        if (mounted) setIsDark(ctx.theme === 'dark');
      }
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    };

    mcpApp
      .connect()
      .then(() => {
        const ctx: any = mcpApp.getHostContext();
        if (ctx?.theme) {
          applyDocumentTheme(ctx.theme);
          if (mounted) setIsDark(ctx.theme === 'dark');
        }
        if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      })
      .catch(() => {
        // 独立浏览器预览模式下静默回退
      })
      .finally(() => {
        if (mounted) setReady(true);
      });

    return () => {
      mounted = false;
    };
  }, []);

  if (!ready) {
    return <div style={{ padding: 24, color: '#888' }}>正在连接否词引擎...</div>;
  }

  return (
    <ErrorBoundary>
      <ConfigProvider
        theme={{
          algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: '#2563eb',
            borderRadius: 8,
            fontSize: 13,
          },
          components: {
            Table: {
              cellPaddingBlockSM: 7,
              cellPaddingInlineSM: 10,
            },
            Card: {
              paddingLG: 16,
            },
          },
        }}
      >
        <div className="neg-app-shell">
          <NegKeywordTool />
        </div>
      </ConfigProvider>
    </ErrorBoundary>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<RootApp />);
}
