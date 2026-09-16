// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** Selected network-interface IP to bind SSDP/ECP to and advertise ("0.0.0.0" = all). */
      bind: string;
      /** Legacy key, moved to `bind` on the first start after the update (fleet listen-port standard). */
      networkInterface?: string;
      /** Legacy pre-0.5.0 key of the old adapter, moved to `bind` on the same start. */
      BIND?: string;
      /**
       * Emulated Roku devices. `type` defaults to "player" when absent (pre-0.7.0 configs).
       * `uuid` is the stable SSDP identity: adopted from the old adapter's persisted value on
       * migration (keeps the controller pairing), derived from the name for devices without one.
       */
      devices: { name: string; port: number; type?: "player" | "tv"; uuid?: string }[];
    }
  }
}

export {};
