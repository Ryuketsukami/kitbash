import type { CustomerState, PurchaseResult, ShopConfig, ShopOffering, ShopPackage } from './types.js';

export interface ShopAdapter {
  init(cfg: ShopConfig): Promise<void>;
  offerings(): Promise<ShopOffering[]>;
  purchase(pkg: ShopPackage): Promise<PurchaseResult>;
  restore(): Promise<CustomerState>;
  customer(): Promise<CustomerState>;
  onCustomerChange(cb: (c: CustomerState) => void): () => void;
}
