export interface StoreInfo {
  shopKey?: string;
  marketplace?: string;
  name?: string;
  id?: string;
  storeName?: string;
}

export function useStore() {
  return {
    activeMarketplace: 'US',
    activeShopKey: 'UPBestKS',
    activeStore: { shopKey: 'UPBestKS', marketplace: 'US', name: 'UPBestKS' } as StoreInfo | null,
    stores: [
      { shopKey: 'UPBestKS', id: 'UPBestKS', marketplace: 'US', name: 'UPBestKS', storeName: 'UPBestKS' },
      { shopKey: 'default', id: 'default', marketplace: 'US', name: '默认主店 (US)', storeName: '默认主店 (US)' },
    ] as StoreInfo[],
    switchStore: (_id?: string) => {},
  };
}

export function useNavigate() {
  return (_to: string | number) => {};
}

export function authHeaders(): Record<string, string> {
  return {};
}

export function saveToLauncher(): Promise<{ ok: boolean }> {
  return Promise.resolve({ ok: true });
}

export const db = {
  campaigns: { toArray: async () => [] as any[] },
  amzAdGroups: { toArray: async () => [] as any[] },
  keywords: { toArray: async () => [] as any[] },
};
