import copy
import csv
import io
import math
import numpy as np
import pytest
from fastapi.testclient import TestClient
from engine import EARTH_KM, MU, ROTATION, FAULTS, geometry, snapshot
from main import app, Configuration, SimulationRequest


@pytest.fixture(scope='module')
def client():
    with TestClient(app) as c:
        yield c


def test_health_and_interface(client):
    assert client.get('/healthz').json()['mode']=='simulation'
    assert client.get('/').status_code==200
    assert 'AI 위성 관제 실험실' in client.get('/').text
    assert client.get('/static/app.js').status_code==200


def test_orbit_against_analytic_equatorial_case():
    cfg=Configuration(altitude=500,inclination=0,planes=1,per_plane=1,phasing=0)
    lat,lon,_,_,period=geometry(cfg,0)
    assert abs(lat[0])<1e-10 and abs(lon[0])<1e-10
    expected_period=2*math.pi*math.sqrt((EARTH_KM+500)**3/MU)
    assert period==pytest.approx(expected_period)
    lat,lon,_,_,_=geometry(cfg,period/4)
    assert lon[0]==pytest.approx(90-math.degrees(ROTATION*period/4))


@pytest.mark.parametrize('altitude',[500,888,1280])
@pytest.mark.parametrize('planes,per_plane',[(4,16),(8,16),(16,32)])
def test_geometry_and_csv_are_consistent(client,altitude,planes,per_plane):
    payload={'config':{'altitude':altitude,'inclination':42,'planes':planes,'per_plane':per_plane,'phasing':1},'elapsed':7200,'selected':planes*per_plane-1}
    r=client.post('/api/simulate',json=payload);assert r.status_code==200
    data=r.json();assert len(data['satellites'])==planes*per_plane
    assert all(abs(s['lat'])<=42.001 for s in data['satellites'])
    assert data['stations'][0]['visible']==sum(s['visible'] for s in data['satellites'])
    text=client.post('/api/export',json=payload).content.decode('utf-8-sig')
    rows=list(csv.DictReader(io.StringIO(text)))
    assert len(rows)==planes*per_plane
    for row,sat in zip(rows,data['satellites']):
        assert float(row['temperature_c'])==sat['telemetry']['temperature']
        assert float(row['anomaly_index'])==sat['risk']
        assert int(row['planes'])==planes
        assert float(row['altitude_km'])==altitude


@pytest.mark.parametrize('kind',list(FAULTS))
def test_injection_detection_and_counterfactual_recovery(kind):
    payload={'elapsed':600,'faults':[{'id':'f1','satellite':0,'kind':kind,'at':180,'severity':1}]}
    before=snapshot(SimulationRequest(**payload))
    assert before['selected']['status']!='normal'
    assert any(a['kind']==kind for a in before['selected']['alerts'])
    payload.update(elapsed=1500,actions=[{'fault_id':'f1','kind':FAULTS[kind]['action'],'at':600}])
    after=snapshot(SimulationRequest(**payload))
    assert after['selected']['status']=='normal'
    field={'battery':'battery','thermal':'temperature','attitude':'pointing','link':'packet_loss','cpu':'cpu'}[kind]
    last=after['history'][-1]
    if kind=='battery':assert last['values'][field]>last['unmitigated'][field]
    else:assert last['values'][field]<last['unmitigated'][field]


def test_replay_and_session_isolation(client):
    payload={'elapsed':3600,'seed':117,'selected':4,'faults':[{'id':'f1','satellite':4,'kind':'link','at':300}]}
    first=client.post('/api/simulate',json=payload).json()
    nominal=client.post('/api/simulate',json={'elapsed':3600,'seed':117,'selected':4}).json()
    second=client.post('/api/simulate',json=copy.deepcopy(payload)).json()
    assert first==second
    assert nominal['selected']['telemetry']['packet_loss']<first['selected']['telemetry']['packet_loss']
    assert first['satellites'][3]==nominal['satellites'][3]


@pytest.mark.parametrize('payload',[
    {'config':{'planes':32,'per_plane':64}},
    {'config':{'planes':1,'phasing':1}},
    {'config':{'inclination':99}},
    {'selected':500},
    {'elapsed':-1},
    {'faults':[{'id':'f1','satellite':0,'kind':'bad','at':0}]},
    {'actions':[{'fault_id':'missing','kind':'link_switch','at':0}]},
    {'config':{'planes':2,'per_plane':4,'unexpected':1}},
])
def test_invalid_requests(client,payload):
    assert client.post('/api/simulate',json=payload).status_code==422


def test_action_timing_matching_and_duplicates(client):
    f={'id':'f1','satellite':0,'kind':'thermal','at':100}
    a={'fault_id':'f1','kind':'payload_throttle','at':200}
    for actions in [[dict(a,at=99)],[dict(a,kind='power_save')],[a,a]]:
        assert client.post('/api/simulate',json={'faults':[f],'actions':actions}).status_code==422


def test_restart_has_temporary_service_cost():
    p={'faults':[{'id':'f1','satellite':0,'kind':'cpu','at':0}],
       'actions':[{'fault_id':'f1','kind':'computer_restart','at':600}]}
    assert snapshot(SimulationRequest(elapsed=630,**p))['selected']['capacity']==0
    assert snapshot(SimulationRequest(elapsed=1500,**p))['selected']['capacity']>90


def test_nominal_false_alerts_are_not_hidden():
    result=snapshot(SimulationRequest(elapsed=1800,seed=7))
    assert result['summary']['normal']>120
    assert all(s['status']=='normal' or s['alerts'] for s in result['satellites'])
