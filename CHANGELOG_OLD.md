# Older changes
## 0.5.1 (2026-08-05)
- (mcm1957) Adapter requires Node.js >= 22 now
- (mcm1957) Dependencies have been updated

## 0.5.0 (2026-07-30)
- Complete rewrite with the full Roku control surface, including `device-info` with a current Roku version — the part modern remotes check at pairing, beyond what a classic Harmony hub needs
- New clean data model: a `command` datapoint plus fixed `keys.<Key>` states, all created up front instead of appearing only after the first keypress
- Discovery binds to the chosen network interface, command handling is restricted to the local network

## 0.4.0 (2026-03-07)
- Adapter requires node.js >= 20, admin >= 7.7.22, js-controller >= 6.0.11

## 0.3.0 (2024-06-11)
* (mcm1957) Adapter requires node.js >= 18 and js-controller >= 5 now
* (mcm1957) Dependencies have been updated

## 0.2.2 (2023-07-24)
* (Apollon77) fixed issues with controller v5

## 0.2.1
  (Pmant) fix jQuery error in admin
  (ykuendig) add translations

[Older changelogs can be found here](CHANGELOG_OLD.md)

## 0.2.0
  (Pmant) run multiple fakeroku's in one instance

## 0.1.1
  (Pmant) fix package.json

## 0.1.0
  (Pmant) initial release
