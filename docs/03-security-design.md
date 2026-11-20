# PAIGE Cloud preview security design

The governed preview serves static content as UID and GID 101 on port 8080 behind Coolify TLS. The runtime has no backend proxy, auth configuration or writable data volume.

- The build strips upstream environment files, substitutes a reserved `.invalid` backend and placeholder keys, then scans browser-facing output for excluded build values.
- Browser connections are same-origin only. External scripts, frames and form submission are blocked. nginx handles only GET and HEAD, and denies authentication and API paths.
- A fresh F2 hostname avoids service workers installed on legacy origins. The preview service worker is absent and blocked by CSP. Release, version and HTML responses use `no-store`; successful fingerprinted assets may be cached.
- GitHub Actions publishes to the private Cloud package. Coolify pulls by digest with package-read access. Keep deployment permissions scoped to the preview app, with credentials in the approved secret store.
- Legacy previews used different headers and inputs. Their reachability and isolation require separate evidence. The owner-gated authenticated staging proposal remains separate.
