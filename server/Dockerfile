FROM node:20-bullseye-slim

RUN set -eux; \
    echo 'Acquire::Retries "6";' > /etc/apt/apt.conf.d/80-retries; \
    echo 'Acquire::http::Timeout "30";' >> /etc/apt/apt.conf.d/80-retries; \
    for i in 1 2 3 4 5; do \
        apt-get update && \
        apt-get install -y --no-install-recommends --fix-missing python3 make g++ && \
        break || { echo "Tentative $i echouee, nouvelle tentative dans 10s..."; sleep 10; }; \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    command -v g++ >/dev/null && command -v make >/dev/null && command -v python3 >/dev/null \
      || { echo "ERREUR: outils de compilation absents apres 5 tentatives"; exit 1; }

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
