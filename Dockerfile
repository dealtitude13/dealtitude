# Dealtitude API.
#
# Pinned to a digest-free but exact minor so a rebuild six months from now is
# the same Node that was tested, not whatever "20" means by then.
FROM node:22.11-alpine

WORKDIR /app

# Dependencies in their own layer: a code change shouldn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY db ./db
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8787

# The schema is idempotent — every statement is "if not exists" or "or replace"
# — so applying it on each boot is safe and means a deploy can never run code
# against a database that is a version behind it.
CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]
