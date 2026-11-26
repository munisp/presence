# AMD-KYC-06: reference mode ships stdlib-only; the real engines
# (paddleocr, docling, a VLM stack) install in the deployment overlay
# that flips OPENKYC_ENGINES=real — see README.md.
FROM python:3.12-slim

WORKDIR /app
COPY openkyc /app/openkyc

ENV OPENKYC_ENGINES=reference \
    OPENKYC_PORT=4200

EXPOSE 4200
CMD ["python", "-m", "openkyc.server"]
