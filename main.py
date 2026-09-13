"""Render entry point: uvicorn main:app --host 0.0.0.0 --port $PORT."""
from contextlib import asynccontextmanager
import csv
import io
import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, model_validator
from engine import ACTIONS, FAULTS, FIELDS, detector, snapshot

BASE = Path(__file__).resolve().parent


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Configuration(StrictModel):
    altitude: float = Field(1280, ge=300, le=2000)
    inclination: float = Field(42, ge=0, le=98)
    planes: int = Field(8, ge=1, le=32)
    per_plane: int = Field(16, ge=1, le=64)
    phasing: int = Field(1, ge=0, le=31)
    min_elevation: float = Field(10, ge=0, le=60)

    @model_validator(mode='after')
    def constellation(self):
        if self.planes*self.per_plane > 512:
            raise ValueError('총 위성 수는 512기 이하여야 합니다.')
        if self.phasing >= self.planes:
            raise ValueError('Walker F는 궤도면 수보다 작아야 합니다.')
        return self


class Fault(StrictModel):
    id: str = Field(min_length=1, max_length=64, pattern=r'^[a-zA-Z0-9_-]+$')
    satellite: int = Field(ge=0, le=511)
    kind: Literal['battery','thermal','attitude','link','cpu']
    at: float = Field(ge=0, le=86400)
    severity: float = Field(1, ge=.2, le=1)


class Action(StrictModel):
    fault_id: str
    kind: Literal['power_save','payload_throttle','attitude_reset','link_switch','computer_restart']
    at: float = Field(ge=0, le=86400)


class SimulationRequest(StrictModel):
    config: Configuration = Field(default_factory=Configuration)
    elapsed: float = Field(0, ge=0, le=86400)
    seed: int = Field(42, ge=0, le=2147483647)
    selected: int = Field(0, ge=0, le=511)
    faults: list[Fault] = Field(default_factory=list, max_length=64)
    actions: list[Action] = Field(default_factory=list, max_length=64)

    @model_validator(mode='after')
    def references(self):
        n = self.config.planes*self.config.per_plane
        if self.selected >= n or any(f.satellite >= n for f in self.faults):
            raise ValueError('선택 위성이 현재 위성군 범위를 벗어났습니다.')
        indexed = {f.id:f for f in self.faults}
        if len(indexed) != len(self.faults):
            raise ValueError('중복 장애 ID입니다.')
        pairs = {(f.satellite,f.kind) for f in self.faults}
        if len(pairs) != len(self.faults):
            raise ValueError('같은 위성에 동일 장애를 중복 주입할 수 없습니다.')
        seen = set()
        for a in self.actions:
            f = indexed.get(a.fault_id)
            if f is None or a.at < f.at or a.kind != FAULTS[f.kind]['action']:
                raise ValueError('대응 명령과 장애 또는 실행 시각이 일치하지 않습니다.')
            if a.fault_id in seen:
                raise ValueError('장애별 대응은 한 번만 실행할 수 있습니다.')
            seen.add(a.fault_id)
        return self


@asynccontextmanager
async def lifespan(app):
    detector()
    yield


app = FastAPI(title='AI 위성 관제 실험실', version='1.0.0', lifespan=lifespan,
              docs_url=None, redoc_url=None)


@app.middleware('http')
async def bounds(request: Request, call_next):
    # Only numeric simulation input is accepted. Limit HTTP bodies before parsing.
    if request.method == 'POST':
        body = await request.body()
        if len(body) > 65536:
            return JSONResponse({'detail':'요청 크기 제한은 64 KB입니다.'},status_code=413)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
    return response


@app.get('/healthz')
def health():
    return {'status':'ok','mode':'simulation'}


@app.get('/')
def index():
    return FileResponse(BASE/'static'/'index.html')


@app.get('/api/catalog')
def catalog():
    return {'faults':FAULTS,'actions':ACTIONS}


@app.post('/api/simulate')
def simulate(req: SimulationRequest):
    return snapshot(req)


@app.post('/api/export')
def export(req: SimulationRequest):
    data = snapshot(req)
    s = io.StringIO(newline='')
    w = csv.writer(s)
    w.writerow(['satellite','elapsed_s','altitude_km','inclination_deg','planes','per_plane','walker_f',
                'min_elevation_deg','seed','lat_deg','lon_deg','status','anomaly_index',
                'battery_pct','temperature_c','cpu_pct','pointing_deg','packet_loss_pct','wheel_rpm',
                'capacity_proxy_pct','daejeon_elevation_deg','daejeon_visible'])
    c = req.config
    for sat in data['satellites']:
        w.writerow([sat['name'],req.elapsed,c.altitude,c.inclination,c.planes,c.per_plane,c.phasing,
                    c.min_elevation,req.seed,sat['lat'],sat['lon'],sat['status'],sat['risk'],
                    *[sat['telemetry'][k] for k in FIELDS],sat['capacity'],sat['elevation'],sat['visible']])
    return Response(s.getvalue().encode('utf-8-sig'),media_type='text/csv',
                    headers={'Content-Disposition':'attachment; filename="satellite-telemetry.csv"'})


app.mount('/static', StaticFiles(directory=BASE/'static'), name='static')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('main:app',host='0.0.0.0',port=int(os.getenv('PORT','8000')))
