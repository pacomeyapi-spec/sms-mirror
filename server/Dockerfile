FROM node:20-bullseye

# Image complète : gcc, g++, make et les en-têtes de compilation sont DÉJÀ inclus.
# Plus aucun téléchargement Debian n'est nécessaire pour construire l'image
# (les miroirs deb.debian.org tombent en panne et bloquaient tout déploiement).
# python3 n'est utile qu'à une compilation depuis les sources : on tente de
# l'installer, mais SANS JAMAIS faire échouer le build s'il est indisponible.
RUN (apt-get update && apt-get install -y --no-install-recommends python3 \
     && rm -rf /var/lib/apt/lists/*) \
    || echo "python3 non installe — poursuite avec les binaires precompiles"

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
