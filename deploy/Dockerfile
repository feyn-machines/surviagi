# The application is built on the release machine; this image only runs it.
FROM node:22-alpine
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --chown=node:node app/ ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
