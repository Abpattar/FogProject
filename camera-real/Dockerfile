FROM node:22-alpine
RUN apk add --no-cache ffmpeg v4l-utils
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY camera-real.js .
CMD ["node", "camera-real.js"]