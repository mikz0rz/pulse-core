FROM node:20-bookworm-slim

# git resolves the github: pulse-core dependency; the rest are the headless-
# Chrome runtime libs Puppeteer needs for twitter_list and website_diff sources.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 xdg-utils wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/main.js"]
