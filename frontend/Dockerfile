FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
# Build with the runtime VITE_API_URL baked in, then serve the static dist via
# vite preview (no dev server, no HMR, no source exposure, no error overlay).
CMD ["sh", "-c", "npm run build && npm run preview -- --host 0.0.0.0 --port 3000"]
