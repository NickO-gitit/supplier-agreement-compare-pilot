FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Ensure the frontend is built to call in-container API endpoints.
ENV VITE_RISK_API_URL=/api/analyze-risk
ENV VITE_GROUPING_REVIEW_API_URL=/api/review-grouping
ENV VITE_RISK_FOLLOWUP_API_URL=/api/risk-followup

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/api ./api

EXPOSE 3000

CMD ["npm", "run", "start"]
