FROM node:20-alpine

# Install dependencies required by the 'canvas' package to compile on Alpine
RUN apk add --no-cache python3 py3-setuptools build-base

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

# Expose the application port
EXPOSE 3000

CMD ["npm", "start"]
