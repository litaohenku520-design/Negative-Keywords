import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Flex, Spin, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface SubPluginHostProps {
  pluginId: string;
  title: string;
  mcpApp: any;
  isDark: boolean;
}

export default function SubPluginHost({ pluginId, title, mcpApp, isDark }: SubPluginHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subUrl, setSubUrl] = useState<string>('');
  const initPayloadRef = useRef<{ entryArgs: any; toolResult: any } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    mcpApp
      .callServerTool({
        name: 'app_sub_mcp_open',
        arguments: { pluginId },
      })
      .then((res: any) => {
        if (cancelled) return;
        if (res?.isError) {
          throw new Error(res?.content?.[0]?.text || `启动 ${title} 失败`);
        }
        const data = res?.structuredContent || JSON.parse(res?.content?.[0]?.text || '{}');
        initPayloadRef.current = {
          entryArgs: data.entryArgs || {},
          toolResult: data.toolResult || {},
        };
        setSubUrl(`${data.subUrl}?t=${Date.now()}`);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err?.message || String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pluginId, title, mcpApp, reloadTick]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || event.source !== win) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

      const reply = (payload: any) => {
        try {
          win.postMessage({ jsonrpc: '2.0', ...payload }, '*');
        } catch {
          // ignore if iframe unloaded
        }
      };

      const { id, method, params } = msg;

      if (method === 'ui/initialize') {
        const hostCtx = mcpApp.getHostContext?.() || {};
        reply({
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2025-11-21',
            hostInfo: { name: 'Discover AMZN', version: '2.0.0' },
            hostCapabilities: {
              serverTools: {},
              openLinks: {},
            },
            hostContext: {
              ...hostCtx,
              theme: isDark ? 'dark' : 'light',
              displayMode: 'inline',
            },
          },
        });
        return;
      }

      if (method === 'ui/notifications/initialized') {
        setLoading(false);
        const initData = initPayloadRef.current;
        if (initData) {
          reply({ method: 'ui/notifications/tool-input', params: { arguments: initData.entryArgs } });
          reply({ method: 'ui/notifications/tool-result', params: initData.toolResult });
        }
        return;
      }

      if (method === 'ping') {
        if (id !== undefined) reply({ id, result: {} });
        return;
      }

      if (method === 'tools/call') {
        try {
          const res: any = await mcpApp.callServerTool({
            name: 'app_sub_mcp_call',
            arguments: {
              pluginId,
              toolName: params?.name,
              arguments: params?.arguments || {},
            },
          });
          if (res?.isError) {
            reply({ id, result: { isError: true, content: res.content || [{ type: 'text', text: '调用失败' }] } });
          } else {
            reply({ id, result: res?.structuredContent || res });
          }
        } catch (err: any) {
          reply({
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: err?.message || String(err) }],
            },
          });
        }
        return;
      }

      if (method === 'ui/open-link' && params?.url) {
        mcpApp.openLink?.({ url: params.url }).catch(() => {});
        if (id !== undefined) reply({ id, result: {} });
        return;
      }

      if (id !== undefined) {
        reply({ id, result: {} });
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pluginId, mcpApp, isDark]);

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <Alert
          type="error"
          showIcon
          message={`加载「${title}」失败`}
          description={error}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => setReloadTick(t => t + 1)}>
              重试
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: 'calc(100vh - 20px)', minHeight: 640 }}>
      {loading && (
        <Flex
          align="center"
          justify="center"
          vertical
          gap={10}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            background: 'var(--neg-bg)',
          }}
        >
          <Spin size="large" />
          <Text type="secondary">正在加载「{title}」...</Text>
        </Flex>
      )}
      {subUrl && (
        <iframe
          ref={iframeRef}
          src={subUrl}
          title={title}
          onLoad={() => {
            // 部分纯原生 HTML（如不走 ext-apps 的面板）直接 onLoad 即就绪
            setTimeout(() => setLoading(false), 600);
          }}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            borderRadius: 12,
            background: 'var(--neg-surface)',
          }}
        />
      )}
    </div>
  );
}
