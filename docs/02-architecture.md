# PAIGE Cloud preview architecture

The private Cloud repository identifies the public frontend by full commit SHA. GitHub Actions builds and tests a static nginx image from locked dependencies and digest-pinned bases, then publishes the candidate to the private GHCR package. The job records both Git revisions and the image manifest digest.

An authorized operator promotes the digest to the dedicated Docker Image app in the existing Coolify Cloud project. Coolify manages the existing Traefik TLS proxy and the application on the Hostinger KVM 2. It pulls each release by digest. The public browser connects to the HTTPS preview, and Traefik routes to nginx on port 8080.

The governed preview serves no backend or auth endpoints. The build configuration substitutes a reserved invalid backend and the runtime limits browser connections to the preview origin. See [preview security](03-security-design.md) and the [release and rollback runbook](05-rollback-runbook.md).

The legacy Dockerfile previews stay on their recorded URLs. The F2 app uses its own stable origin for the entire deployment and rollback sequence.
