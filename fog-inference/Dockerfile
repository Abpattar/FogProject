FROM ultralytics/ultralytics:latest
RUN pip install --no-cache-dir fastapi uvicorn python-multipart
WORKDIR /app
COPY fog_inference.py .
CMD ["uvicorn", "fog_inference:app", "--host", "0.0.0.0", "--port", "3000"]