declare module 'net-snmp' {
  namespace snmp {
    interface VarBind {
      oid: string
      type: number
      value: unknown
    }
    interface Session {
      get(oids: string[], cb: (error: Error | null, varbinds: VarBind[]) => void): void
      subtree(
        oid: string,
        feedCb: (varbinds: VarBind[]) => void,
        doneCb: (error: Error | null) => void,
      ): void
      close(): void
    }
    const Version2c: number
    function createSession(target: string, community: string, options?: {
      timeout?: number
      retries?: number
      version?: number
    }): Session
    function isVarbindError(varbind: VarBind): boolean
  }
  export = snmp
}
