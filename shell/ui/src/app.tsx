import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, ConfigProvider, Flex, Tag, Tooltip, Typography, theme as antdTheme } from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  CalendarOutlined,
  CompassOutlined,
  DatabaseOutlined,
  LineChartOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RadarChartOutlined,
  ScheduleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  App as McpApp,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import NegKeywordTool from './index';
import RoasMerge from './roas/index';
import SubPluginHost from './components/SubPluginHost';

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

type ModuleKey =
  | 'planner'
  | 'neg'
  | 'roas'
  | 'ad-scout'
  | 'sales-hub'
  | 'weekly-planner'
  | 'erp-workbench'
  | 'product-hub'
  | 'xydc';

interface SidebarModule {
  key: ModuleKey;
  label: string;
  group: string;
  icon: React.ReactNode;
  subPluginId?: string;
  badge?: string;
}

const MODULES: SidebarModule[] = [
  { key: 'planner', label: '运营计划', group: '工作台主页', icon: <CalendarOutlined />, subPluginId: 'amz-ops-planner', badge: '主' },
  { key: 'neg', label: '否词助手', group: '广告工具', icon: <StopOutlined /> },
  { key: 'roas', label: '搜索词劣词优化', group: '广告工具', icon: <BarChartOutlined /> },
  { key: 'ad-scout', label: '广告数据汇总', group: '广告工具', icon: <RadarChartOutlined />, subPluginId: 'upbestks-ad-scout' },
  { key: 'weekly-planner', label: '周广告复盘优化', group: '广告工具', icon: <ScheduleOutlined />, subPluginId: 'upbestks-weekly-planner' },
  { key: 'sales-hub', label: '销售采购与补货', group: '经营与选品', icon: <LineChartOutlined />, subPluginId: 'upbestks-sales-hub' },
  { key: 'erp-workbench', label: '库存销售分析', group: '经营与选品', icon: <DatabaseOutlined />, subPluginId: 'upbestks-erp-workbench' },
  { key: 'product-hub', label: '产品库', group: '经营与选品', icon: <AppstoreOutlined />, subPluginId: 'upbestks-product-hub' },
  { key: 'xydc', label: '西柚竞品分析', group: '经营与选品', icon: <CompassOutlined />, subPluginId: 'xydc-asin-analyzer' },
];

