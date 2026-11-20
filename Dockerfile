# PAIGE Cloud — nonproduction preview of the existing Vite+React frontend.
# Build:  docker build -t paige-cloud-preview .
# Run:    docker run --rm -p 8080:80 paige-cloud-preview
#
# This image contains only the static frontend build. It does NOT change
# PAIGE's live Vercel deployment, Supabase data, or credentials.

# ---- Stage 1: build ----
FROM oven/bun:1.2-alpine AS build
WORKDIR /app

# Reproducible install from lockfile
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Source
COPY . .

# Build the multi-entry Vite bundle (index, privacy, sms-terms, auth)
RUN bun run build

# ---- Stage 2: serve ----
FROM nginx:1.27-alpine AS serve

# Remove default site
RUN rm -f /etc/nginx/conf.d/default.conf

COPY docker/nginx.conf /etc/nginx/conf.d/paige.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
