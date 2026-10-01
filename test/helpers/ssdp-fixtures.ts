/** A minimal well-formed M-SEARCH a Roku must answer — the one search both SSDP suites start from. */
export const MSEARCH = [
  "M-SEARCH * HTTP/1.1",
  "Host: 239.255.255.250:1900",
  'MAN: "ssdp:discover"',
  "ST: roku:ecp",
  "MX: 3",
  "",
  "",
].join("\r\n");
