FROM node:20-alpine

# Install dependencies required by the 'canvas' package to compile on Alpine
RUN apk add --no-cache \
    build-base \
    g++ \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    python3 \
    py3-setuptools

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

# Expose the application port
EXPOSE 3000

CMD ["npm", "start"]
