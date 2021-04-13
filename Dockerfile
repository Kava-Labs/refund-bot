FROM node:12

WORKDIR /app

COPY package.json .
COPY index.js index.js
COPY scripts scripts
COPY refund refund
COPY yarn.lock yarn.lock

RUN yarn

CMD ["node", "./scripts/start.js"]
