import React from 'react';
import { Flex, Typography, Space } from 'antd';
import { StopOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

export default function PageHeader({
  title,
  subTitle,
  subtitle,
  extra,
  icon,
}: {
  title?: React.ReactNode;
  subTitle?: React.ReactNode;
  subtitle?: React.ReactNode;
  extra?: React.ReactNode;
  icon?: React.ReactNode;
  [k: string]: any;
}) {
  return (
    <div
      style={{
        background: 'var(--neg-surface)',
        border: '1px solid var(--neg-border)',
        borderRadius: 12,
        padding: '12px 16px',
        marginBottom: 12,
        boxShadow: 'var(--neg-shadow)',
      }}
    >
      <Flex justify="space-between" align="center" wrap="wrap" gap={12}>
        <Flex align="center" gap={12}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)',
              color: '#ffffff',
              fontSize: 18,
              boxShadow: '0 4px 10px rgba(37, 99, 235, 0.25)',
              flexShrink: 0,
            }}
          >
            {icon || <StopOutlined />}
          </div>
          <div>
            <Title level={4} style={{ margin: 0, fontSize: 17, lineHeight: 1.3 }}>
              {title}
            </Title>
            {(subTitle || subtitle) && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {subTitle || subtitle}
              </Text>
            )}
          </div>
        </Flex>
        {extra && <Space wrap size={8}>{extra}</Space>}
      </Flex>
    </div>
  );
}
