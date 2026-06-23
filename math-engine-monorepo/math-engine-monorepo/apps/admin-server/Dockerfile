FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8081
ENV MATH_ENGINE_ADMIN__HOST=0.0.0.0
ENV MATH_ENGINE_ADMIN__PORT=8081
CMD ["python", "apps/admin-server/main.py"]
