"""Run the standalone shop API from any working directory."""
from pathlib import Path
import os
import uvicorn

if __name__ == '__main__':
    os.chdir(Path(__file__).resolve().parent)
    uvicorn.run('app.shop:app', host='127.0.0.1', port=8001, access_log=False)
