export class ServiceRegistry {
  private readonly values = new Map<symbol, unknown>();

  get<T>(key: symbol, create: () => T): T {
    if (!this.values.has(key)) this.values.set(key, create());
    return this.values.get(key) as T;
  }
}