function RootApp() {
  const [isDark, setIsDark] = useState(false);
  const [ready, setReady] = useState(false);
  const [activeKey, setActiveKey] = useState<ModuleKey>('planner');
  const [mountedKeys, setMountedKeys] = useState<ModuleKey[]>(['planner']);
  const [collapsed, setCollapsed] = useState(false);
  const mcpAppRef = useRef<McpApp | null>(null);

  const selectModule = (key: ModuleKey) => {
    setActiveKey(key);
    setMountedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  useEffect(() => {
    let mounted = true;
    const mcpApp = new McpApp({ name: 'Discover amzn', version: '2.0.0' }, {});
    mcpAppRef.current = mcpApp;

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

    const applyInitialModule = (mod?: string) => {
      if (!mod) return;
      const hit = MODULES.find((m) => m.key === mod);
      if (hit && mounted) {
        setActiveKey(hit.key);
        setMountedKeys((prev) => (prev.includes(hit.key) ? prev : [...prev, hit.key]));
      }
    };

    mcpApp.ontoolinput = ({ arguments: args }: any) => {
      applyInitialModule(args?.module);
    };

    mcpApp.ontoolresult = (result: any) => {
      applyInitialModule(result?.structuredContent?.module);
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
      .catch(() => {})
      .finally(() => {
        if (mounted) setReady(true);
      });

    return () => {
      mounted = false;
    };
  }, []);

  if (!ready || !mcpAppRef.current) {
    return <div style={{ padding: 24, color: '#888' }}>正在启动 Discover amzn 工作台...</div>;
  }

  const groups = ['工作台主页', '广告工具', '经营与选品'];

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
        <div style={{ display: 'flex', minHeight: '100vh', width: '100%', background: 'var(--neg-bg)' }}>
          {/* 左侧集成侧边栏 */}
          <aside
            style={{
              width: collapsed ? 62 : 206,
              flexShrink: 0,
              background: 'var(--neg-surface)',
              borderRight: '1px solid var(--neg-border)',
              display: 'flex',
              flexDirection: 'column',
              transition: 'width 0.18s ease',
              position: 'sticky',
              top: 0,
              height: '100vh',
              overflowY: 'auto',
              zIndex: 20,
            }}
          >
            {/* 品牌头 */}
            <Flex
              align="center"
              justify={collapsed ? 'center' : 'space-between'}
              style={{
                padding: collapsed ? '12px 6px' : '12px 14px',
                borderBottom: '1px solid var(--neg-border)',
              }}
            >
              {!collapsed && (
                <Flex align="center" gap={8}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'linear-gradient(135deg, #1d4ed8 0%, #6366f1 100%)',
                      color: '#fff',
                      fontSize: 14,
                    }}
                  >
                    <AppstoreOutlined />
                  </div>
                  <div>
                    <Text strong style={{ fontSize: 14, display: 'block', lineHeight: 1.2 }}>Discover amzn</Text>
                    <Text type="secondary" style={{ fontSize: 10 }}>全能运营工作台</Text>
                  </div>
                </Flex>
              )}
              <Button
                type="text"
                size="small"
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed((c) => !c)}
              />
            </Flex>

            {/* 菜单列表 */}
            <div style={{ flex: 1, padding: collapsed ? '8px 6px' : '10px 10px' }}>
              {groups.map((grp) => {
                const items = MODULES.filter((m) => m.group === grp);
                return (
                  <div key={grp} style={{ marginBottom: 14 }}>
                    {!collapsed && (
                      <Text
                        type="secondary"
                        style={{ fontSize: 11, fontWeight: 600, padding: '0 8px', marginBottom: 6, display: 'block' }}
                      >
                        {grp}
                      </Text>
                    )}
                    <Flex vertical gap={3}>
                      {items.map((item) => {
                        const isActive = activeKey === item.key;
                        const btn = (
                          <button
                            key={item.key}
                            type="button"
                            onClick={() => selectModule(item.key)}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: collapsed ? 'center' : 'space-between',
                              gap: 8,
                              padding: collapsed ? '9px 0' : '8px 10px',
                              border: 'none',
                              borderRadius: 8,
                              cursor: 'pointer',
                              background: isActive ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
                              color: isActive ? '#2563eb' : 'inherit',
                              fontWeight: isActive ? 600 : 500,
                              fontSize: 13,
                              transition: 'all 0.15s ease',
                              textAlign: 'left',
                            }}
                          >
                            <Flex align="center" gap={9}>
                              <span style={{ fontSize: 15, display: 'inline-flex' }}>{item.icon}</span>
                              {!collapsed && <span>{item.label}</span>}
                            </Flex>
                            {!collapsed && item.badge && (
                              <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px' }}>
                                {item.badge}
                              </Tag>
                            )}
                          </button>
                        );
                        return collapsed ? (
                          <Tooltip key={item.key} title={item.label} placement="right">
                            {btn}
                          </Tooltip>
                        ) : (
                          btn
                        );
                      })}
                    </Flex>
                  </div>
                );
              })}
            </div>
          </aside>

          {/* 右侧主内容区 */}
          <main style={{ flex: 1, minWidth: 0, padding: '10px 14px', overflowX: 'hidden' }}>
            {MODULES.filter((m) => mountedKeys.includes(m.key)).map((mod) => {
              const visible = activeKey === mod.key;
              if (mod.key === 'neg') {
                return (
                  <div key={mod.key} style={{ display: visible ? 'block' : 'none' }}>
                    <NegKeywordTool />
                  </div>
                );
              }
              if (mod.key === 'roas') {
                return (
                  <div key={mod.key} style={{ display: visible ? 'block' : 'none' }}>
                    <RoasMerge />
                  </div>
                );
              }
              return (
                <div key={mod.key} style={{ display: visible ? 'block' : 'none' }}>
                  <SubPluginHost
                    pluginId={mod.subPluginId!}
                    title={mod.label}
                    mcpApp={mcpAppRef.current}
                    isDark={isDark}
                  />
                </div>
              );
            })}
          </main>
        </div>
      </ConfigProvider>
    </ErrorBoundary>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<RootApp />);
}
