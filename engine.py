"""Deterministic, synthetic satellite operations laboratory. No command uplink."""
from functools import lru_cache
import math
import numpy as np
from sklearn.ensemble import IsolationForest

EARTH_KM = 6378.137
MU = 398600.4418
ROTATION = 7.2921150e-5
FIELDS = ['battery', 'temperature', 'cpu', 'pointing', 'packet_loss', 'wheel']
LABELS = ['배터리 잔량', '탑재체 온도', 'CPU 사용률', '지향 오차', '패킷 손실', '반작용휠 속도']
UNITS = ['%', '°C', '%', '°', '%', 'rpm']
STATIONS = [
    {'name': '대전', 'lat': 36.35, 'lon': 127.38},
    {'name': '아부다비', 'lat': 24.45, 'lon': 54.38},
    {'name': '싱가포르', 'lat': 1.35, 'lon': 103.82},
]
FAULTS = {
    'battery': {'name': '배터리 저하', 'action': 'power_save'},
    'thermal': {'name': '탑재체 과열', 'action': 'payload_throttle'},
    'attitude': {'name': '자세 불안정', 'action': 'attitude_reset'},
    'link': {'name': '통신 품질 저하', 'action': 'link_switch'},
    'cpu': {'name': '탑재컴퓨터 과부하', 'action': 'computer_restart'},
}
ACTIONS = {
    'power_save': {'name': '절전 모드', 'effect': '소비전력을 줄여 배터리 저하를 완화합니다.', 'tradeoff': '모의 처리용량 35% 감소'},
    'payload_throttle': {'name': '탑재체 부하 축소', 'effect': '발열원을 줄여 과열을 완화합니다.', 'tradeoff': '모의 처리용량 25% 감소'},
    'attitude_reset': {'name': '자세제어 재초기화', 'effect': '지향 오차와 휠 속도 편차를 완화합니다.', 'tradeoff': '초기 60초간 서비스 중단'},
    'link_switch': {'name': '예비 통신계 전환', 'effect': '예비 경로로 패킷 손실을 완화합니다.', 'tradeoff': '모의 처리용량 10% 감소'},
    'computer_restart': {'name': '탑재컴퓨터 재시작', 'effect': '과부하를 해소한 뒤 처리를 재개합니다.', 'tradeoff': '초기 90초간 서비스 중단'},
}


def normal_values(phase, noise):
    """Training and simulation share the same synthetic nominal distribution."""
    return np.column_stack([
        78 + 9*np.sin(phase) + noise[:, 0]*1.0,
        31 + 6*np.sin(phase - .6) + noise[:, 1]*.65,
        38 + 9*np.cos(phase) + noise[:, 2]*1.8,
        .09 + .02*np.sin(phase) + noise[:, 3]*.008,
        .45 + .15*np.cos(phase) + noise[:, 4]*.065,
        2300 + 300*np.sin(phase + .5) + noise[:, 5]*55,
    ])


@lru_cache(maxsize=1)
def detector():
    """Fit once, only on nominal synthetic data; no injected-fault labels used."""
    rng = np.random.default_rng(4815)
    train = normal_values(rng.uniform(0, 2*np.pi, 6000), rng.normal(size=(6000, 6)))
    model = IsolationForest(n_estimators=80, max_samples=256, contamination=.005,
                            random_state=41, n_jobs=1).fit(train)
    calibration = normal_values(rng.uniform(0, 2*np.pi, 4000), rng.normal(size=(4000, 6)))
    raw = -model.score_samples(calibration)
    q0, q50, q95, q995 = np.quantile(raw, [0, .5, .95, .995])
    anchors = np.array([q0, q50, q95, q995, q995 + 2*(q995-q95)])
    return model, anchors, train.mean(axis=0), train.std(axis=0)


def infer(values):
    model, anchors, mean, sd = detector()
    risk = np.interp(-model.score_samples(values), anchors, [0, 15, 40, 70, 100])
    z = np.abs((values-mean)/sd)
    return risk, z


