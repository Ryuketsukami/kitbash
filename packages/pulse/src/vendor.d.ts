// Ambient declaration for the optional `pg` peer (not installed here). Only the
// members this package calls are declared; rows come back `unknown` and are
// narrowed at the call sites, so this stays minimal and honest.

declare module 'pg' {
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
  }
  export interface QueryResult {
    rows: unknown[];
  }
  export class Pool {
    constructor(config?: PoolConfig);
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    end(): Promise<void>;
  }
}
