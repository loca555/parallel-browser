FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R pwuser:pwuser /app
COPY --chown=pwuser:pwuser . .
USER pwuser
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
CMD ["node", "server.mjs"]
