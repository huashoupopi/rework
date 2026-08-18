# ── Frontend Dockerfile (Build + Nginx) ──
FROM node:20-alpine AS builder

# npm/pnpm 淘宝镜像加速
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --registry https://registry.npmmirror.com

COPY . .
RUN pnpm build

# ── 生产阶段：Nginx 静态服务 ──
FROM nginx:alpine

# 清除默认配置
RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
