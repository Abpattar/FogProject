FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY app.js .
COPY public ./public
CMD ["node", "app.js"]
