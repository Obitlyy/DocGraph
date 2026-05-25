#!/bin/bash
cd "$(dirname "$0")/../.." && python -m uvicorn app_v2.backend.main:app --host 0.0.0.0 --port 8000
