# The base image already carries the Apify SDK, so the build needs no npm install.
FROM apify/actor-node:24

COPY --chown=myuser:myuser . ./

CMD ["node", "src/main.js"]
