# AMD-PWA-01: two stages — build the zero-dependency ESM bundle with tsc,
# serve it with nginx. No npm runtime dependencies exist to admit.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npx tsc -p tsconfig.build.json

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
COPY --from=build /app/dist /usr/share/nginx/html/dist
EXPOSE 8080
