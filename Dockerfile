# PAIGE Cloud F2 — nonproduction preview (builds PAIGE frontend from public repo)
# Source of truth for the deployed image. Commit SHA recorded per deployment.
FROM oven/bun:1.2-alpine AS build
WORKDIR /app
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/Paige-Agent-AI/Paige-Agent-AI.git .
RUN bun install
RUN bun run build

FROM nginx:1.27-alpine AS serve
RUN rm -f /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
RUN cat > /etc/nginx/conf.d/paige.conf <<'NGINX'
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'self' https:; media-src 'self' https: data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' https:" always;
    location = /healthz { access_log off; default_type text/plain; return 200 "ok\n"; }
    location = /privacy { try_files /privacy.html =404; }
    location = /sms-terms { try_files /sms-terms.html =404; }
    location = /auth { try_files /auth.html =404; }
    location ~* ^/(index|privacy|sms-terms|auth)\.html$ { add_header X-Content-Type-Options "nosniff" always; add_header Referrer-Policy "strict-origin-when-cross-origin" always; add_header Content-Security-Policy "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'self' https:; media-src 'self' https: data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' https:" always; add_header Cache-Control "no-cache, no-store, must-revalidate" always; try_files $uri =404; }
    location = /sw.js { add_header X-Content-Type-Options "nosniff" always; add_header Referrer-Policy "strict-origin-when-cross-origin" always; add_header Content-Security-Policy "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'self' https:; media-src 'self' https: data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' https:" always; add_header Cache-Control "no-cache, no-store, must-revalidate" always; try_files $uri =404; }
    location ^~ /assets/ { add_header X-Content-Type-Options "nosniff" always; add_header Referrer-Policy "strict-origin-when-cross-origin" always; add_header Content-Security-Policy "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'self' https:; media-src 'self' https: data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' https:" always; expires 1y; add_header Cache-Control "public, max-age=31536000, immutable" always; try_files $uri =404; }
    location = /version.json { add_header X-Content-Type-Options "nosniff" always; add_header Referrer-Policy "strict-origin-when-cross-origin" always; add_header Content-Security-Policy "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'self' https:; media-src 'self' https: data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' https:" always; add_header Cache-Control "no-cache, no-store, must-revalidate" always; try_files $uri =404; }
    location / { try_files $uri $uri/ /index.html; }
}
NGINX
LABEL org.opencontainers.image.version="v2"
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
