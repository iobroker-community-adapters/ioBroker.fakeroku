// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** Selected network-interface IP to bind SSDP/ECP to and advertise. */
      networkInterface: string;
      /** Legacy pre-0.5.0 field: the old adapter's bound IP. Adopted as `networkInterface` on migration when the new field is absent. */
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
