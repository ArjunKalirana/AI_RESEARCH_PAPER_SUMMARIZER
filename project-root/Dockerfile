FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

# Expose the application port
EXPOSE 3000

CMD ["npm", "start"]
