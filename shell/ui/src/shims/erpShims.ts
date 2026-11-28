import { useSyncExternalStore } from 'react';

export interface StoreInfo {
  shopKey?: string;
  marketplace?: string;
  name?: string;
  id?: string;
  storeName?: string;
}

interface GlobalStoreSnapshot {
  activeStoreId: string;
  stores: StoreInfo[];
}

let _snapshot: GlobalStoreSnapshot = {
  activeStoreId: 'UPBestKS',
  stores: [
    { id: 'default', shopKey: 'default', marketplace: 'US', name: '默认主店 (US)', storeName: '默认主店 (US)' },
    { id: 'suanpot-us', shopKey: 'suanpot-us', marketplace: 'US', name: 'suanpot-us (美国站)', storeName: 'suanpot-us (美国站)' },
    { id: 'UPBestKS', shopKey: 'UPBestKS', marketplace: 'US', name: 'UPBestKS', storeName: 'UPBestKS' },
  ],
};

const _listeners = new Set<() => void>();

export function setGlobalStoreState(next: {
  activeStoreId?: string;
  stores?: Array<{ id: string; name: string; marketplace: string }>;
}) {
  const mappedStores: StoreInfo[] = Array.isArray(next.stores)
    ? next.stores.map((s) => ({
        id: s.id,
        shopKey: s.id,
        marketplace: s.marketplace || 'US',
        name: s.name || s.id,
        storeName: s.name || s.id,
      }))
    : _snapshot.stores;

  _snapshot = {
    activeStoreId: next.activeStoreId || _snapshot.activeStoreId,
    stores: mappedStores,
  };
  _listeners.forEach((fn) => {
    try { fn(); } catch { /* noop */ }
  });
}

function subscribe(cb: () => void) {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

function getSnapshot() {
  return _snapshot;
}

export function useStore() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const active = snap.stores.find((s) => s.id === snap.activeStoreId) || snap.stores[0] || null;
  return {
    activeMarketplace: active?.marketplace || 'US',
    activeShopKey: active?.id || snap.activeStoreId || 'default',
    activeStore: active,
    stores: snap.stores,
    switchStore: (id?: string) => {
      if (id) setGlobalStoreState({ activeStoreId: id });
    },
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
