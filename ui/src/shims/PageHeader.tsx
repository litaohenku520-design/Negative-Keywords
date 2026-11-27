import React from 'react';
import { Flex, Typography, Space } from 'antd';

const { Title, Text } = Typography;

export default function PageHeader({
  title,
  subTitle,
  subtitle,
  extra,
}: {
  title?: React.ReactNode;
  subTitle?: React.ReactNode;
  subtitle?: React.ReactNode;
  extra?: React.ReactNode;
  [k: string]: any;
}) {
  return (
    <Flex
      justify="space-between"
      align="center"
      wrap="wrap"
      gap={12}
      style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid rgba(128,128,128,0.16)' }}
    >
      <div>
        <Title level={4} style={{ margin: 0 }}>{title}</Title>
        {(subTitle || subtitle) && (
          <Text type="secondary" style={{ fontSize: 12 }}>{subTitle || subtitle}</Text>
        )}
      </div>
      {extra && <Space wrap>{extra}</Space>}
    </Flex>
  );
}
