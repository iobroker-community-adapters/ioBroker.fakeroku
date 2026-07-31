// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** Selected network-interface IP to bind SSDP/ECP to and advertise. */
      networkInterface: string;
      /** Emulated Roku devices. `type` defaults to "player" when absent (pre-0.7.0 configs). */
      devices: { name: string; port: number; type?: "player" | "tv" }[];
    }
  }
}

export {};
