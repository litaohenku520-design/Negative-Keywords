import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, ConfigProvider, Flex, Input, Modal, Select, Space, Tag, Tooltip, Typography, message, theme as antdTheme } from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  CalendarOutlined,
  CompassOutlined,
  DatabaseOutlined,
  LineChartOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ScheduleOutlined,
  ShopOutlined,
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
import { setGlobalStoreState } from './shims/erpShims';

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

interface StoreMeta {
  id: string;
  name: string;
  marketplace: string;
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

  // 全局店铺管理
  const [stores, setStores] = useState<StoreMeta[]>([]);
  const [activeStoreId, setActiveStoreId] = useState<string>('default');
  const [storeVersion, setStoreVersion] = useState(0);
  const [storeSwitching, setStoreSwitching] = useState(false);
  const [newStoreOpen, setNewStoreOpen] = useState(false);
  const [newStoreId, setNewStoreId] = useState('');
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreMkt, setNewStoreMkt] = useState('US');
  const [newStoreCopyFrom, setNewStoreCopyFrom] = useState('default');

  const selectModule = (key: ModuleKey) => {
    setActiveKey(key);
    setMountedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const loadGlobalStores = useCallback(async () => {
    if (!window.__MCP_API_FETCH__) return;
    try {
      const st = await window.__MCP_API_FETCH__('/api/stores');
      if (Array.isArray(st?.stores)) {
        setStores(st.stores);
        const sid = st.active_store_id || st.stores[0]?.id || 'default';
        setActiveStoreId(sid);
        setGlobalStoreState({ activeStoreId: sid, stores: st.stores });
      }
    } catch {
      // ignore
    }
  }, []);

  const handleGlobalSwitchStore = useCallback(async (targetId: string) => {
    if (!targetId || targetId === activeStoreId || !window.__MCP_API_FETCH__) return;
    setStoreSwitching(true);
    try {
      const res = await window.__MCP_API_FETCH__('/api/stores/switch', {
        method: 'POST',
        body: JSON.stringify({ store_id: targetId }),
      });
      if (Array.isArray(res?.stores)) setStores(res.stores);
      const nextId = res?.active_store_id || targetId;
      setActiveStoreId(nextId);
      setGlobalStoreState({ activeStoreId: nextId, stores: res?.stores });
      setStoreVersion((v) => v + 1);
      message.success(`全局已切换到店铺「${res?.active_store?.name || nextId}」，各模块数据已按店铺隔离加载`);
    } catch (err: any) {
      message.error(`切换店铺失败: ${err?.message || err}`);
    } finally {
      setStoreSwitching(false);
    }
  }, [activeStoreId]);

  const handleGlobalCreateStore = useCallback(async () => {
    const sid = newStoreId.trim() || newStoreName.trim();
    if (!sid) {
      message.warning('请输入店铺 ID 或名称');
      return;
    }
    if (!window.__MCP_API_FETCH__) return;
    setStoreSwitching(true);
    try {
      const res = await window.__MCP_API_FETCH__('/api/stores/create', {
        method: 'POST',
        body: JSON.stringify({
          store_id: sid,
          name: newStoreName.trim() || sid,
          marketplace: newStoreMkt,
          copy_from: newStoreCopyFrom || 'default',
        }),
      });
      if (Array.isArray(res?.stores)) setStores(res.stores);
      const nextId = res?.active_store_id || sid;
      setActiveStoreId(nextId);
      setGlobalStoreState({ activeStoreId: nextId, stores: res?.stores });
      setStoreVersion((v) => v + 1);
      setNewStoreOpen(false);
      setNewStoreId('');
      setNewStoreName('');
      message.success(`已创建并切换到店铺「${res?.active_store?.name || nextId}」`);
    } catch (err: any) {
      message.error(`新增店铺失败: ${err?.message || err}`);
    } finally {
      setStoreSwitching(false);
    }
  }, [newStoreId, newStoreName, newStoreMkt, newStoreCopyFrom]);

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
        void loadGlobalStores();
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setReady(true);
      });

    return () => {
      mounted = false;
    };
  }, [loadGlobalStores]);

  if (!ready || !mcpAppRef.current) {
    return <div style={{ padding: 24, color: '#888' }}>正在启动 Discover amzn 工作台...</div>;
  }

  const groups = ['工作台主页', '广告工具', '经营与选品'];
  const currentStoreObj = stores.find((s) => s.id === activeStoreId);

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
              width: collapsed ? 62 : 216,
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

            {/* 全局店铺切换区 */}
            <div style={{ padding: collapsed ? '8px 6px' : '10px 10px 8px', borderBottom: '1px solid var(--neg-border)' }}>
              {collapsed ? (
                <Tooltip title={`当前店铺: ${currentStoreObj?.name || activeStoreId}`} placement="right">
                  <Button
                    size="small"
                    type="text"
                    icon={<ShopOutlined />}
                    style={{ width: '100%' }}
                    onClick={() => setCollapsed(false)}
                  />
                </Tooltip>
              ) : (
                <Flex vertical gap={6}>
                  <Flex align="center" justify="space-between">
                    <Space size={4}>
                      <ShopOutlined style={{ color: '#2563eb', fontSize: 12 }} />
                      <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>当前店铺 (数据隔离)</Text>
                    </Space>
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: 0, height: 'auto', fontSize: 11 }}
                      icon={<PlusOutlined />}
                      onClick={() => {
                        setNewStoreCopyFrom(activeStoreId || 'default');
                        setNewStoreOpen(true);
                      }}
                    >
                      新增
                    </Button>
                  </Flex>
                  <Select
                    size="small"
                    style={{ width: '100%' }}
                    loading={storeSwitching}
                    value={activeStoreId}
                    onChange={(val) => { void handleGlobalSwitchStore(val); }}
                    options={stores.map((s) => ({
                      value: s.id,
                      label: `${s.name} [${s.marketplace}]`,
                    }))}
                  />
                </Flex>
              )}
            </div>

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
                  <div key={`${mod.key}-${storeVersion}`} style={{ display: visible ? 'block' : 'none' }}>
                    <NegKeywordTool />
                  </div>
                );
              }
              if (mod.key === 'roas') {
                return (
                  <div key={`${mod.key}-${storeVersion}`} style={{ display: visible ? 'block' : 'none' }}>
                    <RoasMerge />
                  </div>
                );
              }
              return (
                <div key={`${mod.key}-${activeStoreId}-${storeVersion}`} style={{ display: visible ? 'block' : 'none' }}>
                  <SubPluginHost
                    pluginId={mod.subPluginId!}
                    storeId={activeStoreId}
                    title={mod.label}
                    mcpApp={mcpAppRef.current}
                    isDark={isDark}
                  />
                </div>
              );
            })}
          </main>
        </div>

        {/* 全局新增店铺弹窗 */}
        <Modal
          title="新增店铺（全平台数据独立隔离）"
          open={newStoreOpen}
          onCancel={() => setNewStoreOpen(false)}
          onOk={() => { void handleGlobalCreateStore(); }}
          confirmLoading={storeSwitching}
          okText="创建并切换"
          cancelText="取消"
        >
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <div>
              <Text style={{ display: 'block', marginBottom: 4 }}>店铺标识 ID（英文/数字/短横线，用于分类目录命名）：</Text>
              <Input
                placeholder="例如：suanpot-uk 或 shop-de"
                value={newStoreId}
                onChange={(e) => setNewStoreId(e.target.value)}
              />
            </div>
            <div>
              <Text style={{ display: 'block', marginBottom: 4 }}>店铺显示名称：</Text>
              <Input
                placeholder="例如：Suanpot 英国站"
                value={newStoreName}
                onChange={(e) => setNewStoreName(e.target.value)}
              />
            </div>
            <div>
              <Text style={{ display: 'block', marginBottom: 4 }}>所属站点：</Text>
              <Select
                style={{ width: '100%' }}
                value={newStoreMkt}
                onChange={setNewStoreMkt}
                options={['US', 'CA', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP', 'AU'].map((m) => ({ value: m, label: m }))}
              />
            </div>
            <div>
              <Text style={{ display: 'block', marginBottom: 4 }}>初始化否词规则来源（复制现有店铺作为起点）：</Text>
              <Select
                style={{ width: '100%' }}
                value={newStoreCopyFrom}
                onChange={setNewStoreCopyFrom}
                options={stores.map((s) => ({ value: s.id, label: `${s.name} (${s.id})` }))}
              />
            </div>
          </Space>
        </Modal>
      </ConfigProvider>
    </ErrorBoundary>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<RootApp />);
}