def geometry(cfg, elapsed, indices=None):
    n = cfg.planes * cfg.per_plane
    ids = np.arange(n) if indices is None else np.asarray(indices)
    plane, slot = ids // cfg.per_plane, ids % cfg.per_plane
    r = EARTH_KM + cfg.altitude
    period = 2*np.pi*math.sqrt(r**3/MU)
    # Walker Delta T/P/F: phase between adjacent planes = F * 360 / T.
    raan = 2*np.pi*plane/cfg.planes
    u = 2*np.pi*slot/cfg.per_plane + 2*np.pi*cfg.phasing*plane/n + 2*np.pi*elapsed/period
    inc = math.radians(cfg.inclination)
    x = r*(np.cos(raan)*np.cos(u)-np.sin(raan)*np.sin(u)*math.cos(inc))
    y = r*(np.sin(raan)*np.cos(u)+np.cos(raan)*np.sin(u)*math.cos(inc))
    z = r*np.sin(u)*math.sin(inc)
    # Arbitrary reproducible epoch; simplified Earth rotation, no TLE/SGP4/J2.
    theta = ROTATION*elapsed
    ecef = np.column_stack([x*np.cos(theta)+y*np.sin(theta), -x*np.sin(theta)+y*np.cos(theta), z])
    lat = np.degrees(np.arcsin(ecef[:, 2]/r))
    lon = np.degrees(np.arctan2(ecef[:, 1], ecef[:, 0]))
    elevations = []
    for site in STATIONS:
        a, b = math.radians(site['lat']), math.radians(site['lon'])
        up = np.array([math.cos(a)*math.cos(b), math.cos(a)*math.sin(b), math.sin(a)])
        los = ecef - EARTH_KM*up
        elevations.append(np.degrees(np.arcsin(np.clip(los@up/np.linalg.norm(los, axis=1), -1, 1))))
    return lat, lon, np.array(elevations).T, u, period


