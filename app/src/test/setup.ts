// Renderer unit tests import modules (e.g. state.ts) that read localStorage
// at module load time to seed the zustand store's initial state. There is no
// jsdom in this project, so without this shim any test that transitively
// imports state.ts fails before a single test body runs.
if (typeof globalThis.localStorage === 'undefined') {
  const backing = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
    setItem: (key: string, value: string) => {
      backing.set(key, String(value))
    },
    removeItem: (key: string) => {
      backing.delete(key)
    },
    clear: () => {
      backing.clear()
    },
    key: (index: number) => Array.from(backing.keys())[index] ?? null,
    get length(): number {
      return backing.size
    }
  } as Storage
}
