FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY index.html style.css widget.js server.js ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.js"]
