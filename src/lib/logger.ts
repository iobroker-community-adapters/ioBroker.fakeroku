/**
 * The minimal logger shape the network components need — satisfied by the
 * adapter's `this.log`. Kept in a neutral module so the SSDP responder and the
 * ECP HTTP server both depend on it without depending on each other.
 */
export type AdapterLogger = Pick<ioBroker.Log, "debug" | "warn" | "error">;
