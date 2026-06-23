FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
ENV MATH_ENGINE_API__HOST=0.0.0.0
ENV MATH_ENGINE_API__PORT=8080
CMD ["python", "apps/api-server/main.py"]
