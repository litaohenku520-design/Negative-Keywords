import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Flex, Segmented, Space, Tag, Typography, theme as antdTheme } from 'antd';
import { AppstoreOutlined, BarChartOutlined, StopOutlined } from '@ant-design/icons';
import {
  App as McpApp,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import NegKeywordTool from './index';
import RoasMerge from './roas/index';

const { Text } = Typography;

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
          <h4 style={{ marginTop: 0 }}>页面渲染异常</h4>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.error.stack || this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

type DiscoverModule = 'neg' | 'roas';

function RootApp() {
  const [isDark, setIsDark] = useState(false);
  const [ready, setReady] = useState(false);
  const [activeModule, setActiveModule] = useState<DiscoverModule>('neg');

  useEffect(() => {
    let mounted = true;
    const mcpApp = new McpApp({ name: 'Discover AMZN', version: '2.0.0' }, {});

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

    mcpApp.ontoolinput = ({ arguments: args }: any) => {
      if (mounted && (args?.module === 'roas' || args?.module === 'neg')) {
        setActiveModule(args.module);
      }
    };

    mcpApp.ontoolresult = (result: any) => {
      const mod = result?.structuredContent?.module;
      if (mounted && (mod === 'roas' || mod === 'neg')) {
        setActiveModule(mod);
      }
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
    return <div style={{ padding: 24, color: '#888' }}>正在启动 Discover AMZN 工作台...</div>;
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
          {/* Discover AMZN 统一顶部导航壳 */}
          <div
            style={{
              background: 'var(--neg-surface)',
              border: '1px solid var(--neg-border)',
              borderRadius: 12,
              padding: '8px 14px',
              marginBottom: 12,
              boxShadow: 'var(--neg-shadow)',
            }}
          >
            <Flex justify="space-between" align="center" wrap="wrap" gap={12}>
              <Space size={10} align="center">
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(135deg, #1d4ed8 0%, #6366f1 100%)',
                    color: '#fff',
                    fontSize: 15,
                    fontWeight: 700,
                  }}
                >
                  <AppstoreOutlined />
                </div>
                <Text strong style={{ fontSize: 15, letterSpacing: '-0.2px' }}>Discover AMZN</Text>
                <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>亚马逊运营工具集</Tag>
              </Space>

              <Segmented
                value={activeModule}
                onChange={(val) => setActiveModule(val as DiscoverModule)}
                options={[
                  {
                    label: (
                      <Space size={6}>
                        <StopOutlined />
                        <span>否词助手</span>
                      </Space>
                    ),
                    value: 'neg',
                  },
                  {
                    label: (
                      <Space size={6}>
                        <BarChartOutlined />
                        <span>ROAS 合并助手</span>
                      </Space>
                    ),
                    value: 'roas',
                  },
                ]}
              />
            </Flex>
          </div>

          <div style={{ display: activeModule === 'neg' ? 'block' : 'none' }}>
            <NegKeywordTool />
          </div>
          <div style={{ display: activeModule === 'roas' ? 'block' : 'none' }}>
            <RoasMerge />
          </div>
        </div>
      </ConfigProvider>
    </ErrorBoundary>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<RootApp />);
}