def telemetry(req, elapsed, indices=None, apply_actions=True):
    n = req.config.planes*req.config.per_plane
    ids = np.arange(n) if indices is None else np.asarray(indices)
    _, _, _, phase, _ = geometry(req.config, elapsed, ids)
    # Time-bin seeding makes exports, replays and branches exactly comparable.
    rng = np.random.default_rng(np.random.SeedSequence([req.seed, int(elapsed//10)]))
    noise = rng.normal(size=(n, 6))[ids]
    v = normal_values(phase, noise)
    capacity = np.ones(len(ids))
    for f in req.faults:
        if elapsed < f.at:
            continue
        where = np.flatnonzero(ids == f.satellite)
        if not len(where):
            continue
        j = where[0]
        age = elapsed-f.at
        severity = f.severity*(.45+.55*(1-math.exp(-age/160)))
        mitigation = 1.0
        matches = [a for a in req.actions if a.fault_id == f.id and a.at <= elapsed]
        if apply_actions and matches:
            # Validation permits one matching action per fault; no stacking bonuses.
            a = matches[0]
            after = elapsed-a.at
            mitigation = .01 + .99*math.exp(-after/90)
            if a.kind == 'power_save':
                capacity[j] *= .65
            elif a.kind == 'payload_throttle':
                capacity[j] *= .75
            elif a.kind == 'link_switch':
                capacity[j] *= .9
            elif a.kind == 'attitude_reset' and after < 60:
                capacity[j] = 0
            elif a.kind == 'computer_restart' and after < 90:
                capacity[j] = 0
        k = severity*mitigation
        delta = {'battery': [-65, 0, 0, 0, 0, 0],
                 'thermal': [0, 52, 13, 0, 0, 0],
                 'attitude': [0, 0, 0, 1.8, 3, 3600],
                 'link': [0, 0, 0, 0, 28, 0],
                 'cpu': [0, 10, 62, 0, 8, 0]}[f.kind]
        v[j] += np.array(delta)*k
    v[:, 0] = np.clip(v[:, 0], 0, 100)
    v[:, 2] = np.clip(v[:, 2], 0, 100)
    v[:, 3:] = np.maximum(v[:, 3:], 0)
    v[:, 4] = np.minimum(v[:, 4], 100)
    # Illustrative service proxy; not a physical capacity or link-budget model.
    capacity *= np.clip(1-v[:, 4]/35, 0, 1)
    capacity *= np.where((v[:, 0]<20)|(v[:, 1]>78)|(v[:, 3]>1.4)|(v[:, 2]>98), 0, 1)
    return v, capacity


def diagnose(v, risk):
    """Rule explanations depend on telemetry, never on injected fault metadata."""
    alerts = []
    checks = [
        (v[0]<55, 'battery', f'배터리 {v[0]:.1f}% < 55%', v[0]<25),
        (v[1]>48, 'thermal', f'탑재체 온도 {v[1]:.1f}°C > 48°C', v[1]>70),
        (v[3]>.3, 'attitude', f'지향 오차 {v[3]:.2f}° > 0.30°', v[3]>1.0),
        (v[4]>4, 'link', f'패킷 손실 {v[4]:.1f}% > 4%', v[4]>20),
        (v[2]>75, 'cpu', f'CPU 사용률 {v[2]:.1f}% > 75%', v[2]>95),
    ]
    for triggered, kind, evidence, critical in checks:
        if triggered:
            alerts.append({'kind':kind, 'evidence':evidence, 'action':FAULTS[kind]['action'], 'critical':bool(critical)})
    status = 'critical' if any(a['critical'] for a in alerts) else 'warning' if alerts or risk >= 70 else 'normal'
    if not alerts and risk >= 70:
        alerts.append({'kind':'unknown','evidence':'정상 학습분포에서 벗어난 복합 패턴', 'action':None, 'critical':False})
    return status, alerts


def snapshot(req):
    cfg, t = req.config, req.elapsed
    lat, lon, elev, _, period = geometry(cfg, t)
    values, cap = telemetry(req, t)
    risk, z = infer(values)
    statuses, diagnoses = zip(*(diagnose(v, r) for v, r in zip(values, risk)))
    sats = []
    for i, v in enumerate(values):
        sats.append({'id':i, 'name':f'K-LEO {i+1:03d}', 'plane':i//cfg.per_plane+1,
                     'lat':round(float(lat[i]),3), 'lon':round(float(lon[i]),3),
                     'status':statuses[i], 'risk':round(float(risk[i]),1),
                     'telemetry':{k:round(float(x),3) for k,x in zip(FIELDS,v)},
                     'capacity':round(float(cap[i])*100,1),
                     'elevation':round(float(elev[i,0]),1),
                     'visible':bool(elev[i,0]>=cfg.min_elevation), 'alerts':diagnoses[i]})
    chosen = req.selected
    times = np.arange(max(0, t-1200), t+.01, 30)
    if len(times)==0 or times[-1] != t:
        times = np.append(times, t)
    actual, counter, actual_cap, counter_cap = [], [], [], []
    for when in times:
        a, ca = telemetry(req, float(when), [chosen])
        b, cb = telemetry(req, float(when), [chosen], apply_actions=False)
        actual.append(a[0]); counter.append(b[0]); actual_cap.append(ca[0]); counter_cap.append(cb[0])
    a_risk, _ = infer(np.array(actual))
    b_risk, _ = infer(np.array(counter))
    history = [{'time':round(float(tm),1), 'values':{k:round(float(x),3) for k,x in zip(FIELDS,a)},
                'unmitigated':{k:round(float(x),3) for k,x in zip(FIELDS,b)},
                'risk':round(float(ar),1), 'unmitigated_risk':round(float(br),1),
                'capacity':round(float(ac)*100,1), 'unmitigated_capacity':round(float(bc)*100,1)}
               for tm,a,b,ar,br,ac,bc in zip(times,actual,counter,a_risk,b_risk,actual_cap,counter_cap)]
    top = np.argsort(z[chosen])[::-1][:3]
    contributors = [{'field':FIELDS[j], 'label':LABELS[j], 'deviation':round(float(z[chosen,j]),1)} for j in top]
    stations = [{**site,'visible':int(np.sum(elev[:,j]>=cfg.min_elevation)),
                 'serviceable':int(np.sum((elev[:,j]>=cfg.min_elevation)&(cap>=.5)))} for j,site in enumerate(STATIONS)]
    tracks=[]
    for dt in np.linspace(0, period, 97):
        a,b,_,_,_=geometry(cfg,t+float(dt),[chosen])
        tracks.append([round(float(a[0]),3),round(float(b[0]),3)])
    return {'elapsed':t,'satellites':sats,'selected':sats[chosen],'history':history,
            'contributors':contributors, 'stations':stations, 'track':tracks,
            'summary':{'total':len(sats),'normal':statuses.count('normal'),
                       'warning':statuses.count('warning'),'critical':statuses.count('critical'),
                       'mean_capacity':round(float(np.mean(cap))*100,1),'period_minutes':round(period/60,2)},
            'model':{'name':'Isolation Forest','training_samples':6000,'risk_threshold':70,
                     'note':'합성 정상 데이터 기반 상대 이상지수. 고장 확률이 아닙니다.'}}
