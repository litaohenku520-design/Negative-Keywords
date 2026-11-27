export interface StoreInfo {
  shopKey?: string;
  marketplace?: string;
  name?: string;
}

export function useStore() {
  return {
    activeMarketplace: 'US',
    activeShopKey: '',
    activeStore: null as StoreInfo | null,
    stores: [] as StoreInfo[],
  };
}

export function useNavigate() {
  return (_to: string | number) => {};
}

export const db = {
  campaigns: { toArray: async () => [] as any[] },
  amzAdGroups: { toArray: async () => [] as any[] },
  keywords: { toArray: async () => [] as any[] },
};
